const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const ip = require('ip');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const multer = require('multer');
require('dotenv').config(); // Load environment variables

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL;

// Get server URL
let cachedServerUrl = null;
const getServerUrl = () => {
  if (cachedServerUrl) return cachedServerUrl;

  if (process.env.NODE_ENV === 'production') {
    cachedServerUrl = 'https://heksta-backend.onrender.com';
  } else {
    cachedServerUrl = `http://${getLocalIP()}:${PORT}`;
  }
  return cachedServerUrl;
};

// Store active sessions
const sessions = new Map();
const downloadStats = new Map();

const cors = require('cors');

// Middleware
app.use(express.json());

// CORS Configuration
app.use(cors({
  origin: CLIENT_URL || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept']
}));

// Get local IP
const getLocalIP = () => {
  return ip.address();
};

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
      files: [],
      createdAt: Date.now(),
      active: true,
      connectedClients: 0
    };

    sessions.set(sessionId, session);

    // Frontend URL for joining
    const frontendBaseUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const joinLink = `${frontendBaseUrl}/join/${sessionId}`;

    console.log(`Created session ${sessionId} for ${senderName}`);
    console.log(`Join link: ${joinLink}`);

    res.json({
      sessionId,
      joinLink,
      serverUrl: getServerUrl()
    });
  } catch (error) {
    console.error('Session creation error:', error);
    res.status(500).json({ error: 'Failed to create session: ' + error.message });
  }
});

// Upload files to session
app.post('/api/upload/:sessionId', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  if (!session.active) {
    return res.status(400).json({ error: 'Session is not active' });
  }

  // Handle file upload
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const sid = req.params.sessionId;
        const dir = path.join(__dirname, 'uploads', sid);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
      }
    }),
    limits: {
      fileSize: 10 * 1024 * 1024 * 1024 // 10GB limit
    }
  }).array('files');

  upload(req, res, (err) => {
    if (err) {
      console.error('Upload error:', err);
      return res.status(500).json({ error: 'Upload failed: ' + err.message });
    }

    // Check if files were uploaded
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const files = req.files.map(file => ({
      id: uuidv4(),
      originalName: file.originalname,
      filename: file.filename,
      path: file.path,
      size: file.size,
      mimetype: file.mimetype,
      uploadedAt: Date.now()
    }));

    session.files = [...session.files, ...files];
    sessions.set(sessionId, session);

    console.log(`Uploaded ${files.length} files to session ${sessionId}`);

    // Notify connected clients
    broadcastToSession(sessionId, {
      type: 'files_updated',
      files: session.files.map(f => ({
        id: f.id,
        name: f.originalName,
        size: f.size,
        type: f.mimetype
      }))
    });

    res.json({
      message: 'Files uploaded successfully',
      files: files.map(f => ({
        id: f.id,
        name: f.originalName,
        size: f.size
      }))
    });
  });
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
    fileCount: session.files.length,
    connectedClients: session.connectedClients,
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

// Get files list
app.get('/api/session/:sessionId/files', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    files: session.files.map(file => ({
      id: file.id,
      name: file.originalName,
      size: file.size,
      type: file.mimetype
    }))
  });
});

// Stream file download
app.get('/api/download/:sessionId/:fileId', (req, res) => {
  const { sessionId, fileId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    console.log(`Download failed: Session ${sessionId} not found`);
    return res.status(404).json({ error: 'Session not found' });
  }

  const file = session.files.find(f => f.id === fileId);
  if (!file) {
    console.log(`Download failed: File ${fileId} not found in session ${sessionId}`);
    return res.status(404).json({ error: 'File not found' });
  }

  const filePath = file.path;

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    console.log(`Download failed: File ${filePath} not found on server`);
    trackDownloadFailure(sessionId, fileId, 'File not found on server');
    return res.status(404).json({ error: 'File not found on server' });
  }

  // Track download start
  const clientId = req.query.clientId || 'unknown';
  trackDownloadStart(sessionId, fileId, clientId);

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  console.log(`Starting download: ${file.originalName} (${fileSize} bytes) for client ${clientId}`);

  // Handle cleanup on response finish
  const cleanup = () => {
    trackDownloadComplete(sessionId, fileId);
  };

  const handleError = (error) => {
    console.error(`Download error for ${fileId}:`, error);
    trackDownloadFailure(sessionId, fileId, error.message || 'Unknown error');
  };

  res.on('finish', cleanup);
  res.on('error', handleError);

  if (range) {
    // Handle range requests for resume support
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;

    const fileStream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': file.mimetype || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalName)}"`
    });

    fileStream.pipe(res);
    fileStream.on('error', handleError);
  } else {
    // Full file download
    const fileStream = fs.createReadStream(filePath);

    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': file.mimetype || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalName)}"`
    });

    fileStream.pipe(res);
    fileStream.on('error', handleError);
  }
});

// Close session
app.post('/api/session/:sessionId/close', (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  session.active = false;
  sessions.set(sessionId, session);

  // Clean up files
  const uploadDir = path.join(__dirname, 'uploads', sessionId);
  if (fs.existsSync(uploadDir)) {
    fs.rmSync(uploadDir, { recursive: true, force: true });
  }

  // Notify clients
  broadcastToSession(sessionId, {
    type: 'session_closed'
  });

  res.json({ message: 'Session closed successfully' });
});

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
  session.connectedClients += 1;
  sessions.set(sessionId, session);

  ws.sessionId = sessionId;
  ws.clientId = clientId;

  // Send current session info
  ws.send(JSON.stringify({
    type: 'connected',
    clientId,
    sessionInfo: {
      sessionId: session.id,
      senderName: session.senderName,
      fileCount: session.files.length,
      connectedClients: session.connectedClients
    }
  }));

  // Notify sender of new connection
  broadcastToSession(sessionId, {
    type: 'client_connected',
    clientId,
    connectedClients: session.connectedClients
  });

  ws.on('close', () => {
    const session = sessions.get(sessionId);
    if (session) {
      session.connectedClients = Math.max(0, session.connectedClients - 1);
      sessions.set(sessionId, session);

      broadcastToSession(sessionId, {
        type: 'client_disconnected',
        clientId,
        connectedClients: session.connectedClients
      });
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Broadcast message to all clients in a session
function broadcastToSession(sessionId, message) {
  wss.clients.forEach(client => {
    if (client.sessionId === sessionId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Track download statistics
function trackDownloadStart(sessionId, fileId, clientId) {
  const key = `${sessionId}-${fileId}`;
  if (!downloadStats.has(key)) {
    downloadStats.set(key, {
      sessionId,
      fileId,
      started: 0,
      completed: 0,
      failed: 0,
      active: 0
    });
  }

  const stats = downloadStats.get(key);
  stats.started++;
  stats.active++;
  downloadStats.set(key, stats);

  console.log(`Download started: ${key} (Total started: ${stats.started})`);
}

function trackDownloadComplete(sessionId, fileId) {
  const key = `${sessionId}-${fileId}`;
  if (downloadStats.has(key)) {
    const stats = downloadStats.get(key);
    stats.completed++;
    stats.active = Math.max(0, stats.active - 1);
    downloadStats.set(key, stats);

    console.log(`Download completed: ${key} (Completed: ${stats.completed})`);

    // Broadcast updated stats to sender
    broadcastToSession(sessionId, {
      type: 'download_stats',
      fileId,
      stats
    });
  }
}

function trackDownloadFailure(sessionId, fileId, error) {
  const key = `${sessionId}-${fileId}`;
  if (downloadStats.has(key)) {
    const stats = downloadStats.get(key);
    stats.failed++;
    stats.active = Math.max(0, stats.active - 1);
    downloadStats.set(key, stats);

    console.log(`Download failed: ${key} (Failed: ${stats.failed}, Error: ${error})`);

    // Broadcast failure to sender
    broadcastToSession(sessionId, {
      type: 'download_failed',
      fileId,
      error,
      stats
    });
  }
}

// Global API Catch-all for 404
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

// Health check endpoint for UptimeRobot
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// Root route to confirm backend status - JSON RESPONSE ONLY
app.get('/', (req, res) => {
  res.json({ status: 'Heksta backend running 🚀' });
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Cleanup inactive sessions
setInterval(() => {
  const now = Date.now();
  sessions.forEach((session, sessionId) => {
    if (now - session.createdAt > 4 * 60 * 60 * 1000) { // 4 hours
      sessions.delete(sessionId);
      const uploadDir = path.join(__dirname, 'uploads', sessionId);
      if (fs.existsSync(uploadDir)) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      }
    }
  });
}, 30 * 60 * 1000); // Check every 30 minutes