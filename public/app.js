(() => {
  const $ = s => document.querySelector(s);
  let token = localStorage.getItem('token');
  let me = null, users = {}, chats = [], active = null, socket = null;
  const msgs = {};            // chatId -> [messages]
  const online = new Set();
  const typingTimers = {};
  let lastTypingSent = 0;
  let mode = 'login', filter = 'all', statuses = [], bgSel = '#1f6bff';

  async function api(path, opts = {}) {
    const r = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(d.error || 'Error'); e.status = r.status; throw e; }
    return d;
  }

  // ---------- Auth ----------
  function setMode(m) {
    mode = m;
    $('#tabLogin').classList.toggle('active', m === 'login');
    $('#tabReg').classList.toggle('active', m === 'reg');
    $('#aName').classList.toggle('hide', m === 'login');
    $('#aGo').textContent = m === 'login' ? 'Sign in' : 'Create account';
    $('#aErr').textContent = '';
  }
  $('#tabLogin').onclick = () => setMode('login');
  $('#tabReg').onclick = () => setMode('reg');
  async function doAuth() {
    try {
      const body = { username: $('#aUser').value, password: $('#aPass').value, name: $('#aName').value };
      const d = await api(mode === 'login' ? '/api/login' : '/api/register', { method: 'POST', body });
      token = d.token; localStorage.setItem('token', token);
      await boot();
    } catch (e) { $('#aErr').textContent = e.message; }
  }
  $('#aGo').onclick = doAuth;
  $('#aPass').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth(); });

  $('#btnOut').onclick = () => {
    localStorage.removeItem('token'); token = null;
    if (socket) socket.disconnect();
    location.reload();
  };

  // ---------- Helpers ----------
  const initial = n => (n || '?').trim().charAt(0).toUpperCase();
  const other = c => users[c.members.find(id => id !== me.id)] || { name: '?', color: '#6c7a89' };
  const chatName = c => c.type === 'group' ? c.name : other(c).name;
  const chatColor = c => c.type === 'group' ? '#0b3d91' : other(c).color;
  const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isOnline = c => c.type === 'dm' && online.has(other(c).id);
  function avatar(el, c) {
    el.style.background = chatColor(c);
    el.textContent = initial(chatName(c));
    el.classList.toggle('on', isOnline(c));
  }
  function preview(m) {
    if (!m) return '';
    const who = m.from === me.id ? 'You: ' : '';
    return who + (m.image && !m.text ? 'Photo' : m.text);
  }

  // ---------- Chat list ----------
  function renderList() {
    const tot = chats.reduce((n, c) => n + (c.unread || 0), 0);
    $('#tbBadge').classList.toggle('hide', !tot);
    const box = $('#list'); box.innerHTML = '';
    const q = $('#search').value.toLowerCase().trim();
    const sorted = chats.filter(c => (filter === 'all' || (filter === 'unread' ? c.unread > 0 : c.type === 'group')) && chatName(c).toLowerCase().includes(q)).sort((a, b) => ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0));
    for (const c of sorted) {
      const it = document.createElement('div');
      it.className = 'item' + (c.id === active ? ' sel' : '');
      const av = document.createElement('div'); av.className = 'av'; avatar(av, c);
      const mid = document.createElement('div'); mid.className = 'mid';
      const top = document.createElement('div'); top.className = 'top';
      const nm = document.createElement('b'); nm.textContent = chatName(c);
      const tm = document.createElement('small'); tm.textContent = c.last ? fmtTime(c.last.ts) : '';
      top.append(nm, tm);
      const bot = document.createElement('div'); bot.className = 'top';
      const pre = document.createElement('span'); pre.className = 'pre'; pre.textContent = preview(c.last);
      bot.append(pre);
      if (c.unread > 0) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = c.unread; bot.append(b); }
      mid.append(top, bot);
      it.append(av, mid);
      it.onclick = () => openChat(c.id);
      box.append(it);
    }
  }

  // ---------- Messages ----------
  function renderHeader() {
    const c = chats.find(x => x.id === active); if (!c) return;
    $('#chName').textContent = chatName(c);
    avatar($('#chAv'), c);
    $('#chSub').textContent = c.type === 'group'
      ? c.members.map(id => (users[id] || {}).name).join(', ')
      : (isOnline(c) ? 'Online' : 'Offline');
  }
  function bubble(m, c) {
    const d = document.createElement('div');
    d.className = 'msg' + (m.from === me.id ? ' own' : '');
    if (c.type === 'group' && m.from !== me.id) {
      const u = users[m.from] || { name: '?', color: '#555' };
      const n = document.createElement('div'); n.className = 'nm'; n.style.color = u.color; n.textContent = u.name; d.append(n);
    }
    if (m.image) { const i = document.createElement('img'); i.src = m.image; d.append(i); }
    if (m.text) { const t = document.createElement('div'); t.className = 'tx'; t.textContent = m.text; d.append(t); }
    const t = document.createElement('div'); t.className = 't'; t.textContent = fmtTime(m.ts); d.append(t);
    return d;
  }
  function renderMsgs() {
    const c = chats.find(x => x.id === active); if (!c) return;
    const box = $('#msgs'); box.innerHTML = '';
    (msgs[active] || []).forEach(m => box.append(bubble(m, c)));
    box.scrollTop = box.scrollHeight;
  }

  async function openChat(id) {
    active = id;
    $('#empty').classList.add('hide'); $('#pane').classList.remove('hide');
    $('#app').classList.add('show-chat');
    if (!msgs[id]) msgs[id] = await api('/api/messages/' + id);
    const c = chats.find(x => x.id === id); if (c) c.unread = 0;
    socket.emit('read', id);
    renderHeader(); renderMsgs(); renderList();
    if (innerWidth > 760) $('#txt').focus();
  }
  $('#btnBack').onclick = () => { $('#app').classList.remove('show-chat'); active = null; renderList(); };

  function beep() {
    try {
      const a = new (window.AudioContext || window.webkitAudioContext)();
      const o = a.createOscillator(), g = a.createGain();
      o.connect(g); g.connect(a.destination); o.frequency.value = 880; g.gain.value = 0.05;
      o.start(); o.stop(a.currentTime + 0.12);
    } catch (e) {}
  }

  function onMessage(m) {
    (msgs[m.chatId] = msgs[m.chatId] || (m.chatId === active ? [] : undefined));
    const c = chats.find(x => x.id === m.chatId);
    if (!c) return loadMe();
    c.last = m;
    const viewing = m.chatId === active && document.visibilityState === 'visible';
    if (msgs[m.chatId]) msgs[m.chatId].push(m);
    if (m.from !== me.id) {
      if (viewing) socket.emit('read', m.chatId);
      else { c.unread = (c.unread || 0) + 1; beep(); }
    }
    if (m.chatId === active) {
      const box = $('#msgs');
      const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120 || m.from === me.id;
      box.append(bubble(m, c));
      if (near) box.scrollTop = box.scrollHeight;
      $('#chSub').textContent = $('#chSub').dataset.base || $('#chSub').textContent;
    }
    renderList();
  }

  // ---------- Sending ----------
  function send(text, image) {
    if (!active || (!text && !image)) return;
    socket.emit('send', { chatId: active, text, image }, r => { if (r && r.error) alert(r.error); });
  }
  function sendText() {
    const v = $('#txt').value.trim(); if (!v) return;
    $('#txt').value = ''; send(v, null);
  }
  $('#send').onclick = sendText;
  $('#txt').addEventListener('keydown', e => { if (e.key === 'Enter') sendText(); });
  $('#txt').addEventListener('input', () => {
    if (Date.now() - lastTypingSent > 1500 && active) { lastTypingSent = Date.now(); socket.emit('typing', active); }
  });
  $('#file').onchange = e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const img = new Image();
    img.onload = () => {
      const max = 900, s = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      const caption = $('#txt').value.trim(); $('#txt').value = '';
      send(caption, cv.toDataURL('image/jpeg', 0.75));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(f);
  };

  // ---------- Groups ----------
  $('#btnGroup').onclick = () => {
    const box = $('#gUsers'); box.innerHTML = ''; $('#gName').value = ''; $('#gErr').textContent = '';
    Object.values(users).filter(u => u.id !== me.id).forEach(u => {
      const l = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.value = u.id;
      const av = document.createElement('div'); av.className = 'av'; av.style.cssText = 'background:' + u.color + ';width:32px;height:32px'; av.textContent = initial(u.name);
      const sp = document.createElement('span'); sp.textContent = u.name;
      l.append(cb, av, sp); box.append(l);
    });
    $('#modal').classList.remove('hide');
  };
  $('#gCancel').onclick = () => $('#modal').classList.add('hide');
  $('#gCreate').onclick = async () => {
    try {
      const members = [...document.querySelectorAll('#gUsers input:checked')].map(i => i.value);
      const d = await api('/api/groups', { method: 'POST', body: { name: $('#gName').value, members } });
      $('#modal').classList.add('hide');
      await loadMe(); openChat(d.id);
    } catch (e) { $('#gErr').textContent = e.message; }
  };

  // ---------- Tabs, filters, people, status, profile ----------
  document.querySelectorAll('.tabbar button').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tabbar button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.view').forEach(v => v.classList.toggle('hide', v.id !== b.dataset.v));
    if (b.dataset.v === 'vUpdates') { seenSt = Date.now(); $('#stDot').classList.add('hide'); }
  });
  document.querySelectorAll('.chips button').forEach(b => b.onclick = () => {
    filter = b.dataset.f;
    document.querySelectorAll('.chips button').forEach(x => x.classList.toggle('on', x === b));
    renderList();
  });
  $('#search').oninput = renderList;
  $('#pSearch').oninput = renderPeople;
  let seenSt = Date.now();

  function renderPeople() {
    const q = $('#pSearch').value.toLowerCase().trim(), box = $('#people'); box.innerHTML = '';
    Object.values(users).filter(u => u.id !== me.id && u.name.toLowerCase().includes(q)).forEach(u => {
      const it = document.createElement('div'); it.className = 'item';
      const av = document.createElement('div'); av.className = 'av' + (online.has(u.id) ? ' on' : ''); av.style.background = u.color; av.textContent = initial(u.name);
      const mid = document.createElement('div'); mid.className = 'mid';
      const n = document.createElement('b'); n.textContent = u.name;
      const a = document.createElement('div'); a.className = 'pre'; a.textContent = u.about || '@' + u.username;
      mid.append(n, a); it.append(av, mid);
      it.onclick = () => {
        const c = chats.find(x => x.type === 'dm' && x.members.includes(u.id));
        document.querySelector('[data-v=vChats]').click();
        if (c) openChat(c.id);
      };
      box.append(it);
    });
  }

  function renderMe() {
    const av = $('#meAv'); av.style.background = me.color; av.textContent = initial(me.name);
    if (document.activeElement !== $('#pName')) { $('#pName').value = me.name; $('#pAbout').value = me.about || ''; }
  }
  $('#pSave').onclick = async () => {
    try { await api('/api/profile', { method: 'POST', body: { name: $('#pName').value, about: $('#pAbout').value } }); $('#pMsg').textContent = 'Saved'; }
    catch (e) { $('#pMsg').textContent = e.message; }
  };

  const BGS = ['#1f6bff', '#e5253a', '#14161c', '#0b3d91', '#7a0f1c'];
  const sw = $('#sw');
  BGS.forEach(c => {
    const s = document.createElement('span'); s.style.background = c; if (c === bgSel) s.className = 'on';
    s.onclick = () => { bgSel = c; [...sw.children].forEach(x => x.classList.toggle('on', x === s)); };
    sw.append(s);
  });
  $('#stPost').onclick = async () => {
    try { await api('/api/status', { method: 'POST', body: { text: $('#stTxt').value, bg: bgSel } }); $('#stTxt').value = ''; }
    catch (e) { alert(e.message); }
  };
  async function loadStatus() {
    try { statuses = await api('/api/status'); } catch (e) { return; }
    const box = $('#stList'); box.innerHTML = '';
    [...statuses].reverse().forEach(x => {
      const u = users[x.userId] || { name: '?' };
      const d = document.createElement('div'); d.className = 'st'; d.style.background = x.bg;
      const p = document.createElement('p'); p.textContent = x.text;
      const f = document.createElement('small');
      const l = document.createElement('span'); l.textContent = (x.userId === me.id ? 'You' : u.name) + ', ' + fmtTime(x.ts);
      f.append(l);
      if (x.userId === me.id) { const del = document.createElement('button'); del.textContent = 'Delete'; del.onclick = () => api('/api/status/' + x.id, { method: 'DELETE' }); f.append(del); }
      d.append(p, f); box.append(d);
    });
    if (!statuses.length) box.innerHTML = '<p class="hint" style="padding:24px">No updates yet</p>';
    const fresh = statuses.some(x => x.userId !== me.id && x.ts > seenSt);
    if (fresh && $('#vUpdates').classList.contains('hide')) $('#stDot').classList.remove('hide');
  }

  // ---------- Boot ----------
  async function loadMe() {
    const d = await api('/api/me');
    me = d.me; users = d.users; chats = d.chats;
    online.clear(); d.online.forEach(id => online.add(id));
    
    const av = $('#meAv'); av.style.background = me.color; av.textContent = initial(me.name);
    renderList(); renderPeople(); renderMe();
    if (active) renderHeader();
  }

  function connect() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });
    socket.on('message', onMessage);
    socket.on('refresh', loadMe);
    socket.on('status', loadStatus);
    socket.on('presence', ({ userId, online: on }) => {
      on ? online.add(userId) : online.delete(userId);
      renderList(); if (active) renderHeader();
    });
    socket.on('typing', ({ chatId, userId }) => {
      if (chatId !== active) return;
      const c = chats.find(x => x.id === chatId);
      const sub = $('#chSub');
      if (!sub.dataset.base) sub.dataset.base = sub.textContent;
      sub.textContent = (c.type === 'group' ? (users[userId] || {}).name + ' ' : '') + 'typing...';
      clearTimeout(typingTimers[chatId]);
      typingTimers[chatId] = setTimeout(() => { delete sub.dataset.base; renderHeader(); }, 2000);
    });
    socket.on('connect', () => { if (me) loadMe(); });
  }

  async function boot() {
    if (!token) { $('#auth').classList.remove('hide'); return; }
    try {
      await loadMe();
      $('#auth').classList.add('hide'); $('#app').classList.remove('hide');
      connect(); loadStatus();
    } catch (e) {
      if (e.status === 401) { localStorage.removeItem('token'); token = null; }
      $('#auth').classList.remove('hide'); $('#app').classList.add('hide');
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && active && socket) {
      const c = chats.find(x => x.id === active); if (c) { c.unread = 0; renderList(); }
      socket.emit('read', active);
    }
  });
  boot();
})();
