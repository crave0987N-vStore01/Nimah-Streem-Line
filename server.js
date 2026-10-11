const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'db.json');

// ---------- JSON store ----------
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'on' ? { rejectUnauthorized: false } : false });
}
const FB_URL = process.env.FIREBASE_DB_URL || 'https://nimah-dev-site-default-rtdb.firebaseio.com';
const KEYFILE = path.join(__dirname, 'firebase-key.json');
const fbOn = !pool && process.env.USE_FILE !== '1';
const saRaw = () => process.env.FIREBASE_SERVICE_ACCOUNT || (fs.existsSync(KEYFILE) ? fs.readFileSync(KEYFILE, 'utf8') : '');
let snap = {}, tok = { v: null, exp: 0 };
async function fbToken() {
  if (tok.v && Date.now() < tok.exp - 6e4) return tok.v;
  let raw = saRaw().trim();
  if (raw[0] !== '{') raw = Buffer.from(raw, 'base64').toString('utf8');
  const sa = JSON.parse(raw), b = o => Buffer.from(JSON.stringify(o)).toString('base64url'), now = Math.floor(Date.now() / 1000);
  const un = b({ alg: 'RS256', typ: 'JWT' }) + '.' + b({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(un).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: un + '.' + sig }) });
  const d = await r.json();
  if (!d.access_token) throw new Error('firebase auth failed: ' + (d.error_description || d.error));
  tok = { v: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return tok.v;
}
async function fb(method, p, body) {
  const base = FB_URL.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  let q = '';
  if (saRaw()) headers.Authorization = 'Bearer ' + await fbToken();
  else if (process.env.FIREBASE_DB_SECRET) q = '?auth=' + encodeURIComponent(process.env.FIREBASE_DB_SECRET);
  const r = await fetch(`${base}/streem${p}.json${q}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error('firebase ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return r.json();
}
if (fbOn && !saRaw()) console.warn('WARNING: no firebase-key.json found, using unauthenticated database access. Add the key file and lock the rules.');
const db = { users: {}, chats: {}, messages: {}, sessions: {}, reads: {}, status: [], seen: {}, calls: [], pins: {} };
const pending = {}, live = {};
async function push(userId, title, body) {
  const { ONESIGNAL_APP_ID: app, ONESIGNAL_API_KEY: key } = process.env;
  if (!app || !key) return;
  try {
    await fetch('https://api.onesignal.com/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Key ' + key }, body: JSON.stringify({ app_id: app, target_channel: 'push', include_aliases: { external_id: [userId] }, headings: { en: title }, contents: { en: body }, priority: 10 }) });
  } catch (e) {}
}
function finish(id, status) {
  const L = live[id]; if (!L) return;
  delete live[id];
  const st = L.start ? 'answered' : status;
  db.calls.push({ id, from: L.from, to: L.to, video: L.video, ts: L.ts, dur: L.start ? Math.round((Date.now() - L.start) / 1000) : 0, status: st });
  db.calls = db.calls.slice(-500); save();
  [L.from, L.to].forEach(u => io.to('user:' + u).emit('calls'));
  if (st === 'missed') push(L.to, 'Missed call', 'from ' + (db.users[L.from] || {}).name);
}
const dirty = new Set();
let saveTimer = null;
async function init() {
  if (pool) {
    await pool.query('create table if not exists kv(k text primary key, v jsonb not null)');
    await pool.query('create table if not exists msgs(id text primary key, chat text, ts bigint, d jsonb not null)');
    await pool.query('create table if not exists media(id text primary key, mime text, b bytea)');
    const r = await pool.query("select v from kv where k='db'");
    if (r.rows[0]) Object.assign(db, r.rows[0].v);
    db.messages = {};
    (await pool.query('select d from msgs order by ts')).rows.forEach(x => (db.messages[x.d.chatId] = db.messages[x.d.chatId] || []).push(x.d));
  } else if (fbOn) {
    const d = (await fb('GET', '')) || {};
    Object.entries(d.state || {}).forEach(([k, v]) => { db[k] = v; });
    ['status', 'calls'].forEach(k => { if (!Array.isArray(db[k])) db[k] = Object.values(db[k] || {}); });
    db.messages = {};
    Object.entries(d.messages || {}).forEach(([chat, o]) => { db.messages[chat] = Object.values(o).sort((a, b) => a.ts - b.ts); });
  } else {
    try { Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
  }
}
function touch(m) { dirty.add(m); save(); }
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 300); }
async function flush() {
  try {
    if (pool) {
      const { messages, ...rest } = db;
      await pool.query("insert into kv values('db',$1) on conflict(k) do update set v=excluded.v", [JSON.stringify(rest)]);
      for (const m of [...dirty]) {
        dirty.delete(m);
        await pool.query('insert into msgs values($1,$2,$3,$4) on conflict(id) do update set d=excluded.d', [m.id, m.chatId, m.ts, JSON.stringify(m)]);
      }
    } else if (fbOn) {
      const { messages, ...rest } = db, body = {}, keys = [], msgs = [...dirty];
      for (const k in rest) { const j = JSON.stringify(rest[k]); if (snap[k] !== j) { body['state/' + k] = rest[k]; keys.push([k, j]); } }
      msgs.forEach(m => { dirty.delete(m); body['messages/' + m.chatId + '/' + m.id] = m; });
      if (Object.keys(body).length) {
        try { await fb('PATCH', '', body); keys.forEach(([k, j]) => { snap[k] = j; }); }
        catch (e) { msgs.forEach(m => dirty.add(m)); throw e; }
      }
    } else {
      fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
      fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
      fs.renameSync(DB_FILE + '.tmp', DB_FILE);
    }
  } catch (e) { console.error('save failed:', e.message); }
}
async function media(dataUrl) {
  if (!pool && !fbOn) return dataUrl;
  const mm = /^data:([\w\/+.-]+)[^,]*;base64,(.*)$/.exec(dataUrl);
  const id = crypto.randomBytes(16).toString('hex');
  if (fbOn) { await fb('PUT', '/media/' + id, { mime: mm[1], data: mm[2] }); return '/media/' + id; }
  await pool.query('insert into media values($1,$2,$3)', [id, mm[1], Buffer.from(mm[2], 'base64')]);
  return '/media/' + id;
}

const uid = () => crypto.randomBytes(8).toString('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const COLORS = ['#c1121f', '#6d28d9', '#0e7490', '#b45309', '#047857', '#be185d', '#4338ca', '#475569'];
const dmId = (a, b) => 'dm_' + [a, b].sort().join('_');
const pub = u => ({ id: u.id, phone: u.phone, name: u.name, color: u.color, about: u.about || '', avatar: u.avatar || null });

function createUser(phone) {
  const u = { id: uid(), phone, name: '', color: COLORS[Object.keys(db.users).length % COLORS.length] };
  db.users[u.id] = u;
  return u;
}

function addMessage(chatId, from, text, image) {
  const m = { id: uid(), chatId, from, text: text || '', image: image || null, ts: Date.now(), d: [], r: [] };
  (db.messages[chatId] = db.messages[chatId] || []).push(m);
  touch(m);
  return m;
}

// ---------- Express ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });
app.use(express.json({ limit: '100kb' }));
app.set('trust proxy', 1);
app.get('/media/:id', async (req, res) => {
  if (fbOn) {
    try {
      const d = await fb('GET', '/media/' + String(req.params.id).replace(/[^a-f0-9]/g, '').slice(0, 40));
      if (!d) return res.sendStatus(404);
      return res.set('Content-Type', d.mime).set('Cache-Control', 'public,max-age=31536000,immutable').send(Buffer.from(d.data, 'base64'));
    } catch (e) { return res.sendStatus(404); }
  }
  if (!pool) return res.sendStatus(404);
  const r = await pool.query('select mime,b from media where id=$1', [String(req.params.id).slice(0, 40)]);
  if (!r.rows[0]) return res.sendStatus(404);
  res.set('Content-Type', r.rows[0].mime).set('Cache-Control', 'public,max-age=31536000,immutable').send(r.rows[0].b);
});
app.get('/api/ice', auth, (req, res) => {
  const ice = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (!process.env.TURN_URL) ice.push({ urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turns:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' });
  if (process.env.TURN_URL) ice.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  res.json(ice);
});
app.get('/api/calls', auth, (req, res) => res.json(db.calls.filter(c => c.from === req.user.id || c.to === req.user.id).slice(-60).reverse()));
app.post('/api/pin', auth, (req, res) => {
  const id = String((req.body || {}).chatId || '');
  const c = db.chats[id];
  if (!c || !c.members.includes(req.user.id)) return res.status(403).json({ error: 'Not allowed' });
  db.pins = db.pins || {};
  let p = db.pins[req.user.id] || [];
  if (p.includes(id)) p = p.filter(x => x !== id);
  else { if (p.length >= 3) return res.status(400).json({ error: 'You can pin up to 3 chats' }); p.push(id); }
  db.pins[req.user.id] = p; save(); res.json({ pins: p });
});
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

const otps = {};
const sha = (phone, code) => crypto.createHash('sha256').update(phone + ':' + code).digest('hex');
const normPhone = (cc, n) => {
  const c = String(cc || '').replace(/\D/g, ''), x = String(n || '').replace(/\D/g, '').replace(/^0+/, '');
  return c && c.length <= 3 && x.length >= 6 && x.length <= 12 ? '+' + c + x : null;
};
async function sendSms(to, text) {
  const e = process.env;
  if (e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && (e.TWILIO_FROM || e.TWILIO_MESSAGING_SID)) {
    const p = new URLSearchParams({ To: to, Body: text });
    if (e.TWILIO_MESSAGING_SID) p.set('MessagingServiceSid', e.TWILIO_MESSAGING_SID); else p.set('From', e.TWILIO_FROM);
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${e.TWILIO_ACCOUNT_SID}/Messages.json`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(e.TWILIO_ACCOUNT_SID + ':' + e.TWILIO_AUTH_TOKEN).toString('base64') }, body: p });
    if (!r.ok) throw new Error('sms');
    return 'sms';
  }
  if (e.NOTIFYLK_USER_ID && e.NOTIFYLK_API_KEY) {
    const p = new URLSearchParams({ user_id: e.NOTIFYLK_USER_ID, api_key: e.NOTIFYLK_API_KEY, sender_id: e.NOTIFYLK_SENDER || 'NotifyDEMO', to: to.replace('+', ''), message: text });
    const d = await (await fetch('https://app.notify.lk/api/v1/send?' + p)).json().catch(() => ({}));
    if (d.status !== 'success') throw new Error('sms');
    return 'sms';
  }
  if (e.ALLOW_DEV_OTP === '1') { console.log('DEV OTP', to, text); return 'dev'; }
  throw new Error('nosms');
}

const otpOn = () => { const e = process.env; return !!(e.ALLOW_DEV_OTP === '1' || (e.TWILIO_ACCOUNT_SID && e.TWILIO_AUTH_TOKEN && (e.TWILIO_FROM || e.TWILIO_MESSAGING_SID)) || (e.NOTIFYLK_USER_ID && e.NOTIFYLK_API_KEY)); };
app.get('/api/config', (req, res) => res.json({ otp: otpOn() }));

const fails = {};
app.post('/api/auth', (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
  if (otpOn()) return res.status(400).json({ error: 'Use the verification code to sign in' });
  const b = req.body || {}, phone = normPhone(b.cc, b.phone), pw = String(b.password || '');
  if (!phone) return res.status(400).json({ error: 'Enter a valid phone number' });
  let u = Object.values(db.users).find(x => x.phone === phone);
  if (b.create) {
    if (u) return res.status(400).json({ error: 'This number already has an account, sign in instead' });
    if (pw.length < 6) return res.status(400).json({ error: 'Password needs at least 6 characters' });
    const name = String(b.name || '').trim().slice(0, 30);
    if (!name) return res.status(400).json({ error: 'Enter your name' });
    u = createUser(phone); u.name = name;
    u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(pw, u.salt);
    save();
    return res.json({ token: newSession(u.id) });
  }
  const f = fails[phone], now = Date.now();
  if (f && f.n >= 8 && now - f.t < 6e5) return res.status(429).json({ error: 'Too many wrong passwords, try again in 10 minutes' });
  const ok = u && u.hash && crypto.timingSafeEqual(Buffer.from(hashPw(pw, u.salt)), Buffer.from(u.hash));
  if (!ok) { fails[phone] = { n: (f && now - f.t < 6e5 ? f.n : 0) + 1, t: now }; return res.status(400).json({ error: 'Wrong number or password' }); }
  delete fails[phone];
  res.json({ token: newSession(u.id) });
});

app.post('/api/otp/send', async (req, res) => {
  if (!otpOn()) return res.sendStatus(404);
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
  const phone = normPhone((req.body || {}).cc, (req.body || {}).phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid phone number' });
  const o = otps[phone] = otps[phone] || { sent: [] }, now = Date.now();
  o.sent = o.sent.filter(t => now - t < 36e5);
  if (o.last && now - o.last < 45000) return res.status(429).json({ error: 'Wait a moment before asking for another code' });
  if (o.sent.length >= 5) return res.status(429).json({ error: 'Too many codes requested, try again later' });
  const code = String(crypto.randomInt(100000, 1000000));
  let via;
  try { via = await sendSms(phone, `Your Nimah Streem Line code is ${code}. Do not share it with anyone.`); }
  catch (e) {
    return res.status(503).json({ error: e.message === 'nosms' ? 'Verification is not set up yet' : 'Could not send the code' });
  }
  Object.assign(o, { hash: sha(phone, code), exp: now + 3e5, tries: 0, last: now });
  o.sent.push(now);
  res.json({ ok: true, phone, via });
});

app.post('/api/otp/verify', (req, res) => {
  if (!otpOn()) return res.sendStatus(404);
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
  const b = req.body || {}, phone = normPhone(b.cc, b.phone), o = phone && otps[phone];
  if (!o || !o.hash || Date.now() > o.exp) return res.status(400).json({ error: 'Code expired, request a new one' });
  if (++o.tries > 5) { o.hash = null; return res.status(400).json({ error: 'Too many wrong attempts, request a new code' }); }
  const given = Buffer.from(sha(phone, String(b.code || '').trim())), real = Buffer.from(o.hash);
  if (!crypto.timingSafeEqual(given, real)) return res.status(400).json({ error: 'Wrong code' });
  o.hash = null;
  const u = Object.values(db.users).find(x => x.phone === phone) || createUser(phone);
  save();
  res.json({ token: newSession(u.id), needsName: !u.name });
});

app.post('/api/chat/phone', auth, (req, res) => {
  const phone = normPhone((req.body || {}).cc, (req.body || {}).phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid phone number' });
  const t = Object.values(db.users).find(x => x.phone === phone && x.name);
  if (!t) return res.status(404).json({ error: 'This number is not on Nimah Streem Line' });
  if (t.id === req.user.id) return res.status(400).json({ error: 'That is your own number' });
  const id = dmId(req.user.id, t.id);
  if (!db.chats[id]) db.chats[id] = { id, type: 'dm', members: [req.user.id, t.id] };
  io.to('user:' + t.id).emit('refresh');
  save(); res.json({ id });
});

app.get('/api/status', auth, (req, res) => {
  const cut = Date.now() - 864e5;
  db.status = (db.status || []).filter(x => x.ts > cut);
  const vis = visibleIds(req.user.id);
  res.json(db.status.filter(x => vis.has(x.userId)));
});
app.post('/api/status', auth, (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 300);
  if (!text) return res.status(400).json({ error: 'Write something first' });
  const bg = ['#d4121a', '#7a0b10', '#17171a', '#3a0d10', '#a31218'].includes(req.body.bg) ? req.body.bg : '#d4121a';
  (db.status = db.status || []).push({ id: uid(), userId: req.user.id, text, bg, ts: Date.now() });
  save(); io.emit('status'); res.json({ ok: true });
});
app.delete('/api/status/:id', auth, (req, res) => {
  db.status = (db.status || []).filter(x => !(x.id === req.params.id && x.userId === req.user.id));
  save(); io.emit('status'); res.json({ ok: true });
});
app.post('/api/profile', auth, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 30);
  if (name) req.user.name = name;
  req.user.about = String(b.about || '').trim().slice(0, 80);
  if (typeof b.avatar === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(b.avatar) && b.avatar.length < 600000) req.user.avatar = await media(b.avatar);
  if (b.removeAvatar) req.user.avatar = null;
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

function visibleIds(uid_) {
  const ids = new Set([uid_]);
  Object.values(db.chats).forEach(c => { if (c.members.includes(uid_)) c.members.forEach(m => ids.add(m)); });
  return ids;
}

app.get('/api/me', auth, (req, res) => {
  const users = {};
  visibleIds(req.user.id).forEach(id => db.users[id] && (users[id] = pub(db.users[id])));
  res.json({ me: pub(req.user), users, chats: chatsFor(req.user.id), online: [...online.keys()], seen: db.seen || {}, pins: (db.pins || {})[req.user.id] || [] });
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

  const pc0 = pending[uidd];
  if (pc0 && live[pc0.id] && Date.now() - live[pc0.id].ts < 40000) socket.emit('call', pc0);
  Object.values(db.chats).filter(c => c.members.includes(uidd)).forEach(c => {
    const ids = [];
    (db.messages[c.id] || []).forEach(m => { if (m.from !== uidd && !(m.d || []).includes(uidd)) { (m.d = m.d || []).push(uidd); ids.push(m.id); touch(m); } });
    if (ids.length) c.members.forEach(id => io.to('user:' + id).emit('ticks', { chatId: c.id, ids, t: 'd', userId: uidd }));
  });

  socket.on('send', async (data, ack) => {
    try {
      const c = db.chats[data && data.chatId];
      if (!c || !c.members.includes(uidd)) return ack && ack({ error: 'Not allowed' });
      let text = String(data.text || '').trim().slice(0, 4000), image = null, audio = null, fwd = false;
      if (data.cid && (db.messages[c.id] || []).slice(-50).some(x => x.cid === data.cid && x.from === uidd)) return ack && ack({ ok: true });
      if (data.fwd) {
        const sc = db.chats[data.fwd.chatId];
        const sm = sc && sc.members.includes(uidd) && (db.messages[sc.id] || []).find(x => x.id === data.fwd.id);
        if (!sm || sm.deleted) return ack && ack({ error: 'Cannot forward this message' });
        text = sm.text; image = sm.image; audio = sm.audio; fwd = true;
      }
      if (!fwd && typeof data.image === 'string' && /^data:image\/(jpeg|png|webp|gif);base64,/.test(data.image) && data.image.length < 4e6) image = await media(data.image);
      if (!fwd && typeof data.audio === 'string' && /^data:audio\/(webm|ogg|mp4|mpeg|aac)/.test(data.audio) && data.audio.length < 4e6) audio = await media(data.audio);
      if (!text && !image && !audio) return ack && ack({ error: 'Empty message' });
      const m = addMessage(c.id, uidd, text, image);
      if (audio) m.audio = audio;
      if (data.cid) m.cid = String(data.cid).slice(0, 40);
      if (fwd) m.fwd = true;
      const q = data.reply && (db.messages[c.id] || []).find(x => x.id === data.reply);
      if (q) m.reply = { id: q.id, from: q.from, text: q.deleted ? 'Deleted message' : (q.text || (q.audio ? 'Voice message' : 'Photo')).slice(0, 80) };
      m.d = c.members.filter(id => id !== uidd && online.has(id));
      db.reads[uidd] = db.reads[uidd] || {};
      db.reads[uidd][c.id] = m.ts;
      c.members.forEach(id => io.to('user:' + id).emit('message', m));
      c.members.filter(id => id !== uidd && !online.has(id)).forEach(id => push(id, c.type === 'group' ? c.name : socket.user.name, (c.type === 'group' ? socket.user.name + ': ' : '') + (text || (audio ? 'Voice message' : 'Photo'))));
      ack && ack({ ok: true });
    } catch (e) { console.error(e); ack && ack({ error: 'Error' }); }
  });

  socket.on('delete', ({ chatId, id } = {}) => {
    const c = db.chats[chatId];
    if (!c || !c.members.includes(uidd)) return;
    const m = (db.messages[chatId] || []).find(x => x.id === id);
    if (!m || m.from !== uidd) return;
    Object.assign(m, { deleted: true, text: '', image: null, audio: null, reply: null });
    touch(m);
    c.members.forEach(u => io.to('user:' + u).emit('deleted', { chatId, id }));
  });

  socket.on('call', d => {
    if (!d || !db.users[d.to] || d.to === uidd || !d.id) return;
    const out = { ...d, from: uidd };
    if (d.type === 'invite') {
      if (live[d.id]) return;
      live[d.id] = { from: uidd, to: d.to, video: !!d.video, ts: Date.now(), start: 0 };
      pending[d.to] = out;
      setTimeout(() => {
        if (live[d.id] && !live[d.id].start) {
          if (pending[d.to] && pending[d.to].id === d.id) delete pending[d.to];
          io.to('user:' + d.to).emit('call', { type: 'cancel', from: uidd, id: d.id });
          io.to('user:' + uidd).emit('call', { type: 'end', from: d.to, id: d.id });
          finish(d.id, 'missed');
        }
      }, 40000);
      if (!online.has(d.to)) push(d.to, 'Incoming ' + (d.video ? 'video' : 'voice') + ' call', socket.user.name + ' is calling');
    } else {
      const L = live[d.id];
      if (!L || (L.from !== uidd && L.to !== uidd)) return;
      if (d.type === 'accept') L.start = Date.now();
      if (['accept', 'reject', 'cancel', 'busy', 'end'].includes(d.type)) { [L.from, L.to].forEach(u => { if (pending[u] && pending[u].id === d.id) delete pending[u]; }); }
      if (['reject', 'busy'].includes(d.type)) finish(d.id, 'declined');
      if (['cancel', 'end'].includes(d.type)) finish(d.id, 'missed');
    }
    io.to('user:' + d.to).emit('call', out);
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
    const ids = [];
    (db.messages[chatId] || []).forEach(m => {
      if (m.from !== uidd && !(m.r || []).includes(uidd)) {
        (m.r = m.r || []).push(uidd);
        if (!(m.d || []).includes(uidd)) (m.d = m.d || []).push(uidd);
        ids.push(m.id); touch(m);
      }
    });
    if (ids.length) c.members.forEach(id => io.to('user:' + id).emit('ticks', { chatId, ids, t: 'r', userId: uidd }));
    save();
  });

  socket.on('disconnect', () => {
    const n = (online.get(uidd) || 1) - 1;
    if (n <= 0) { online.delete(uidd); db.seen[uidd] = Date.now(); save(); io.emit('presence', { userId: uidd, online: false, seen: db.seen[uidd] }); }
    else online.set(uidd, n);
  });
});

init().then(() => server.listen(PORT, '0.0.0.0', () => console.log(`Nimah Streem Line running on port ${PORT}${pool ? ' (postgres)' : fbOn ? ' (firebase)' : ' (file)'}`))).catch(e => { console.error(e); if (/401|403/.test(e.message)) console.error('Firebase refused access: put firebase-key.json (service account key) in the project root, or open the "streem" rules.'); process.exit(1); });
process.on('SIGTERM', async () => { await flush(); process.exit(0); });
