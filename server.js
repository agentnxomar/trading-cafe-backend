const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

// ─── DATA ────────────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data', 'users.json');

function ensureData() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      nextId: 2,
      mode: 'DEMO',
      users: [{
        id: 1,
        username: 'admin',
        password: 'tradingcafe2026',
        name: 'Naning',
        role: 'admin',
        active: true,
        shares: 1,
        createdAt: new Date().toISOString()
      }]
    }, null, 2));
  }
}

function getData() {
  ensureData();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

// ─── SESSIONS ────────────────────────────────────────────────────────────────
const sessions = new Map();   // token -> { userId, name, role }
const online   = new Map();   // socketId -> userId

function genToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getOnlineIds() {
  return new Set(online.values());
}

function broadcastUsers() {
  const d   = getData();
  const ids = getOnlineIds();
  io.emit('users-updated', {
    mode: d.mode,
    users: d.users.map(u => ({
      id: u.id, name: u.name, username: u.username,
      role: u.role, active: u.active, shares: u.shares,
      online: ids.has(u.id)
    }))
  });
}

// ─── REST API ─────────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const d = getData();
  const user = d.users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });
  if (!user.active) return res.status(403).json({ error: 'Account deactivated — contact admin.' });
  const token = genToken();
  sessions.set(token, { userId: user.id, name: user.name, role: user.role });
  res.json({ token, user: { id: user.id, name: user.name, role: user.role } });
});

app.post('/api/verify', (req, res) => {
  const sess = sessions.get(req.body.token);
  if (!sess) return res.status(401).json({ error: 'Session expired' });
  const d = getData();
  const user = d.users.find(u => u.id === sess.userId);
  if (!user || !user.active) { sessions.delete(req.body.token); return res.status(403).json({ error: 'Deactivated' }); }
  res.json({ user: { id: user.id, name: user.name, role: user.role }, mode: d.mode });
});

function adminGuard(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const sess = sessions.get(token);
  if (!sess || sess.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  req.sess = sess;
  next();
}

app.get('/api/users', adminGuard, (req, res) => {
  const d = getData();
  const ids = getOnlineIds();
  res.json({
    mode: d.mode,
    users: d.users.map(u => ({
      id: u.id, name: u.name, username: u.username,
      role: u.role, active: u.active, shares: u.shares,
      online: ids.has(u.id)
    }))
  });
});

app.post('/api/users', adminGuard, (req, res) => {
  const { username, password, name, shares } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'All fields required' });
  const d = getData();
  if (d.users.find(u => u.username === username)) return res.status(400).json({ error: 'Username taken' });
  d.users.push({
    id: d.nextId++, username, password, name,
    role: 'viewer', active: true,
    shares: parseInt(shares) || 1,
    createdAt: new Date().toISOString()
  });
  saveData(d);
  broadcastUsers();
  res.json({ success: true });
});

app.patch('/api/users/:id/toggle', adminGuard, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === 1) return res.status(400).json({ error: 'Cannot modify admin' });
  const d = getData();
  const user = d.users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  user.active = !user.active;
  saveData(d);
  if (!user.active) {
    for (const [t, s] of sessions.entries()) if (s.userId === id) sessions.delete(t);
    for (const [sid, uid] of online.entries()) {
      if (uid === id) {
        const sock = io.sockets.sockets.get(sid);
        if (sock) sock.emit('force-logout', { message: 'Your account has been deactivated.' });
      }
    }
  }
  broadcastUsers();
  res.json({ success: true, active: user.active });
});

app.delete('/api/users/:id', adminGuard, (req, res) => {
  const id = parseInt(req.params.id);
  if (id === 1) return res.status(400).json({ error: 'Cannot delete admin' });
  const d = getData();
  d.users = d.users.filter(u => u.id !== id);
  saveData(d);
  broadcastUsers();
  res.json({ success: true });
});

app.post('/api/mode', adminGuard, (req, res) => {
  const d = getData();
  d.mode = d.mode === 'DEMO' ? 'REAL' : 'DEMO';
  saveData(d);
  io.emit('mode-changed', { mode: d.mode });
  res.json({ mode: d.mode });
});

// Health check (keeps Render awake with uptime pings)
app.get('/api/ping', (_, res) => res.json({ ok: true, ts: Date.now() }));

// ─── SOCKET.IO — WEBRTC SIGNALING ────────────────────────────────────────────
const broadcasters = new Map(); // boxId -> socketId

io.on('connection', socket => {

  socket.on('authenticate', ({ token }) => {
    const sess = sessions.get(token);
    if (!sess) { socket.emit('auth-error'); return; }
    const d = getData();
    const user = d.users.find(u => u.id === sess.userId);
    if (!user || !user.active) { socket.emit('auth-error'); return; }
    online.set(socket.id, sess.userId);
    socket.emit('authenticated', {
      mode: d.mode,
      liveBoxes: [...broadcasters.keys()]
    });
    broadcastUsers();
  });

  socket.on('broadcaster-start', ({ boxId, token }) => {
    const sess = sessions.get(token);
    if (!sess || sess.role !== 'admin') return;
    broadcasters.set(boxId, socket.id);
    io.emit('box-status', { boxId, live: true });
  });

  socket.on('broadcaster-stop', ({ boxId }) => {
    broadcasters.delete(boxId);
    io.emit('box-status', { boxId, live: false });
  });

  socket.on('watch-request', ({ boxId }) => {
    const bId = broadcasters.get(boxId);
    if (!bId) { socket.emit('box-unavailable', { boxId }); return; }
    io.to(bId).emit('viewer-wants-box', { viewerSocketId: socket.id, boxId });
  });

  socket.on('rtc-offer',  ({ to, boxId, offer })     => io.to(to).emit('rtc-offer',  { from: socket.id, boxId, offer }));
  socket.on('rtc-answer', ({ to, boxId, answer })    => io.to(to).emit('rtc-answer', { from: socket.id, boxId, answer }));
  socket.on('rtc-ice',    ({ to, boxId, candidate }) => io.to(to).emit('rtc-ice',    { from: socket.id, boxId, candidate }));

  socket.on('disconnect', () => {
    online.delete(socket.id);
    for (const [boxId, sid] of broadcasters.entries()) {
      if (sid === socket.id) {
        broadcasters.delete(boxId);
        io.emit('box-status', { boxId, live: false });
      }
    }
    broadcastUsers();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Trading Cafe Server running on port ${PORT}`));
