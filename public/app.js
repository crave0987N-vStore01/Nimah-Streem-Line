(() => {
  const $ = s => document.querySelector(s);
  let token = localStorage.getItem('token');
  let me = null, users = {}, chats = [], active = null, socket = null;
  const msgs = {};            // chatId -> [messages]
  const online = new Set();
  const typingTimers = {};
  let lastTypingSent = 0;
  let filter = 'all', statuses = [], bgSel = '#d4121a', replyTo = null, seen = {}, pins = [];

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

  const upd = () => { const has = $('#txt').value.trim().length > 0; $('#send').classList.toggle('hide', !has); $('#mic').classList.toggle('hide', has); };
  $('#txt').addEventListener('input', upd);
  $('#btnMenu').onclick = e => { e.stopPropagation(); $('#menu').classList.toggle('hide'); };
  document.addEventListener('click', () => $('#menu').classList.add('hide'));
  $('#fab').onclick = () => document.querySelector('[data-v=vPeople]').click();

  // ---------- Auth (phone + code) ----------
  const step = n => { ['s1', 's2', 's3', 's4'].forEach((id, i) => $('#' + id).classList.toggle('hide', i + 1 !== n)); $('#aErr').textContent = ''; };
  let cool = null;
  function cooldown() {
    let t = 45; clearInterval(cool); $('#aResend').disabled = true;
    cool = setInterval(() => { t--; $('#aResend').textContent = t > 0 ? 'Resend code in ' + t + 's' : 'Resend code'; if (t <= 0) { clearInterval(cool); $('#aResend').disabled = false; } }, 1000);
    $('#aResend').textContent = 'Resend code in 45s';
  }
  async function sendOtp() {
    try {
      const d = await api('/api/otp/send', { method: 'POST', body: { cc: $('#aCc').value, phone: $('#aPhone').value } });
      $('#aInfo').textContent = 'We sent a 6-digit code to ' + d.phone;
      step(2); cooldown(); $('#aCode').value = ''; $('#aCode').focus();
    } catch (e) { $('#aErr').textContent = e.message; }
  }
  $('#aSend').onclick = sendOtp;
  $('#aResend').onclick = sendOtp;
  $('#aBack').onclick = () => step(1);
  $('#aVerify').onclick = async () => {
    try {
      const d = await api('/api/otp/verify', { method: 'POST', body: { cc: $('#aCc').value, phone: $('#aPhone').value, code: $('#aCode').value } });
      token = d.token; localStorage.setItem('token', token);
      if (d.needsName) step(3); else await boot();
    } catch (e) { $('#aErr').textContent = e.message; }
  };
  $('#aCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('#aVerify').click(); });
  $('#aPhone').addEventListener('keydown', e => { if (e.key === 'Enter') sendOtp(); });
  let creating = false;
  $('#pwSwitch').onclick = () => {
    creating = !creating;
    $('#pwName').classList.toggle('hide', !creating);
    $('#pwGo').textContent = creating ? 'Create account' : 'Sign in';
    $('#pwSwitch').textContent = creating ? 'I already have an account' : 'Create a new account';
    $('#pw').autocomplete = creating ? 'new-password' : 'current-password';
    $('#aErr').textContent = '';
  };
  $('#pwGo').onclick = async () => {
    try {
      const d = await api('/api/auth', { method: 'POST', body: { cc: $('#pCc').value, phone: $('#pPhone').value, password: $('#pw').value, name: $('#pwName').value, create: creating } });
      token = d.token; localStorage.setItem('token', token); await boot();
    } catch (e) { $('#aErr').textContent = e.message; }
  };
  $('#pw').addEventListener('keydown', e => { if (e.key === 'Enter') $('#pwGo').click(); });
  fetch('/api/config').then(r => r.json()).then(cf => step(cf.otp ? 1 : 4)).catch(() => step(4));
  $('#aSave').onclick = async () => {
    try { await api('/api/profile', { method: 'POST', body: { name: $('#aName').value } }); await boot(); }
    catch (e) { $('#aErr').textContent = e.message; }
  };

  $('#btnOut').onclick = () => {
    localStorage.removeItem('token'); token = null;
    if (socket) socket.disconnect();
    location.reload();
  };

  // ---------- Helpers ----------
  const initial = n => (n || '?').trim().charAt(0).toUpperCase();
  const other = c => users[c.members.find(id => id !== me.id)] || { name: '?', color: '#6c7a89' };
  const chatName = c => c.type === 'group' ? c.name : other(c).name;
  const chatColor = c => c.type === 'group' ? '#7a0b10' : other(c).color;
  const fmtTime = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isOnline = c => c.type === 'dm' && online.has(other(c).id);
  function setAv(el, u) {
    if (u.avatar) { el.style.background = 'url("' + u.avatar + '") center/cover'; el.textContent = ''; }
    else { el.style.background = u.color; el.textContent = initial(u.name); }
  }
  function avatar(el, c) {
    if (c.type === 'dm') setAv(el, other(c)); else { el.style.background = chatColor(c); el.textContent = initial(chatName(c)); }
    el.classList.toggle('on', isOnline(c));
  }
  function preview(m) {
    if (!m) return '';
    const who = m.from === me.id ? 'You: ' : '';
    return who + (m.deleted ? 'Message deleted' : m.audio ? 'Voice message' : m.image && !m.text ? 'Photo' : m.text);
  }

  // ---------- Chat list ----------
  function renderList() {
    const tot = chats.reduce((n, c) => n + (c.unread || 0), 0);
    $('#tbBadge').classList.toggle('hide', !tot);
    document.title = (tot ? '(' + tot + ') ' : '') + 'Nimah Streem Line';
    const box = $('#list'); box.innerHTML = '';
    const q = $('#search').value.toLowerCase().trim();
    const sorted = chats.filter(c => (filter === 'all' || (filter === 'unread' ? c.unread > 0 : c.type === 'group')) && chatName(c).toLowerCase().includes(q) && (c.last || c.type === 'group' || c.id === active)).sort((a, b) => (pins.includes(b.id) - pins.includes(a.id)) || ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0));
    for (const c of sorted) {
      const it = document.createElement('div');
      it.className = 'item' + (c.id === active ? ' sel' : '');
      const av = document.createElement('div'); av.className = 'av'; avatar(av, c);
      const mid = document.createElement('div'); mid.className = 'mid';
      const top = document.createElement('div'); top.className = 'top';
      const nm = document.createElement('b'); nm.textContent = chatName(c); if (pins.includes(c.id)) nm.append(' ', mk('span', 'pinned', 'Pinned'));
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
  const lastSeen = u => {
    const t = seen[u.id]; if (!t) return 'Offline';
    const d = new Date(t), today = new Date().toDateString() === d.toDateString();
    return 'Last seen ' + (today ? 'today ' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ') + fmtTime(t);
  };
  function renderHeader() {
    const c = chats.find(x => x.id === active); if (!c) return;
    $('#chName').textContent = chatName(c); $('#cPin').textContent = pins.includes(c.id) ? 'Unpin' : 'Pin';
    avatar($('#chAv'), c);
    $('#chSub').textContent = c.type === 'group'
      ? c.members.map(id => (users[id] || {}).name).join(', ')
      : (isOnline(c) ? 'Online' : lastSeen(other(c)));
  }
  const dayKey = ts => new Date(ts).toDateString();
  const dayLabel = ts => { const n = Date.now(); return dayKey(ts) === dayKey(n) ? 'Today' : dayKey(ts) === dayKey(n - 864e5) ? 'Yesterday' : new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' }); };
  function setTick(e, m, c) {
    if (m.failed) { e.textContent = 'Failed, tap to retry'; e.className = 'tk fail'; return; }
    if (m.pending) { e.textContent = 'Sending...'; e.className = 'tk'; return; }
    const o = c.members.filter(i => i !== me.id);
    const r = o.every(i => (m.r || []).includes(i)), dl = o.some(i => (m.d || []).includes(i));
    e.textContent = r || dl ? '\u2713\u2713' : '\u2713';
    e.className = 'tk' + (r ? ' r' : '');
  }
  function linkify(txt) {
    const f = document.createDocumentFragment(), re = /(https?:\/\/[^\s<]+)/g; let i = 0, x;
    while ((x = re.exec(txt))) {
      f.append(txt.slice(i, x.index));
      const a = document.createElement('a'); a.href = x[0]; a.textContent = x[0]; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.onclick = e => e.stopPropagation();
      f.append(a); i = x.index + x[0].length;
    }
    f.append(txt.slice(i)); return f;
  }
  let newCnt = 0;
  $('#msgs').addEventListener('scroll', () => {
    const b = $('#msgs'), far = b.scrollHeight - b.scrollTop - b.clientHeight > 300;
    $('#toBottom').classList.toggle('hide', !far);
    if (!far) { newCnt = 0; $('#tobN').textContent = ''; }
  });
  $('#toBottom').onclick = () => $('#msgs').scrollTo({ top: $('#msgs').scrollHeight, behavior: 'smooth' });
  function openFwd(m) {
    const box = $('#fList'); box.innerHTML = '';
    chats.forEach(c => {
      const it = mk('div', 'item'), av = mk('div', 'av'); avatar(av, c); av.classList.remove('on');
      it.append(av, mk('b', '', chatName(c)));
      it.onclick = () => { socket.emit('send', { chatId: c.id, fwd: { chatId: m.chatId, id: m.id } }, r => { if (r && r.error) alert(r.error); }); $('#fwd').classList.add('hide'); };
      box.append(it);
    });
    $('#fwd').classList.remove('hide');
  }
  $('#fCancel').onclick = () => $('#fwd').classList.add('hide');
  function mk(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt) e.textContent = txt; return e; }
  function bubble(m, c) {
    const d = mk('div', 'msg' + (m.from === me.id ? ' own' : '')); d.dataset.id = m.id;
    if (c.type === 'group' && m.from !== me.id) {
      const u = users[m.from] || { name: '?', color: '#555' };
      const n = mk('div', 'nm', u.name); n.style.color = u.color; d.append(n);
    }
    if (m.deleted) d.append(mk('div', 'gone', 'This message was deleted'));
    else {
      if (m.fwd) d.append(mk('div', 'fwdlbl', 'Forwarded'));
      if (m.reply) {
        const q = mk('div', 'quote'); q.append(mk('b', '', m.reply.from === me.id ? 'You' : (users[m.reply.from] || {}).name), mk('span', '', m.reply.text)); d.append(q);
      }
      if (m.image) { const i = document.createElement('img'); i.src = m.image; i.onclick = e => { e.stopPropagation(); $('#lbi').src = m.image; $('#lb').classList.remove('hide'); }; d.append(i); }
      if (m.audio) { const a = document.createElement('audio'); a.controls = true; a.preload = 'none'; a.src = m.audio; a.onclick = e => e.stopPropagation(); d.append(a); }
      if (m.text) { const tx = mk('div', 'tx'); tx.append(linkify(m.text)); d.append(tx); }
    }
    const t = mk('div', 't', fmtTime(m.ts));
    if (m.from === me.id && !m.deleted) { const k = mk('span'); setTick(k, m, c); t.append(' ', k); }
    d.append(t);
    if (!m.deleted && !m.pending && !m.failed) {
      const act = mk('div', 'act hide');
      const rb = mk('button', '', 'Reply'); rb.onclick = e => { e.stopPropagation(); replyTo = m; showReply(); act.classList.add('hide'); $('#txt').focus(); };
      act.append(rb);
      if (m.text) { const cb = mk('button', '', 'Copy'); cb.onclick = e => { e.stopPropagation(); if (navigator.clipboard) navigator.clipboard.writeText(m.text); act.classList.add('hide'); }; act.append(cb); }
      const fw = mk('button', '', 'Forward'); fw.onclick = e => { e.stopPropagation(); act.classList.add('hide'); openFwd(m); }; act.append(fw);
      if (m.from === me.id) { const db_ = mk('button', '', 'Delete for everyone'); db_.onclick = e => { e.stopPropagation(); if (confirm('Delete this message for everyone?')) socket.emit('delete', { chatId: m.chatId, id: m.id }); }; act.append(db_); }
      d.append(act); d.onclick = () => { act.classList.toggle('hide'); if (!act.classList.contains('hide')) d.scrollIntoView({ block: 'nearest' }); };
    }
    if (m.failed) d.onclick = () => retry(m);
    return d;
  }
  function showReply() {
    $('#rtxt').textContent = (replyTo.from === me.id ? 'You' : (users[replyTo.from] || {}).name) + ': ' + (replyTo.text || (replyTo.audio ? 'Voice message' : 'Photo'));
    $('#rbar').classList.remove('hide');
  }
  $('#rx').onclick = () => { replyTo = null; $('#rbar').classList.add('hide'); };
  function renderMsgs() {
    const c = chats.find(x => x.id === active); if (!c) return;
    const box = $('#msgs'); box.innerHTML = '';
    let last = '';
    (msgs[active] || []).forEach(m => { const k = dayKey(m.ts); if (k !== last) { last = k; box.append(mk('div', 'sys', dayLabel(m.ts))); } box.append(bubble(m, c)); });
    box.scrollTop = box.scrollHeight;
  }

  async function openChat(id) {
    active = id; replyTo = null; $('#rbar').classList.add('hide');
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
    if (m.cid && m.from === me.id) {
      const arr = msgs[m.chatId], i = arr ? arr.findIndex(x => x.id === m.cid) : -1;
      if (i >= 0) {
        arr[i] = m; c.last = m;
        const e = document.querySelector('[data-id="' + m.cid + '"]'); if (e) e.replaceWith(bubble(m, c));
        return renderList();
      }
    }
    c.last = m;
    const viewing = m.chatId === active && document.visibilityState === 'visible';
    const prevM = (msgs[m.chatId] || []).slice(-1)[0];
    if (msgs[m.chatId]) msgs[m.chatId].push(m);
    if (m.from !== me.id) {
      if (viewing) socket.emit('read', m.chatId);
      else { c.unread = (c.unread || 0) + 1; beep(); }
    }
    if (m.chatId === active) {
      const box = $('#msgs');
      const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120 || m.from === me.id;
      if (!prevM || dayKey(prevM.ts) !== dayKey(m.ts)) box.append(mk('div', 'sys', dayLabel(m.ts)));
      box.append(bubble(m, c));
      if (near) box.scrollTop = box.scrollHeight;
      else if (m.from !== me.id) { newCnt++; $('#tobN').textContent = newCnt; }
      $('#chSub').textContent = $('#chSub').dataset.base || $('#chSub').textContent;
    }
    renderList();
  }

  // ---------- Sending ----------
  function send(text, image, audio) {
    if (!active || (!text && !image && !audio)) return;
    const c = chats.find(x => x.id === active); if (!c) return;
    const cid = 'c' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const q = replyTo && { id: replyTo.id, from: replyTo.from, text: (replyTo.text || (replyTo.audio ? 'Voice message' : 'Photo')).slice(0, 80) };
    const tmp = { id: cid, cid, chatId: active, from: me.id, text: text || '', image: image || null, audio: audio || null, ts: Date.now(), d: [], r: [], pending: true, reply: q || null };
    const prevM = (msgs[active] = msgs[active] || []).slice(-1)[0];
    msgs[active].push(tmp); c.last = tmp;
    const box = $('#msgs');
    if (!prevM || dayKey(prevM.ts) !== dayKey(tmp.ts)) box.append(mk('div', 'sys', dayLabel(tmp.ts)));
    box.append(bubble(tmp, c)); box.scrollTop = box.scrollHeight;
    renderList(); transmit(tmp);
    replyTo = null; $('#rbar').classList.add('hide');
  }
  function transmit(m) {
    m.failed = false;
    socket.emit('send', { chatId: m.chatId, cid: m.cid, text: m.text, image: m.image, audio: m.audio, reply: m.reply && m.reply.id }, r => {
      if (r && r.error) { m.pending = false; m.failed = true; const e = document.querySelector('[data-id="' + m.id + '"]'), c = chats.find(x => x.id === m.chatId); if (e && c) e.replaceWith(bubble(m, c)); }
    });
  }
  function retry(m) {
    m.pending = true; m.failed = false;
    const e = document.querySelector('[data-id="' + m.id + '"]'), c = chats.find(x => x.id === m.chatId); if (e && c) e.replaceWith(bubble(m, c));
    transmit(m);
  }
  let rec = null, chunks = [];
  $('#mic').onclick = async () => {
    if (rec) { rec.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = []; const r = new MediaRecorder(stream); rec = r;
      r.ondataavailable = e => chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach(t => t.stop()); rec = null; $('#mic').classList.remove('rec');
        const b = new Blob(chunks, { type: r.mimeType });
        if (b.size > 2.5e6) return alert('Voice message too long');
        const fr = new FileReader(); fr.onload = () => send('', null, fr.result); fr.readAsDataURL(b);
      };
      r.start(); $('#mic').classList.add('rec');
    } catch (e) { alert('Microphone is blocked'); }
  };
  function sendText() {
    const v = $('#txt').value.trim(); if (!v) return;
    $('#txt').value = ''; upd(); send(v, null);
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
    if (b.dataset.v === 'vCalls') loadCalls();
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
      const av = document.createElement('div'); av.className = 'av' + (online.has(u.id) ? ' on' : ''); setAv(av, u);
      const mid = document.createElement('div'); mid.className = 'mid';
      const n = document.createElement('b'); n.textContent = u.name;
      const a = document.createElement('div'); a.className = 'pre'; a.textContent = u.about || u.phone || '';
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
    setAv($('#meAv'), me); $('#mePhone').textContent = me.phone || '';
    if (document.activeElement !== $('#pName')) { $('#pName').value = me.name; $('#pAbout').value = me.about || ''; }
  }
  $('#ncGo').onclick = async () => {
    try {
      const r = await api('/api/chat/phone', { method: 'POST', body: { cc: $('#ncCc').value, phone: $('#ncPhone').value } });
      await loadMe(); $('#ncPhone').value = ''; $('#ncErr').textContent = '';
      document.querySelector('[data-v=vChats]').click(); openChat(r.id);
    } catch (e) { $('#ncErr').textContent = e.message; }
  };
  $('#lb').onclick = () => $('#lb').classList.add('hide');
  $('#cPin').onclick = () => api('/api/pin', { method: 'POST', body: { chatId: active } }).then(r => { pins = r.pins; renderList(); renderHeader(); }).catch(e => alert(e.message));
  $('#meAv').onclick = () => $('#avFile').click();
  $('#avBtn').onclick = () => $('#avFile').click();
  $('#avFile').onchange = e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const img = new Image();
    img.onload = async () => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 256;
      const s = Math.min(img.width, img.height);
      cv.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
      URL.revokeObjectURL(img.src);
      try { await api('/api/profile', { method: 'POST', body: { name: $('#pName').value, about: $('#pAbout').value, avatar: cv.toDataURL('image/jpeg', 0.8) } }); $('#pMsg').textContent = 'Photo updated'; }
      catch (er) { $('#pMsg').textContent = er.message; }
    };
    img.src = URL.createObjectURL(f);
  };
  $('#pSave').onclick = async () => {
    try { await api('/api/profile', { method: 'POST', body: { name: $('#pName').value, about: $('#pAbout').value } }); $('#pMsg').textContent = 'Saved'; }
    catch (e) { $('#pMsg').textContent = e.message; }
  };

  const BGS = ['#1f6bff', '#e5253a', '#14161c', '#7a0b10', '#7a0f1c'];
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

  // ---------- Calls (WebRTC) ----------
  const fmtDur = s => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  let pc = null, call = null, local = null, ring = null, qIce = [];
  function ringing(on) {
    clearInterval(ring); ring = null;
    if (!on) return;
    const go = () => { beep(); if (navigator.vibrate) navigator.vibrate(300); };
    go(); ring = setInterval(go, 1500);
  }
  function showCall(name, state, incoming) {
    $('#call').classList.remove('hide');
    $('#cName').textContent = name; $('#cState').textContent = state;
    $('#cAcc').classList.toggle('hide', !incoming);
    $('#call').classList.toggle('vid', !!(call && call.video));
  }
  function cleanup(msg) {
    ringing(false);
    if (pc) { pc.close(); pc = null; }
    if (local) { local.getTracks().forEach(t => t.stop()); local = null; }
    $('#rv').srcObject = null; $('#lv').srcObject = null;
    qIce = []; call = null;
    if (msg) { $('#cState').textContent = msg; setTimeout(() => { if (!call) $('#call').classList.add('hide'); }, 1200); }
    else $('#call').classList.add('hide');
    loadCalls();
  }
  async function getMedia() {
    local = await navigator.mediaDevices.getUserMedia({ audio: true, video: call.video ? { facingMode: 'user' } : false });
    $('#lv').srcObject = local;
  }
  async function mkPc() {
    let ice = [{ urls: 'stun:stun.l.google.com:19302' }];
    try { ice = await api('/api/ice'); } catch (e) {}
    pc = new RTCPeerConnection({ iceServers: ice });
    local.getTracks().forEach(t => pc.addTrack(t, local));
    pc.onicecandidate = e => e.candidate && socket.emit('call', { type: 'ice', to: call.peer, id: call.id, data: e.candidate });
    pc.ontrack = e => { $('#rv').srcObject = e.streams[0]; };
    pc.onconnectionstatechange = () => {
      if (!call) return;
      if (pc.connectionState === 'connected') { call.on = true; $('#cState').textContent = 'Connected'; }
      if (pc.connectionState === 'failed') hang();
    };
  }
  async function startCall(peer, video) {
    if (call) return;
    if (!users[peer] || !navigator.mediaDevices) return alert('Calls are not available here');
    call = { id: Math.random().toString(36).slice(2) + Date.now().toString(36), peer, video, dir: 'out' };
    showCall(users[peer].name, 'Calling...', false);
    try { await getMedia(); } catch (e) { cleanup(); return alert('Allow microphone' + (video ? ' and camera' : '') + ' access'); }
    socket.emit('call', { type: 'invite', to: peer, id: call.id, video });
  }
  function hang() {
    if (!call) return;
    const t = call.on ? 'end' : call.dir === 'out' ? 'cancel' : 'reject';
    socket.emit('call', { type: t, to: call.peer, id: call.id });
    cleanup();
  }
  async function onCall(d) {
    try {
      if (d.type === 'invite') {
        if (call) return socket.emit('call', { type: 'busy', to: d.from, id: d.id });
        call = { id: d.id, peer: d.from, video: d.video, dir: 'in' };
        showCall((users[d.from] || {}).name || 'Unknown', 'Incoming ' + (d.video ? 'video' : 'voice') + ' call', true);
        return ringing(true);
      }
      if (!call || d.id !== call.id) return;
      if (d.type === 'accept') {
        await mkPc();
        const o = await pc.createOffer(); await pc.setLocalDescription(o);
        socket.emit('call', { type: 'offer', to: call.peer, id: call.id, data: o });
      } else if (d.type === 'offer') {
        await pc.setRemoteDescription(d.data);
        qIce.forEach(x => pc.addIceCandidate(x)); qIce = [];
        const a = await pc.createAnswer(); await pc.setLocalDescription(a);
        socket.emit('call', { type: 'answer', to: call.peer, id: call.id, data: a });
      } else if (d.type === 'answer') {
        await pc.setRemoteDescription(d.data);
        qIce.forEach(x => pc.addIceCandidate(x)); qIce = [];
      } else if (d.type === 'ice') {
        if (pc && pc.remoteDescription) pc.addIceCandidate(d.data); else qIce.push(d.data);
      } else if (['end', 'cancel', 'reject', 'busy'].includes(d.type)) {
        cleanup(d.type === 'busy' ? 'Busy' : d.type === 'reject' ? 'Declined' : 'Call ended');
      }
    } catch (e) { console.error(e); }
  }
  $('#cAcc').onclick = async () => {
    ringing(false); $('#cAcc').classList.add('hide'); $('#cState').textContent = 'Connecting...';
    try { await getMedia(); } catch (e) { hang(); return alert('Allow microphone access'); }
    await mkPc();
    socket.emit('call', { type: 'accept', to: call.peer, id: call.id });
  };
  $('#cEnd').onclick = hang;
  $('#cMute').onclick = e => { if (!local) return; const t = local.getAudioTracks()[0]; t.enabled = !t.enabled; e.currentTarget.textContent = t.enabled ? 'Mute' : 'Unmute'; };
  $('#cCam').onclick = e => { if (!local || !local.getVideoTracks()[0]) return; const t = local.getVideoTracks()[0]; t.enabled = !t.enabled; e.currentTarget.textContent = t.enabled ? 'Camera off' : 'Camera on'; };
  const peerOf = () => { const c = chats.find(x => x.id === active); return c && c.type === 'dm' ? other(c).id : null; };
  $('#cVoice').onclick = () => { const p = peerOf(); p ? startCall(p, false) : alert('Calls work in one-to-one chats'); };
  $('#cVideo').onclick = () => { const p = peerOf(); p ? startCall(p, true) : alert('Calls work in one-to-one chats'); };
  async function loadCalls() {
    let l; try { l = await api('/api/calls'); } catch (e) { return; }
    const box = $('#cList'); box.innerHTML = '';
    l.forEach(x => {
      const out = x.from === me.id, u = users[out ? x.to : x.from] || { id: '', name: '?', color: '#6c7a89' };
      const it = mk('div', 'item'), av = mk('div', 'av', initial(u.name)), mid = mk('div', 'mid'), n = mk('b', '', u.name);
      av.style.background = u.color;
      if (!out && x.status === 'missed') n.style.color = 'var(--rd)';
      mid.append(n, mk('div', 'pre', (out ? 'Outgoing ' : 'Incoming ') + (x.video ? 'video' : 'voice') + ', ' + (x.status === 'answered' ? fmtDur(x.dur) : x.status) + ', ' + fmtTime(x.ts)));
      it.append(av, mid); it.onclick = () => startCall(u.id, x.video); box.append(it);
    });
    if (!l.length) box.innerHTML = '<p class="hint" style="padding:24px">No calls yet</p>';
  }

  // ---------- Boot ----------
  async function loadMe() {
    const d = await api('/api/me');
    me = d.me; users = d.users; chats = d.chats; seen = d.seen || {}; pins = d.pins || [];
    online.clear(); d.online.forEach(id => online.add(id));
    
    setAv($('#meAv'), me);
    renderList(); renderPeople(); renderMe();
    try { if (window.median && median.onesignal && median.onesignal.login) median.onesignal.login(me.id); } catch (e) {}
    if (active) renderHeader();
  }

  function connect() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token } });
    socket.on('message', onMessage);
    socket.on('refresh', loadMe);
    socket.on('status', loadStatus);
    socket.on('call', onCall);
    socket.on('calls', loadCalls);
    socket.on('ticks', ({ chatId, ids, t, userId }) => {
      const c = chats.find(x => x.id === chatId);
      (msgs[chatId] || []).forEach(m => {
        if (!ids.includes(m.id)) return;
        const a = (m[t] = m[t] || []); if (!a.includes(userId)) a.push(userId);
        const e = document.querySelector('[data-id="' + m.id + '"] .tk'); if (e && c) setTick(e, m, c);
      });
    });
    socket.on('deleted', ({ chatId, id }) => {
      const c = chats.find(x => x.id === chatId);
      const m = (msgs[chatId] || []).find(x => x.id === id);
      if (m) {
        Object.assign(m, { deleted: true, text: '', image: null, audio: null, reply: null });
        const e = document.querySelector('[data-id="' + id + '"]'); if (e && c) e.replaceWith(bubble(m, c));
      }
      if (c && c.last && c.last.id === id) { c.last.deleted = true; renderList(); }
    });
    socket.on('presence', ({ userId, online: on, seen: sn }) => {
      if (sn) seen[userId] = sn;
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
      connect(); loadStatus(); loadCalls();
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
