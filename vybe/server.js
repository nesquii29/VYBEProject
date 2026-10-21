const express = require('express'), http = require('http'), crypto = require('crypto');
const path = require('path'), fs = require('fs');
const Database = require('better-sqlite3'), multer = require('multer');
const { WebSocketServer } = require('ws');

// ---------- База данных (SQLite) и папка для mp3 ----------
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const UP = path.join(DATA, 'uploads');
fs.mkdirSync(UP, { recursive: true });
const db = new Database(path.join(DATA, 'vybe.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT UNIQUE, salt TEXT, hash TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, uid INTEGER);
CREATE TABLE IF NOT EXISTS tracks(id INTEGER PRIMARY KEY, uid INTEGER, title TEXT, file TEXT);
CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY, name TEXT, owner INTEGER);
`);
try { db.exec('ALTER TABLE users ADD COLUMN admin INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE users ADD COLUMN tag TEXT'); } catch {}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_tag ON users(tag); CREATE TABLE IF NOT EXISTS friends(a INTEGER, b INTEGER, status TEXT, PRIMARY KEY(a, b));');
// Уникальный тег пользователя (5 цифр), по нему ищут друзей
const newTag = () => {
  let t;
  do { t = String(10000 + Math.floor(Math.random() * 90000)); } while (db.prepare('SELECT 1 FROM users WHERE tag = ?').get(t));
  return t;
};
db.prepare('SELECT id FROM users WHERE tag IS NULL').all().forEach((u) => db.prepare('UPDATE users SET tag = ? WHERE id = ?').run(newTag(), u.id));

// ---------- Миграции схемы ----------
if (db.pragma('user_version', { simple: true }) < 1) {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE rooms ADD COLUMN description TEXT NOT NULL DEFAULT '';
      ALTER TABLE rooms ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
      ALTER TABLE rooms ADD COLUMN tags TEXT NOT NULL DEFAULT '';
      ALTER TABLE rooms ADD COLUMN max_users INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE rooms ADD COLUMN control TEXT NOT NULL DEFAULT 'all';
      ALTER TABLE rooms ADD COLUMN invite TEXT;
      ALTER TABLE rooms ADD COLUMN active_at INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS room_members(room INTEGER, uid INTEGER, PRIMARY KEY(room, uid));
    `);
    db.prepare('SELECT id FROM rooms').all().forEach((r) => db.prepare('UPDATE rooms SET invite = ? WHERE id = ?').run(crypto.randomBytes(8).toString('hex'), r.id));
    db.pragma('user_version = 1');
  })();
}

// ---------- Пользователи и сессии ----------
const hashPw = (p, salt) => crypto.scryptSync(p, salt, 32).toString('hex');
const cookieOf = (req) => (/(?:^|; )t=([a-f0-9]+)/.exec(req.headers.cookie || '') || [])[1];
const userOf = (req) => {
  const t = cookieOf(req);
  return t && db.prepare('SELECT u.id, u.name, u.admin, u.tag FROM sessions s JOIN users u ON u.id = s.uid WHERE s.token = ?').get(t);
};
const startSession = (res, uid) => {
  const t = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions VALUES(?, ?)').run(t, uid);
  res.setHeader('Set-Cookie', `t=${t}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
};

// ---------- Администратор ----------
// Логин: ADMIN_NAME (по умолчанию admin). Пароль: ADMIN_PASSWORD; если не задан и админа ещё нет,
// пароль генерируется и один раз печатается в терминал.
const adminName = process.env.ADMIN_NAME || 'admin';
{
  let pw = process.env.ADMIN_PASSWORD;
  const adm = db.prepare('SELECT id FROM users WHERE name = ?').get(adminName);
  if (pw || !adm) {
    const generated = !pw;
    pw = pw || crypto.randomBytes(6).toString('hex');
    const salt = crypto.randomBytes(16).toString('hex');
    if (adm) db.prepare('UPDATE users SET salt = ?, hash = ?, admin = 1 WHERE id = ?').run(salt, hashPw(pw, salt), adm.id);
    else db.prepare('INSERT INTO users(name, salt, hash, admin, tag) VALUES(?, ?, ?, 1, ?)').run(adminName, salt, hashPw(pw, salt), newTag());
    console.log(generated ? `АДМИН создан. Логин: ${adminName}  Пароль: ${pw}` : `Пароль админа «${adminName}» задан из ADMIN_PASSWORD`);
  }
}

// ---------- Комнаты «вживую» (в памяти) ----------
const live = new Map(); // id комнаты -> { track, playing, pos, at, clients }
const room = (id) => live.get(id) || live.set(id, { track: null, playing: false, pos: 0, at: 0, clients: new Set() }).get(id);
const posNow = (r) => (r.playing ? r.pos + (Date.now() - r.at) / 1000 : r.pos);
const push = (r) => {
  const m = JSON.stringify({ type: 'state', track: r.track, playing: r.playing, pos: posNow(r), users: uids(r).size, names: [...new Set([...r.clients].map((c) => c.uname))] });
  r.clients.forEach((c) => c.send(m));
};

// ---------- HTTP API ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-store') }));
const auth = (req, res, next) => {
  req.user = userOf(req);
  req.user ? next() : res.status(401).json({ error: 'Войдите в аккаунт' });
};

app.post('/api/register', (req, res) => {
  const { name, password } = req.body || {};
  if (!/^[\wа-яё-]{3,20}$/i.test(name || '') || (password || '').length < 6)
    return res.status(400).json({ error: 'Имя 3–20 символов, пароль от 6' });
  if (name === adminName || db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) return res.status(409).json({ error: 'Это имя занято' });
  const salt = crypto.randomBytes(16).toString('hex');
  const id = db.prepare('INSERT INTO users(name, salt, hash, tag) VALUES(?, ?, ?, ?)').run(name, salt, hashPw(password, salt), newTag()).lastInsertRowid;
  startSession(res, id);
  res.json({ id, name });
});

app.post('/api/login', (req, res) => {
  const { name, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE name = ?').get(name || '');
  const ok = u && crypto.timingSafeEqual(Buffer.from(u.hash), Buffer.from(hashPw(password || '', u.salt)));
  if (!ok) return res.status(401).json({ error: 'Неверное имя или пароль' });
  startSession(res, u.id);
  res.json({ id: u.id, name: u.name });
});

app.post('/api/logout', (req, res) => {
  const t = cookieOf(req);
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  res.setHeader('Set-Cookie', 't=; Path=/; Max-Age=0');
  res.json({});
});

app.get('/api/me', (req, res) => res.json(userOf(req) || null));

// ---------- Комнаты ----------
const uids = (r) => new Set([...r.clients].map((c) => c.uid));
const ROOM_SQL = 'SELECT r.*, u.name AS owner_name FROM rooms r JOIN users u ON u.id = r.owner';
const canAccess = (r, user) => r.visibility === 'public' || r.owner === user.id || !!user.admin || !!db.prepare('SELECT 1 FROM room_members WHERE room = ? AND uid = ?').get(r.id, user.id);
const view = (r, user) => {
  const lr = live.get(r.id);
  const o = {
    id: r.id, name: r.name, description: r.description, visibility: r.visibility,
    tags: r.tags ? r.tags.split(',') : [], max: r.max_users, control: r.control,
    owner: r.owner_name, oid: r.owner, online: lr ? uids(lr).size : 0,
    track: lr && lr.track ? lr.track.title : null, playing: !!(lr && lr.playing), active: r.active_at,
  };
  if (user.admin || r.owner === user.id) o.invite = r.invite; // токен приглашения видит только хозяин
  return o;
};

function roomInput(b, partial) {
  const o = {};
  b = b || {};
  if (!partial || 'name' in b) { const v = String(b.name || '').trim(); if (!v || v.length > 40) return { error: 'Название: от 1 до 40 символов' }; o.name = v; }
  if (!partial || 'description' in b) { const v = String(b.description || '').trim(); if (v.length > 200) return { error: 'Описание: не больше 200 символов' }; o.description = v; }
  if (!partial || 'visibility' in b) { const v = b.visibility || 'public'; if (!['public', 'private', 'unlisted'].includes(v)) return { error: 'Неверный тип комнаты' }; o.visibility = v; }
  if (!partial || 'control' in b) { const v = b.control || 'all'; if (!['all', 'owner'].includes(v)) return { error: 'Неверное значение управления' }; o.control = v; }
  if (!partial || 'tags' in b) {
    const t = [...new Set(String(b.tags || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean))];
    if (t.length > 5 || t.some((x) => x.length > 20)) return { error: 'Теги: до 5, каждый до 20 символов' };
    o.tags = t.join(',');
  }
  if (!partial || 'max_users' in b) { const n = Math.floor(+(b.max_users || 0)); if (!(n >= 0 && n <= 50)) return { error: 'Лимит участников: от 0 (без лимита) до 50' }; o.max_users = n; }
  return o;
}

// Мои комнаты: свои и те, куда я заходил
app.get('/api/rooms', auth, (req, res) => {
  const rows = db.prepare(ROOM_SQL + ' WHERE r.owner = ? OR ? = 1 OR r.id IN (SELECT room FROM room_members WHERE uid = ?) ORDER BY r.active_at DESC, r.id DESC')
    .all(req.user.id, req.user.admin ? 1 : 0, req.user.id);
  res.json(rows.map((r) => view(r, req.user)));
});

// Обзор: только публичные комнаты
app.get('/api/discover', auth, (req, res) => {
  const { q = '', tag = '', sort = 'active', playing = '' } = req.query;
  let rows = db.prepare(ROOM_SQL + " WHERE r.visibility = 'public'").all().map((r) => view(r, req.user));
  const tags = {};
  rows.forEach((r) => r.tags.forEach((t) => (tags[t] = (tags[t] || 0) + 1)));
  const ql = String(q).toLowerCase().trim();
  if (ql) rows = rows.filter((r) => (r.name + ' ' + r.description).toLowerCase().includes(ql));
  if (tag) rows = rows.filter((r) => r.tags.includes(String(tag).toLowerCase()));
  if (playing === '1') rows = rows.filter((r) => r.playing);
  rows.sort(sort === 'recent' ? (a, b) => b.active - a.active : (a, b) => b.online - a.online || b.active - a.active);
  res.json({ rooms: rows.slice(0, 60), tags: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x[0]) });
});

app.post('/api/rooms', auth, (req, res) => {
  const o = roomInput(req.body);
  if (o.error) return res.status(400).json({ error: o.error });
  const id = db.prepare('INSERT INTO rooms(name, owner, description, visibility, tags, max_users, control, invite, active_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(o.name, req.user.id, o.description, o.visibility, o.tags, o.max_users, o.control, crypto.randomBytes(8).toString('hex'), Date.now()).lastInsertRowid;
  res.json(view(db.prepare(ROOM_SQL + ' WHERE r.id = ?').get(id), req.user));
});

app.patch('/api/rooms/:id', auth, (req, res) => {
  const r = db.prepare(ROOM_SQL + ' WHERE r.id = ?').get(+req.params.id);
  if (!r || !canAccess(r, req.user)) return res.status(404).json({ error: 'Комната не найдена' });
  if (r.owner !== req.user.id && !req.user.admin) return res.status(403).json({ error: 'Менять настройки может только хозяин комнаты' });
  const o = roomInput(req.body, true);
  if (o.error) return res.status(400).json({ error: o.error });
  const keys = Object.keys(o);
  if (keys.length) db.prepare('UPDATE rooms SET ' + keys.map((k) => k + ' = ?').join(', ') + ' WHERE id = ?').run(...keys.map((k) => o[k]), r.id);
  presence();
  res.json(view(db.prepare(ROOM_SQL + ' WHERE r.id = ?').get(r.id), req.user));
});

// Вход в комнату: публичная открыта всем, остальные требуют членства или верного токена приглашения
app.post('/api/rooms/:id/join', auth, (req, res) => {
  const r = db.prepare(ROOM_SQL + ' WHERE r.id = ?').get(+req.params.id);
  const key = String((req.body || {}).invite || '');
  if (!r || !(canAccess(r, req.user) || (key && key === r.invite)))
    return res.status(404).json({ error: 'Комната не найдена или у вас нет доступа. Нужна ссылка-приглашение.' });
  db.prepare('INSERT OR IGNORE INTO room_members VALUES(?, ?)').run(r.id, req.user.id);
  res.json(view(r, req.user));
});

app.delete('/api/rooms/:id', auth, (req, res) => {
  const id = +req.params.id;
  const r = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
  if (r && (req.user.admin || r.owner === req.user.id)) {
    db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
    db.prepare('DELETE FROM room_members WHERE room = ?').run(id);
    const lr = live.get(id);
    if (lr) { lr.clients.forEach((c) => { c.room = null; c.send(JSON.stringify({ type: 'gone', room: id })); }); live.delete(id); }
    presence();
  }
  res.json({});
});

// ---------- Друзья ----------
const online = (uid) => [...wss.clients].filter((c) => c.uid === uid && c.readyState === 1);

app.get('/api/friends', auth, (req, res) => {
  const me = req.user.id;
  res.json(db.prepare('SELECT * FROM friends WHERE a = ? OR b = ?').all(me, me).map((f) => {
    const oid = f.a === me ? f.b : f.a;
    const u = db.prepare('SELECT id, name, tag FROM users WHERE id = ?').get(oid);
    const socks = online(oid);
    const rc = socks.find((c) => c.room);
    const rrow = rc && db.prepare('SELECT * FROM rooms WHERE id = ?').get(rc.room);
    const rm = rrow && canAccess(rrow, req.user) ? { id: rrow.id, name: rrow.name } : null;
    return { ...u, status: f.status, dir: f.a === me ? 'out' : 'in', online: socks.length > 0, room: rm || null };
  }));
});

app.post('/api/friends', auth, (req, res) => {
  const tag = String((req.body || {}).tag || '').replace('#', '').trim();
  const u = db.prepare('SELECT id FROM users WHERE tag = ?').get(tag);
  if (!u) return res.status(404).json({ error: 'Пользователь с таким тегом не найден' });
  const me = req.user.id;
  if (u.id === me) return res.status(400).json({ error: 'Это ваш собственный тег' });
  const rev = db.prepare('SELECT * FROM friends WHERE a = ? AND b = ?').get(u.id, me);
  const fwd = db.prepare('SELECT * FROM friends WHERE a = ? AND b = ?').get(me, u.id);
  if (rev && rev.status === 'pending') db.prepare("UPDATE friends SET status = 'ok' WHERE a = ? AND b = ?").run(u.id, me);
  else if (rev || fwd) return res.status(409).json({ error: 'Заявка уже отправлена или вы уже друзья' });
  else db.prepare("INSERT INTO friends VALUES(?, ?, 'pending')").run(me, u.id);
  presence();
  res.json({});
});

app.post('/api/friends/:id/accept', auth, (req, res) => {
  db.prepare("UPDATE friends SET status = 'ok' WHERE a = ? AND b = ?").run(+req.params.id, req.user.id);
  presence();
  res.json({});
});

app.delete('/api/friends/:id', auth, (req, res) => {
  const id = +req.params.id, me = req.user.id;
  db.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').run(me, id, id, me);
  presence();
  res.json({});
});

// ---------- Админка ----------
const adminOnly = (req, res, next) => (req.user.admin ? next() : res.sendStatus(403));
app.get('/api/users', auth, adminOnly, (req, res) => res.json(db.prepare('SELECT id, name, admin FROM users ORDER BY id').all()));
app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить себя' });
  db.prepare('SELECT file FROM tracks WHERE uid = ?').all(id).forEach((t) => fs.unlink(path.join(UP, t.file), () => {}));
  db.prepare('DELETE FROM tracks WHERE uid = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE uid = ?').run(id);
  db.prepare('DELETE FROM friends WHERE a = ? OR b = ?').run(id, id);
  db.prepare('DELETE FROM room_members WHERE uid = ? OR room IN (SELECT id FROM rooms WHERE owner = ?)').run(id, id);
  db.prepare('DELETE FROM rooms WHERE owner = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({});
});

// ---------- Личная музыка (mp3) ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UP,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + '.mp3'),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /\.mp3$/i.test(file.originalname)),
});

app.get('/api/tracks', auth, (req, res) => {
  res.json(db.prepare('SELECT id, title FROM tracks WHERE uid = ? ORDER BY id DESC').all(req.user.id));
});

app.post('/api/tracks', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нужен файл .mp3 до 20 МБ' });
  const title = Buffer.from(req.file.originalname, 'latin1').toString('utf8').replace(/\.mp3$/i, '').slice(0, 80);
  const id = db.prepare('INSERT INTO tracks(uid, title, file) VALUES(?, ?, ?)').run(req.user.id, title, req.file.filename).lastInsertRowid;
  res.json({ id, title });
});

app.delete('/api/tracks/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tracks WHERE id = ? AND uid = ?').get(+req.params.id, req.user.id);
  if (t) {
    db.prepare('DELETE FROM tracks WHERE id = ?').run(t.id);
    fs.unlink(path.join(UP, t.file), () => {});
  }
  res.json({});
});

// Слушать трек может владелец или участники комнаты, где он сейчас играет
app.get('/audio/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tracks WHERE id = ?').get(+req.params.id);
  const inRoom = [...live.values()].some((r) => r.track && r.track.id === (t && t.id) && [...r.clients].some((c) => c.uid === req.user.id));
  if (!t || (t.uid !== req.user.id && !inRoom)) return res.sendStatus(404);
  res.sendFile(path.join(UP, t.file));
});

// ---------- WebSocket: присутствие и синхронное прослушивание ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const presence = () => wss.clients.forEach((c) => c.readyState === 1 && c.send('{"type":"presence"}'));

wss.on('connection', (ws, req) => {
  const user = userOf(req);
  if (!user) return ws.close();
  ws.uname = user.name;
  ws.uid = user.id;
  ws.room = null;
  let r = null;
  const leaveRoom = () => { if (r) { r.clients.delete(ws); push(r); r = null; ws.room = null; } };
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join') {
      const id = +m.room;
      const row = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
      const fail = (code) => ws.send(JSON.stringify({ type: 'error', code, room: id }));
      if (!row) return;
      if (!canAccess(row, user)) return fail('denied');
      const lr = room(id);
      const vip = row.owner === user.id || user.admin;
      if (row.max_users && !vip && !uids(lr).has(user.id) && uids(lr).size >= row.max_users) return fail('full');
      leaveRoom();
      r = lr;
      r.clients.add(ws);
      ws.room = id;
      db.prepare('UPDATE rooms SET active_at = ? WHERE id = ?').run(Date.now(), id);
      push(r);
      return presence();
    }
    if (m.type === 'leave') { leaveRoom(); return presence(); }
    if (!r) return;
    const ri = db.prepare('SELECT owner, control FROM rooms WHERE id = ?').get(ws.room);
    if (!ri) return;
    if (ri.control === 'owner' && ri.owner !== user.id && !user.admin) return ws.send(JSON.stringify({ type: 'error', code: 'perm', room: ws.room }));
    db.prepare('UPDATE rooms SET active_at = ? WHERE id = ?').run(Date.now(), ws.room);
    const pos = Math.max(0, +m.pos || 0);
    if (m.type === 'track') {
      const t = db.prepare('SELECT id, title FROM tracks WHERE id = ? AND uid = ?').get(+m.id, user.id);
      if (!t) return;
      Object.assign(r, { track: t, playing: false, pos: 0 });
    } else if (!r.track) return;
    else if (m.type === 'play') Object.assign(r, { playing: true, pos, at: Date.now() });
    else if (m.type === 'pause') Object.assign(r, { playing: false, pos });
    else if (m.type === 'seek') Object.assign(r, { pos, at: Date.now() });
    else return;
    push(r);
  });
  ws.on('close', () => { leaveRoom(); presence(); });
  presence();
});
// Раз в 4 секунды подправляем позицию у всех, чтобы не накапливался сдвиг
setInterval(() => live.forEach((r) => r.playing && r.clients.size && push(r)), 4000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('VYBE запущен: http://localhost:' + PORT));
