const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  maxPayload: 1024 * 1024
});

const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL;

// Store active sessions
const sessions = new Map();

const cors = require('cors');

// Middleware
app.use(express.json());

// CORS Configuration
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl) or matching our patterns
    if (!origin || origin === CLIENT_URL || origin.includes('heksta') || origin.includes('onrender.com')) {
      callback(null, true);
    } else {
      callback(null, true); // Fallback to allow all in production if needed, or refine with: callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept']
}));

// Generate session ID
const generateSessionId = () => {
  return uuidv4().substring(0, 8);
};

// Create file session
app.post('/api/create-session', (req, res) => {
  try {
    const sessionId = generateSessionId();
    const { password = '', senderName = 'Anonymous' } = req.body;

    const session = {
      id: sessionId,
      password,
      senderName,
      createdAt: Date.now(),
      connectedClients: new Set()
    };

    sessions.set(sessionId, session);

    // Dynamic join link derivation
    const protocol = req.protocol;
    const host = req.get('host');
    const frontendBaseUrl = CLIENT_URL || `${protocol}://${host}`;
    const joinLink = `${frontendBaseUrl}/join/${sessionId}`;

    console.log(`Created signaling session ${sessionId} for ${senderName}`);

    res.json({
      sessionId,
      joinLink
    });
  } catch (error) {
    console.error('Session creation error:', error);
    res.status(500).json({ error: 'Failed to create session: ' + error.message });
  }
});

// Get session info
app.get('/api/session/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    sessionId: session.id,
    senderName: session.senderName,
    connectedClients: session.connectedClients.size,
    requiresPassword: !!session.password
  });
});

// Verify session password
app.post('/api/session/:sessionId/verify', (req, res) => {
  const sessionId = req.params.sessionId;
  const { password } = req.body;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (session.password && session.password !== password) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  res.json({ verified: true });
});

// Close session
app.post('/api/session/:sessionId/close', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  sessions.delete(sessionId);

  // Notify clients
  broadcastToSession(sessionId, {
    type: 'session_closed'
  });

  res.json({ message: 'Session closed successfully' });
});

// Serve frontend statically in production
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, '../frontend/dist');
  app.use(express.static(distPath));

  // Handle SPA routing
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  const clientId = uuidv4();

  if (!sessionId || !sessions.has(sessionId)) {
    ws.close(1008, 'Invalid session');
    return;
  }

  const session = sessions.get(sessionId);
  session.connectedClients.add(clientId);

  ws.sessionId = sessionId;
  ws.clientId = clientId;

  // Send current session info
  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    sessionInfo: {
      sessionId: session.id,
      senderName: session.senderName,
      connectedClients: session.connectedClients.size
    }
  }));

  // Notify others of new connection
  broadcastToSession(sessionId, {
    type: 'client_connected',
    clientId,
    connectedClients: session.connectedClients.size
  }, clientId);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      const allowedTypes = ['offer', 'answer', 'ice-candidate', 'file-metadata'];

      if (!allowedTypes.includes(data.type)) return;

      if (data.targetId) {
        sendToClient(data.targetId, {
          ...data,
          senderId: ws.clientId
        });
      } else {
        broadcastToSession(ws.sessionId, {
          ...data,
          senderId: ws.clientId
        }, ws.clientId);
      }
    } catch (e) {
      console.error('Invalid WS message:', e);
    }
  });

  ws.on('close', () => {
    const session = sessions.get(sessionId);
    if (session) {
      session.connectedClients.delete(clientId);

      broadcastToSession(sessionId, {
        type: 'client_disconnected',
        clientId,
        connectedClients: session.connectedClients.size
      });
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Send message to specific client
function sendToClient(targetId, message) {
  wss.clients.forEach(client => {
    if (client.clientId === targetId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Broadcast message to all clients in a session except sender
function broadcastToSession(sessionId, message, excludeClientId = null) {
  wss.clients.forEach(client => {
    if (client.sessionId === sessionId &&
      client.clientId !== excludeClientId &&
      client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Cleanup inactive sessions
setInterval(() => {
  const now = Date.now();
  sessions.forEach((session, sessionId) => {
    if (now - session.createdAt > 2 * 60 * 60 * 1000) { // 2 hours
      sessions.delete(sessionId);
    }
  });
}, 10 * 60 * 1000); // Check every 10 minutes

server.listen(PORT, () => {
  console.log(`Heksta Signaling Server running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
});
