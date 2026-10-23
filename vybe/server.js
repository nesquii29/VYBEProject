const express = require('express'), http = require('http'), crypto = require('crypto');
const path = require('path'), fs = require('fs');
const streaks = require('./streaks');
const profile = require('./profile');
const Database = require('better-sqlite3'), multer = require('multer');
const { WebSocketServer } = require('ws');

// ---------- База данных (SQLite) и папка для mp3 ----------
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROFILE_DIR = path.join(DATA, 'profile');
fs.mkdirSync(PROFILE_DIR, { recursive: true });
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

if (db.pragma('user_version', { simple: true }) < 2) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS room_queue(id INTEGER PRIMARY KEY AUTOINCREMENT, room INTEGER NOT NULL, track INTEGER NOT NULL, uid INTEGER NOT NULL, pos INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS room_queue_room ON room_queue(room, pos);
    `);
    db.pragma('user_version = 2');
  })();
}

if (db.pragma('user_version', { simple: true }) < 3) {
  db.transaction(() => {
    db.exec(`
      ALTER TABLE tracks ADD COLUMN source TEXT NOT NULL DEFAULT 'upload';
      ALTER TABLE tracks ADD COLUMN url TEXT;
      ALTER TABLE tracks ADD COLUMN artist TEXT;
      ALTER TABLE tracks ADD COLUMN art TEXT;
    `);
    db.pragma('user_version = 3');
  })();
}

if (db.pragma('user_version', { simple: true }) < 4) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS room_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, room INTEGER NOT NULL, uid INTEGER NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS room_messages_room ON room_messages(room, id);
      CREATE INDEX IF NOT EXISTS rooms_vis ON rooms(visibility, active_at);
    `);
    db.pragma('user_version = 4');
  })();
}

if (db.pragma('user_version', { simple: true }) < 5) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS streaks(a INTEGER NOT NULL, b INTEGER NOT NULL, current INTEGER NOT NULL DEFAULT 0, longest INTEGER NOT NULL DEFAULT 0, last_day TEXT, PRIMARY KEY(a, b), CHECK(a < b));
      CREATE TABLE IF NOT EXISTS streak_days(a INTEGER NOT NULL, b INTEGER NOT NULL, day TEXT NOT NULL, PRIMARY KEY(a, b, day), CHECK(a < b));
      CREATE TABLE IF NOT EXISTS streak_progress(a INTEGER NOT NULL, b INTEGER NOT NULL, day TEXT NOT NULL, ms INTEGER NOT NULL, PRIMARY KEY(a, b, day), CHECK(a < b));
      CREATE INDEX IF NOT EXISTS streaks_b ON streaks(b);
      CREATE INDEX IF NOT EXISTS streak_days_b ON streak_days(b);
    `);
    db.pragma('user_version = 5');
  })();
}

if (db.pragma('user_version', { simple: true }) < 6) {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS profiles(uid INTEGER PRIMARY KEY, display_name TEXT, bio TEXT NOT NULL DEFAULT '', status_text TEXT, status_until INTEGER,
        accent TEXT NOT NULL DEFAULT '#9AA5FF', style TEXT NOT NULL DEFAULT 'minimal', genres TEXT NOT NULL DEFAULT '', avatar TEXT, banner TEXT, featured INTEGER,
        vis_bio TEXT NOT NULL DEFAULT 'everyone', vis_genres TEXT NOT NULL DEFAULT 'everyone', vis_tracks TEXT NOT NULL DEFAULT 'everyone',
        vis_featured TEXT NOT NULL DEFAULT 'everyone', vis_activity TEXT NOT NULL DEFAULT 'friends');
      CREATE TABLE IF NOT EXISTS profile_favorites(id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, track INTEGER NOT NULL, pos INTEGER NOT NULL, UNIQUE(uid, track));
      CREATE INDEX IF NOT EXISTS profile_favorites_uid ON profile_favorites(uid, pos);
      CREATE INDEX IF NOT EXISTS profile_favorites_track ON profile_favorites(track);
    `);
    db.pragma('user_version = 6');
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
const room = (id) => live.get(id) || live.set(id, { track: null, by: null, seq: 0, ver: 0, dur: 0, playing: false, pos: 0, at: 0, clients: new Set() }).get(id);
const posNow = (r) => (r.playing ? r.pos + (Date.now() - r.at) / 1000 : r.pos);
const push = (r) => {
  const m = JSON.stringify({ type: 'state', ver: ++r.ver, seq: r.seq, by: r.by, dur: r.dur, track: r.track, playing: r.playing, pos: posNow(r), users: uids(r).size, names: [...new Set([...r.clients].map((c) => c.uname))] });
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

const media = (n) => (n ? '/media/' + n : null);
const brief = (uid) => { const p = pstore.get(uid); return { display_name: p.display_name || null, avatar: media(p.avatar), custom_status: profile.statusActive(p.status_until, Date.now()) ? p.status_text : null }; };
app.get('/api/me', (req, res) => { const u = userOf(req); res.json(u ? { ...u, ...brief(u.id) } : null); });

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

app.get('/api/home', auth, (req, res) => {
  const now = Date.now();
  const rows = db.prepare(ROOM_SQL + " WHERE r.visibility = 'public'").all().map((r) => {
    const lr = live.get(r.id), online = lr ? uids(lr).size : 0, playing = !!(lr && lr.playing && lr.track && online);
    const hours = (now - r.active_at) / 3600000;
    return {
      id: r.id, name: r.name, owner: r.owner_name, oid: r.owner, online, playing, max: r.max_users, active: r.active_at,
      track: lr && lr.track ? { title: lr.track.title, artist: lr.track.artist, art: lr.track.art, source: lr.track.source } : null,
      // понятный рейтинг: слушатели важнее всего, затем «музыка играет», затем свежая активность
      score: online * 10 + (playing ? 5 : 0) + (hours < 1 ? 3 : hours < 24 ? 1 : 0),
    };
  });
  const listening = rows.filter((r) => r.playing).sort((a, b) => b.online - a.online).slice(0, 8);
  let popular = rows.filter((r) => r.online > 0).sort((a, b) => b.score - a.score || b.active - a.active).slice(0, 8);
  const kind = popular.length ? 'score' : 'recent';
  if (!popular.length) popular = rows.filter((r) => r.active > 0).sort((a, b) => b.active - a.active).slice(0, 8);
  res.json({ listening, popular, kind });
});

app.delete('/api/rooms/:id', auth, (req, res) => {
  const id = +req.params.id;
  const r = db.prepare('SELECT * FROM rooms WHERE id = ?').get(id);
  if (r && (req.user.admin || r.owner === req.user.id)) {
    db.prepare('DELETE FROM rooms WHERE id = ?').run(id);
    db.prepare('DELETE FROM room_members WHERE room = ?').run(id);
    db.prepare('DELETE FROM room_queue WHERE room = ?').run(id);
    db.prepare('DELETE FROM room_messages WHERE room = ?').run(id);
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
    return { ...u, ...brief(u.id), status: f.status, dir: f.a === me ? 'out' : 'in', online: socks.length > 0, room: rm || null };
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
  const [sa, sb] = streaks.pair(me, id);
  store.remove(sa, sb);
  tracker.forget(sa, sb);
  presence();
  res.json({});
});

// ---------- Серии прослушивания (только чтение: значения вычисляет сервер) ----------
const streakView = (me, f) => {
  const [a, b] = streaks.pair(me, f), st = store.getState(a, b) || { current: 0, longest: 0, last: null }, today = streaks.utcDay(Date.now());
  return { id: f, current: streaks.shown(st, today), longest: st.longest, last: st.last, today: st.last === today, progress: Math.min(10, Math.floor(tracker.progress(a, b, today) / 60000)) };
};
app.get('/api/streaks', auth, (req, res) => {
  const me = req.user.id;
  res.json(db.prepare("SELECT CASE WHEN a = ? THEN b ELSE a END AS f FROM friends WHERE status = 'ok' AND (a = ? OR b = ?)").all(me, me, me).map((x) => streakView(me, x.f)));
});
app.get('/api/streaks/:id', auth, (req, res) => {
  const me = req.user.id, f = +req.params.id;
  if (!f || f === me || !areFriends(me, f)) return res.status(404).json({ error: 'Серия не найдена' }); // чужие данные не раскрываются
  const [a, b] = streaks.pair(me, f);
  res.json({ ...streakView(me, f), days: store.days(a, b, 14), rules: { minutes: 10, milestones: streaks.MILESTONES } });
});

// ---------- Профиль ----------
const imgUp = multer({ storage: multer.memoryStorage(), limits: { fileSize: profile.LIMITS.banner, files: 1 } }).single('file');
const imageUpload = (req, res, next) => imgUp(req, res, (e) => (e ? res.status(e.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: e.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой' : 'Не удалось загрузить файл' }) : next()));
const unlinkMedia = (n) => { if (n && profile.MEDIA_RE.test(n)) fs.unlink(path.join(PROFILE_DIR, n), () => {}); };
function pushProfile(uid) { // клиентам уходит только «профиль изменился»: данные они запрашивают через API с проверкой прав
  const ids = new Set([uid, ...db.prepare("SELECT CASE WHEN a = ? THEN b ELSE a END AS f FROM friends WHERE status = 'ok' AND (a = ? OR b = ?)").all(uid, uid, uid).map((x) => x.f)]);
  const m = JSON.stringify({ type: 'profile', id: uid });
  wss.clients.forEach((c) => c.readyState === 1 && ids.has(c.uid) && c.send(m));
}

app.get('/media/:name', auth, (req, res) => {
  if (!profile.MEDIA_RE.test(req.params.name)) return res.sendStatus(404);
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.type(path.extname(req.params.name)).sendFile(path.join(PROFILE_DIR, req.params.name), (e) => { if (e && !res.headersSent) res.sendStatus(404); });
});

app.get('/api/profile/:id', auth, (req, res) => {
  const me = req.user.id, id = req.params.id === 'me' ? me : +req.params.id;
  const u = id && db.prepare('SELECT id, name, tag FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Пользователь не найден' });
  const p = pstore.get(id), rel = id === me ? 'me' : areFriends(me, id) ? 'friend' : 'other', can = (k) => profile.canSee(p['vis_' + k], rel);
  const live = profile.statusActive(p.status_until, Date.now());
  const out = { id, name: u.name, tag: u.tag, display_name: p.display_name || u.name, avatar: media(p.avatar), banner: media(p.banner), accent: p.accent, style: p.style, rel,
    status: live ? p.status_text : null, online: rel !== 'other' && online(id).length > 0 };
  if (rel === 'me') Object.assign(out, { vis: { bio: p.vis_bio, genres: p.vis_genres, tracks: p.vis_tracks, featured: p.vis_featured, activity: p.vis_activity }, status_until: live ? p.status_until : null });
  if (can('bio')) out.bio = p.bio;
  if (can('genres')) out.genres = p.genres ? p.genres.split(',') : [];
  if (can('tracks') || can('featured')) {
    const ids = pstore.favorites(id), rows = ids.length ? db.prepare('SELECT id, title, source, artist, art, url, file FROM tracks WHERE id IN (' + ids.map(() => '?').join(',') + ')').all(...ids) : [];
    const by = new Map(rows.map((t) => [t.id, t]));
    const favs = ids.map((i) => by.get(i)).filter((t) => t && (t.source !== 'upload' || rel === 'me')) // чужие MP3 никогда не показываются: доступ к ним остаётся только у владельца
      .map((t) => ({ id: t.id, title: t.title, source: t.source, artist: t.artist, art: t.art, url: t.source === 'soundcloud' ? t.url : null, unavailable: t.source === 'upload' && !(t.file && fs.existsSync(path.join(UP, t.file))) }));
    if (can('tracks')) out.tracks = favs;
    if (can('featured')) out.featured = favs.find((t) => t.id === p.featured) || null;
  }
  if (can('activity')) {
    const rc = online(id).find((c) => c.room), row = rc && db.prepare('SELECT * FROM rooms WHERE id = ?').get(rc.room);
    if (!rc) out.activity = { state: 'idle' };
    else if (row && canAccess(row, req.user)) { // название и состояние комнаты раскрываются только тем, кто имеет в неё доступ
      const lr = live_(row.id);
      out.activity = { state: 'room', room: { id: row.id, name: row.name }, playing: !!(lr && lr.playing && lr.track), track: lr && lr.track ? { title: lr.track.title, artist: lr.track.artist, source: lr.track.source } : null };
    }
  }
  if (rel === 'friend') out.streak = streakView(me, id);
  res.json(out);
});

app.put('/api/profile', auth, (req, res) => {
  const r = profile.validate(req.body, Date.now());
  if (r.error) return res.status(400).json({ error: r.error });
  pstore.update(req.user.id, r.v);
  pushProfile(req.user.id);
  res.json({ ok: true });
});

app.put('/api/profile/favorites', auth, (req, res) => {
  const b = req.body || {};
  const owned = new Set(db.prepare('SELECT id FROM tracks WHERE uid = ?').all(req.user.id).map((x) => x.id));
  const r = profile.validateFavorites(b.tracks, b.featured, owned);
  if (r.error) return res.status(400).json({ error: r.error });
  pstore.setFavorites(req.user.id, r.ids, r.featured);
  pushProfile(req.user.id);
  res.json({ ok: true });
});

app.put('/api/profile/:kind(avatar|banner)', auth, imageUpload, (req, res) => {
  const kind = req.params.kind;
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  const r = profile.checkImage(req.file.buffer, kind); // тип проверяется по содержимому, имя и MIME от браузера игнорируются
  if (r.error) return res.status(400).json({ error: r.error });
  const name = crypto.randomBytes(12).toString('hex') + '.' + r.info.ext; // имя выбирает сервер
  try { fs.writeFileSync(path.join(PROFILE_DIR, name), req.file.buffer, { flag: 'wx' }); } catch { return res.status(500).json({ error: 'Не удалось сохранить файл' }); }
  unlinkMedia(pstore.setMedia(req.user.id, kind, name)); // старый файл удаляется только после успешной записи нового
  pushProfile(req.user.id);
  res.json({ [kind]: media(name) });
});
app.delete('/api/profile/:kind(avatar|banner)', auth, (req, res) => {
  unlinkMedia(pstore.setMedia(req.user.id, req.params.kind, null));
  pushProfile(req.user.id);
  res.json({ ok: true });
});

// ---------- Админка ----------
const adminOnly = (req, res, next) => (req.user.admin ? next() : res.sendStatus(403));
app.get('/api/users', auth, adminOnly, (req, res) => res.json(db.prepare('SELECT id, name, admin FROM users ORDER BY id').all()));
app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить себя' });
  db.prepare('SELECT file FROM tracks WHERE uid = ?').all(id).forEach((t) => t.file && fs.unlink(path.join(UP, t.file), () => {}));
  db.prepare('DELETE FROM room_queue WHERE uid = ? OR track IN (SELECT id FROM tracks WHERE uid = ?) OR room IN (SELECT id FROM rooms WHERE owner = ?)').run(id, id, id);
  db.prepare('DELETE FROM room_messages WHERE uid = ? OR room IN (SELECT id FROM rooms WHERE owner = ?)').run(id, id);
  const pr = pstore.get(id);
  [pr.avatar, pr.banner].forEach((n) => { if (n && profile.MEDIA_RE.test(n)) fs.unlink(path.join(PROFILE_DIR, n), () => {}); });
  db.prepare('SELECT id FROM tracks WHERE uid = ?').all(id).forEach((x) => pstore.removeTrack(x.id));
  pstore.removeUser(id);
  db.prepare('DELETE FROM tracks WHERE uid = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE uid = ?').run(id);
  db.prepare('DELETE FROM friends WHERE a = ? OR b = ?').run(id, id);
  ['streaks', 'streak_days', 'streak_progress'].forEach((t) => db.prepare('DELETE FROM ' + t + ' WHERE a = ? OR b = ?').run(id, id));
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
  res.json(db.prepare('SELECT id, title, source, artist, art, url FROM tracks WHERE uid = ? ORDER BY id DESC').all(req.user.id));
});

app.post('/api/tracks', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Нужен файл .mp3 до 20 МБ' });
  const title = Buffer.from(req.file.originalname, 'latin1').toString('utf8').replace(/\.mp3$/i, '').slice(0, 80);
  const id = db.prepare('INSERT INTO tracks(uid, title, file) VALUES(?, ?, ?)').run(req.user.id, title, req.file.filename).lastInsertRowid;
  res.json({ id, title });
});

const SC_HOST = /^(www\.|m\.)?soundcloud\.com$/;
app.post('/api/soundcloud', auth, async (req, res) => {
  let u;
  try { u = new URL(String((req.body || {}).url || '').trim()); } catch { return res.status(400).json({ error: 'Это не похоже на ссылку' }); }
  if (u.protocol !== 'https:' || !SC_HOST.test(u.hostname)) return res.status(400).json({ error: 'Нужна ссылка на soundcloud.com (https)' });
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || parts[1] === 'sets') return res.status(400).json({ error: 'Плейлисты и профили пока не поддерживаются. Вставьте ссылку на конкретный трек.' });
  const clean = 'https://soundcloud.com/' + parts.slice(0, 2).join('/');
  const have = db.prepare('SELECT id, title, source, artist, art, url FROM tracks WHERE uid = ? AND url = ?').get(req.user.id, clean);
  if (have) return res.json(have);
  let d;
  try {
    const r = await fetch('https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(clean), { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return res.status(404).json({ error: 'SoundCloud не нашёл этот трек: он приватный, удалён или недоступен для встраивания' });
    d = await r.json();
  } catch { return res.status(502).json({ error: 'Не удалось связаться с SoundCloud. Попробуйте позже.' }); }
  const artist = String(d.author_name || '').slice(0, 80);
  let title = String(d.title || '').slice(0, 120);
  if (artist && title.endsWith(' by ' + artist)) title = title.slice(0, -(artist.length + 4));
  let art = null;
  try { const a = new URL(d.thumbnail_url); if (a.protocol === 'https:' && /(^|\.)sndcdn\.com$/.test(a.hostname)) art = a.href; } catch {}
  const id = db.prepare("INSERT INTO tracks(uid, title, file, source, url, artist, art) VALUES(?, ?, NULL, 'soundcloud', ?, ?, ?)").run(req.user.id, title || 'Без названия', clean, artist, art).lastInsertRowid;
  res.json({ id, title: title || 'Без названия', source: 'soundcloud', artist, art, url: clean });
});

app.delete('/api/tracks/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tracks WHERE id = ? AND uid = ?').get(+req.params.id, req.user.id);
  if (t) {
    db.prepare('DELETE FROM tracks WHERE id = ?').run(t.id);
    pstore.removeTrack(t.id);
    db.prepare('DELETE FROM room_queue WHERE track = ?').run(t.id);
    live.forEach((r, rid) => { if (r.track && r.track.id === t.id) advance(r, rid); });
    live.forEach((r, rid) => pushQueue(rid));
    if (t.file) fs.unlink(path.join(UP, t.file), () => {});
  }
  res.json({});
});

// Слушать трек может владелец или участники комнаты, где он сейчас играет
app.get('/audio/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tracks WHERE id = ?').get(+req.params.id);
  const inRoom = [...live.values()].some((r) => r.track && r.track.id === (t && t.id) && [...r.clients].some((c) => c.uid === req.user.id));
  if (!t || !t.file || (t.uid !== req.user.id && !inRoom)) return res.sendStatus(404);
  res.sendFile(path.join(UP, t.file));
});

// ---------- Очередь и переходы ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const presence = () => wss.clients.forEach((c) => c.readyState === 1 && c.send('{"type":"presence"}'));
const queueOf = (id) => db.prepare('SELECT q.id, q.track, q.uid, u.name AS by, t.title, t.source, t.artist FROM room_queue q JOIN tracks t ON t.id = q.track JOIN users u ON u.id = q.uid WHERE q.room = ? ORDER BY q.pos, q.id').all(id);
function pushQueue(id) {
  const r = live.get(id);
  if (!r) return;
  const m = JSON.stringify({ type: 'queue', items: queueOf(id) });
  r.clients.forEach((c) => c.readyState === 1 && c.send(m));
}
const chatRows = (room, before) => db.prepare('SELECT m.id, m.uid, u.name, m.text, m.created FROM room_messages m JOIN users u ON u.id = m.uid WHERE m.room = ?' + (before ? ' AND m.id < ?' : '') + ' ORDER BY m.id DESC LIMIT 50').all(...(before ? [room, before] : [room])).reverse();
const sendHistory = (ws, room, before) => { const items = chatRows(room, before); ws.send(JSON.stringify({ type: 'chat:history', room, items, older: !!before, more: items.length === 50 })); };
const chatRate = new Map(); // uid -> времена последних сообщений
const NEXT_SQL = 'SELECT q.id, q.track, q.uid, t.title, t.file, t.source, t.url, t.artist, t.art FROM room_queue q JOIN tracks t ON t.id = q.track WHERE q.room = ?';
// Единственное место, где меняется текущий трек. Каждый переход увеличивает seq,
// поэтому повторные сообщения «трек закончился» с прежним seq игнорируются.
function advance(r, id, entryId, autoplay = true) {
  let q = null;
  for (;;) {
    q = entryId ? db.prepare(NEXT_SQL + ' AND q.id = ?').get(id, entryId) : db.prepare(NEXT_SQL + ' ORDER BY q.pos, q.id LIMIT 1').get(id);
    if (!q || q.source !== 'upload' || fs.existsSync(path.join(UP, q.file))) break;
    db.prepare('DELETE FROM room_queue WHERE id = ?').run(q.id); // файла нет: пропускаем недоступный трек
    if (entryId) { q = null; break; }
  }
  if (entryId && !q) return;
  r.seq++;
  if (!q) Object.assign(r, { track: null, by: null, playing: false, pos: 0, dur: 0 });
  else {
    db.prepare('DELETE FROM room_queue WHERE id = ?').run(q.id);
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(q.uid);
    Object.assign(r, { track: { id: q.track, title: q.title, source: q.source, url: q.url, artist: q.artist, art: q.art }, by: u ? u.name : null, playing: autoplay, pos: 0, at: Date.now(), dur: 0 });
  }
  push(r);
  pushQueue(id);
}

// ---------- WebSocket: присутствие, синхронизация, очередь ----------
wss.on('connection', (ws, req) => {
  const user = userOf(req);
  if (!user) return ws.close();
  ws.uname = user.name;
  ws.uid = user.id;
  ws.room = null;
  let r = null;
  const leaveRoom = () => {
    if (!r) return;
    r.clients.delete(ws);
    if (!r.clients.size) { r.pos = posNow(r); r.playing = false; } // комната опустела: ставим на паузу
    push(r);
    r = null;
    ws.room = null;
  };
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string') return;
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
      pushQueue(id);
      sendHistory(ws, id);
      return presence();
    }
    if (m.type === 'leave') { leaveRoom(); return presence(); }
    if (!r) return;
    const id = ws.room;
    const ri = db.prepare('SELECT id, owner, control, visibility FROM rooms WHERE id = ?').get(id);
    if (!ri) return;
    const err = (code) => ws.send(JSON.stringify({ type: 'error', code, room: id }));
    const ctl = ri.owner === user.id || !!user.admin || ri.control === 'all'; // право управлять воспроизведением и очередью
    const pos = Math.max(0, +m.pos || 0);
    const touch = () => db.prepare('UPDATE rooms SET active_at = ? WHERE id = ?').run(Date.now(), id);
    switch (m.type) {
      case 'track': {
        if (!ctl) return err('perm');
        const t = db.prepare('SELECT id, title, source, url, artist, art FROM tracks WHERE id = ? AND uid = ?').get(+m.id, user.id);
        if (!t) return err('track');
        r.seq++;
        Object.assign(r, { track: t, by: user.name, playing: false, pos: 0, dur: 0 });
        touch();
        return push(r);
      }
      case 'play': case 'pause': case 'seek': {
        if (!ctl) return err('perm');
        if (!r.track) return;
        if (m.type === 'play') Object.assign(r, { playing: true, pos, at: Date.now() });
        else if (m.type === 'pause') Object.assign(r, { playing: false, pos });
        else Object.assign(r, { pos, at: Date.now() });
        touch();
        return push(r);
      }
      case 'chat:send': {
        const bad = (code) => ws.send(JSON.stringify({ type: 'chat:error', code, cid: m.cid }));
        const text = String(m.text || '').replace(/\r\n/g, '\n').trim();
        if (!canAccess(ri, user)) return bad('perm'); // доступ проверяется заново на каждое сообщение
        if (!text) return bad('empty');
        if (text.length > 500) return bad('long');
        const t0 = Date.now(), log = (chatRate.get(user.id) || []).filter((x) => t0 - x < 10000);
        if (log.length >= 6) return bad('rate');
        log.push(t0);
        chatRate.set(user.id, log);
        const mid = db.prepare('INSERT INTO room_messages(room, uid, text, created) VALUES(?, ?, ?, ?)').run(id, user.id, text, t0).lastInsertRowid;
        const out = JSON.stringify({ type: 'chat:message', room: id, id: mid, uid: user.id, name: user.name, text, created: t0, cid: m.cid });
        r.clients.forEach((c) => c.readyState === 1 && c.send(out));
        return touch();
      }
      case 'chat:older': if (!canAccess(ri, user)) return err('perm'); return sendHistory(ws, id, +m.before || 0);
      case 'skip': if (!ctl) return err('perm'); touch(); return advance(r, id);
      case 'qadd': {
        if (!ctl) return err('perm');
        const t = db.prepare('SELECT id FROM tracks WHERE id = ? AND uid = ?').get(+m.track, user.id);
        if (!t) return err('track');
        if (db.prepare('SELECT COUNT(*) c FROM room_queue WHERE room = ?').get(id).c >= 50) return err('qfull');
        if (db.prepare('SELECT COUNT(*) c FROM room_queue WHERE room = ? AND uid = ?').get(id, user.id).c >= 10) return err('qmine');
        db.prepare('INSERT INTO room_queue(room, track, uid, pos, created) VALUES(?, ?, ?, (SELECT COALESCE(MAX(pos), 0) + 1 FROM room_queue WHERE room = ?), ?)').run(id, t.id, user.id, id, Date.now());
        touch();
        return r.track ? pushQueue(id) : advance(r, id, null, false); // в пустой комнате трек становится текущим, на паузе
      }
      case 'qremove': {
        if (!ctl) return err('perm');
        db.prepare('DELETE FROM room_queue WHERE id = ? AND room = ?').run(+m.id, id);
        return pushQueue(id);
      }
      case 'qmove': {
        if (!ctl) return err('perm');
        const ids = queueOf(id).map((x) => x.id), from = ids.indexOf(+m.id), to = Math.max(0, Math.min(ids.length - 1, Math.floor(+m.to)));
        if (from < 0 || !(to >= 0)) return;
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        db.transaction(() => ids.forEach((qid, k) => db.prepare('UPDATE room_queue SET pos = ? WHERE id = ?').run(k + 1, qid)))();
        return pushQueue(id);
      }
      case 'qplay': if (!ctl) return err('perm'); touch(); return advance(r, id, +m.id, true);
      case 'meta': { // длительность трека сообщает клиент; принимаем первое правдоподобное значение
        const d = +m.dur;
        if (m.seq === r.seq && r.track && !r.dur && d > 1 && d < 10800) { r.dur = d; push(r); }
        return;
      }
      case 'ended': { // трек закончился: переход только один раз на каждый seq
        if (m.seq !== r.seq || !r.track) return;
        if (!ctl && !(r.dur && posNow(r) >= r.dur - 2)) return;
        return advance(r, id);
      }
      case 'failed': { // трек не загрузился: переходим дальше, только если файла действительно нет
        if (m.seq !== r.seq || !r.track) return;
        const t = db.prepare('SELECT file, source FROM tracks WHERE id = ?').get(r.track.id);
        if (t && t.source === 'upload' && fs.existsSync(path.join(UP, t.file))) return;
        if (t && t.source !== 'upload' && !ctl) return; // ошибку внешнего плеера проверить нельзя: принимаем только от управляющих
        return advance(r, id);
      }
    }
  });
  ws.on('close', () => { leaveRoom(); presence(); });
  presence();
});
// Резерв: если никто не прислал «трек закончился», сервер сам переходит дальше по длительности
setInterval(() => live.forEach((r, id) => { if (r.playing && r.track && r.dur && r.clients.size && posNow(r) > r.dur + 3) advance(r, id); }), 2000);
// Периодически обновляем опорную точку у клиентов
setInterval(() => live.forEach((r) => r.playing && r.clients.size && push(r)), 5000);

// ---------- Серии: накопление по наблюдаемому серверу состоянию комнат ----------
const store = streaks.sqliteStore(db);
const pstore = profile.profileStore(db);
const live_ = (id) => live.get(id);
const areFriends = (a, b) => !!db.prepare("SELECT 1 FROM friends WHERE status = 'ok' AND ((a = ? AND b = ?) OR (a = ? AND b = ?))").get(a, b, b, a);
const tracker = streaks.createTracker({
  store,
  onQualify: (a, b, day, st) => { // вызывается один раз на пару и день
    const milestone = streaks.MILESTONES.includes(st.current) ? st.current : 0;
    [[a, b], [b, a]].forEach(([u, o]) => {
      const name = db.prepare('SELECT name FROM users WHERE id = ?').get(o).name;
      wss.clients.forEach((c) => c.readyState === 1 && c.uid === u && c.send(JSON.stringify({ type: 'streak', with: o, name, current: st.current, longest: st.longest, milestone })));
    });
  },
});
setInterval(() => {
  try {
    tracker.tick([...live].map(([rid, r]) => ({ room: rid, users: [...uids(r)], playing: !!(r.playing && r.track && !(r.dur && posNow(r) > r.dur + 5)) })), areFriends);
  } catch (e) { console.error('streaks:', e); }
}, 15000);
setInterval(() => { try { tracker.flush(); } catch (e) { console.error('streaks flush:', e); } }, 60000);
process.on('SIGINT', () => { try { tracker.flush(); } catch {} process.exit(0); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('VYBE запущен: http://localhost:' + PORT));
