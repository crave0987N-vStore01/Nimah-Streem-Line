const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'db.json');

// ---------- JSON store ----------
let db = { users: {}, chats: {}, messages: {}, sessions: {}, reads: {}, status: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  }, 200);
}

const uid = () => crypto.randomBytes(8).toString('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const COLORS = ['#e5253a', '#1f6bff', '#8a5cff', '#00a8e8', '#d6336c', '#2f9e9e', '#f08c00', '#6c7a89'];
const dmId = (a, b) => 'dm_' + [a, b].sort().join('_');
const pub = u => ({ id: u.id, username: u.username, name: u.name, color: u.color, about: u.about || '' });

function createUser(username, name, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const u = {
    id: uid(), username, name, salt, hash: hashPw(password, salt),
    color: COLORS[Object.keys(db.users).length % COLORS.length]
  };
  db.users[u.id] = u;
  for (const o of Object.values(db.users)) {
    if (o.id === u.id) continue;
    const id = dmId(u.id, o.id);
    db.chats[id] = { id, type: 'dm', members: [u.id, o.id] };
  }
  return u;
}

function addMessage(chatId, from, text, image) {
  const m = { id: uid(), chatId, from, text: text || '', image: image || null, ts: Date.now() };
  (db.messages[chatId] = db.messages[chatId] || []).push(m);
  save();
  return m;
}

// ---------- Express ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });
app.use(express.json({ limit: '100kb' }));
app.set('trust proxy', 1);
app.get('/health', (q, r) => r.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));

const attempts = {};
function tooMany(ip) {
  const now = Date.now();
  attempts[ip] = (attempts[ip] || []).filter(t => now - t < 60000);
  attempts[ip].push(now);
  return attempts[ip].length > 20;
}

function newSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = userId;
  save();
  return token;
}
const userByToken = t => db.users[db.sessions[t]];

function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const u = userByToken(t);
  if (!u) return res.status(401).json({ error: 'Please sign in again' });
  req.user = u;
  next();
}

app.post('/api/login', (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
  const { username = '', password = '' } = req.body || {};
  const u = Object.values(db.users).find(x => x.username === String(username).toLowerCase().trim());
  if (!u || hashPw(String(password), u.salt) !== u.hash)
    return res.status(400).json({ error: 'Wrong username or password' });
  res.json({ token: newSession(u.id) });
});

app.post('/api/register', (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
  let { username = '', name = '', password = '' } = req.body || {};
  username = String(username).toLowerCase().trim();
  name = String(name).trim().slice(0, 30);
  if (!/^[a-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username: a-z, 0-9, _ (3-20 characters)' });
  if (!name) return res.status(400).json({ error: 'Enter your name' });
  if (String(password).length < 4) return res.status(400).json({ error: 'Password needs at least 4 characters' });
  if (Object.values(db.users).some(x => x.username === username)) return res.status(400).json({ error: 'Username already taken' });
  const u = createUser(username, name, String(password));
  save();
  io.emit('refresh');
  res.json({ token: newSession(u.id) });
});

app.get('/api/status', auth, (req, res) => {
  const cut = Date.now() - 864e5;
  db.status = (db.status || []).filter(x => x.ts > cut);
  res.json(db.status);
});
app.post('/api/status', auth, (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'Write something first' });
  const bg = ['#1f6bff', '#e5253a', '#14161c', '#0b3d91', '#7a0f1c'].includes(req.body.bg) ? req.body.bg : '#1f6bff';
  (db.status = db.status || []).push({ id: uid(), userId: req.user.id, text, bg, ts: Date.now() });
  save(); io.emit('status'); res.json({ ok: true });
});
app.delete('/api/status/:id', auth, (req, res) => {
  db.status = (db.status || []).filter(x => !(x.id === req.params.id && x.userId === req.user.id));
  save(); io.emit('status'); res.json({ ok: true });
});
app.post('/api/profile', auth, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 30);
  if (name) req.user.name = name;
  req.user.about = String(b.about || '').trim().slice(0, 80);
  save(); io.emit('refresh'); res.json({ ok: true });
});

const online = new Map();

function chatsFor(userId) {
  return Object.values(db.chats)
    .filter(c => c.members.includes(userId))
    .map(c => {
      const list = db.messages[c.id] || [];
      const readTs = (db.reads[userId] || {})[c.id] || 0;
      return {
        ...c,
        last: list[list.length - 1] || null,
        unread: list.filter(m => m.ts > readTs && m.from !== userId).length
      };
    });
}

app.get('/api/me', auth, (req, res) => {
  const users = {};
  Object.values(db.users).forEach(u => (users[u.id] = pub(u)));
  res.json({ me: pub(req.user), users, chats: chatsFor(req.user.id), online: [...online.keys()] });
});

app.get('/api/messages/:chatId', auth, (req, res) => {
  const c = db.chats[req.params.chatId];
  if (!c || !c.members.includes(req.user.id)) return res.status(403).json({ error: 'Not allowed' });
  res.json((db.messages[c.id] || []).slice(-300));
});

app.post('/api/groups', auth, (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 40);
  let members = Array.isArray(req.body.members) ? req.body.members : [];
  members = [...new Set([req.user.id, ...members.filter(id => db.users[id])])];
  if (!name) return res.status(400).json({ error: 'Enter a group name' });
  if (members.length < 2) return res.status(400).json({ error: 'Select at least one more person' });
  const id = 'grp_' + uid();
  db.chats[id] = { id, type: 'group', name, members, admin: req.user.id };
  addMessage(id, req.user.id, `Group "${name}" created`);
  members.forEach(m => io.to('user:' + m).emit('refresh'));
  res.json({ id });
});

// ---------- Socket.IO ----------
io.use((socket, next) => {
  const u = userByToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!u) return next(new Error('unauthorized'));
  socket.user = u;
  next();
});

io.on('connection', socket => {
  const uidd = socket.user.id;
  socket.join('user:' + uidd);
  online.set(uidd, (online.get(uidd) || 0) + 1);
  if (online.get(uidd) === 1) io.emit('presence', { userId: uidd, online: true });

  socket.on('send', (data, ack) => {
    try {
      const c = db.chats[data && data.chatId];
      if (!c || !c.members.includes(uidd)) return ack && ack({ error: 'Not allowed' });
      const text = String(data.text || '').trim().slice(0, 4000);
      let image = null;
      if (typeof data.image === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,/.test(data.image) && data.image.length < 2e6)
        image = data.image;
      if (!text && !image) return ack && ack({ error: 'Empty message' });
      const m = addMessage(c.id, uidd, text, image);
      db.reads[uidd] = db.reads[uidd] || {};
      db.reads[uidd][c.id] = m.ts;
      c.members.forEach(id => io.to('user:' + id).emit('message', m));
      ack && ack({ ok: true });
    } catch (e) { ack && ack({ error: 'Error' }); }
  });

  socket.on('typing', chatId => {
    const c = db.chats[chatId];
    if (!c || !c.members.includes(uidd)) return;
    c.members.filter(id => id !== uidd).forEach(id => io.to('user:' + id).emit('typing', { chatId, userId: uidd }));
  });

  socket.on('read', chatId => {
    const c = db.chats[chatId];
    if (!c || !c.members.includes(uidd)) return;
    db.reads[uidd] = db.reads[uidd] || {};
    db.reads[uidd][chatId] = Date.now();
    save();
  });

  socket.on('disconnect', () => {
    const n = (online.get(uidd) || 1) - 1;
    if (n <= 0) { online.delete(uidd); io.emit('presence', { userId: uidd, online: false }); }
    else online.set(uidd, n);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Nimah Streem Line running on port ${PORT}`));
