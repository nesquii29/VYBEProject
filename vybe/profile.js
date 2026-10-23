// Профиль VYBE: проверка вводимых данных, проверка изображений по содержимому, правила видимости и хранилище.
// Модуль не зависит от Express, поэтому его можно проверять тестами отдельно.
const GENRES = ['hip-hop', 'rap', 'pop', 'electronic', 'rock', 'indie', 'rnb', 'jazz', 'ambient', 'classical', 'metal', 'alternative', 'other'];
const PRESETS = { listening: '🎧 Слушаю музыку', late: '🌙 Поздний вайб', gaming: '🎮 Играю', studying: '📚 Учусь', away: '💤 Отошёл', thoughts: '💭 Задумался', available: '✨ На связи', dnd: '🔕 Не беспокоить' };
const ACCENTS = { lavender: '#9AA5FF', blue: '#6FA8FF', mint: '#6FD0A8', pink: '#F08DB2', amber: '#F0B35C', rose: '#E87979' };
const STYLES = ['minimal', 'midnight', 'artist'];
const VIS = ['everyone', 'friends', 'me'];
const LIMITS = { name: 32, bio: 160, status: 60, genres: 5, favorites: 10, avatar: 5 * 1024 * 1024, banner: 8 * 1024 * 1024, maxDim: 4096, minDim: 32 };
const MEDIA_RE = /^[a-f0-9]{24}\.(jpg|png|webp)$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const luminance = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const statusActive = (until, now) => until == null || until > now; // истёкший статус не показывается, в том числе после перезапуска
const canSee = (vis, rel) => rel === 'me' || vis === 'everyone' || (vis === 'friends' && rel === 'friend'); // rel: me | friend | other

// Проверяем только присланные поля; возвращаем значения, готовые для записи в БД
function validate(b, now = Date.now()) {
  b = b || {};
  const v = {};
  if ('display_name' in b) {
    const s = String(b.display_name ?? '').replace(/\s+/g, ' ').trim();
    if (!s || s.length > LIMITS.name || CONTROL.test(s)) return { error: `Имя: от 1 до ${LIMITS.name} символов, без служебных символов` };
    v.display_name = s;
  }
  if ('bio' in b) {
    const s = String(b.bio ?? '').replace(/\r\n/g, '\n').trim();
    if (s.length > LIMITS.bio || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(s)) return { error: `О себе: не больше ${LIMITS.bio} символов` };
    v.bio = s;
  }
  if ('status' in b) {
    if (b.status === null) { v.status_text = null; v.status_until = null; }
    else {
      const st = b.status || {};
      const text = st.preset ? PRESETS[st.preset] : String(st.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > LIMITS.status || CONTROL.test(text)) return { error: `Статус: от 1 до ${LIMITS.status} символов или готовый вариант` };
      const h = +st.hours || 0;
      if (![0, 1, 8, 24].includes(h)) return { error: 'Неверная длительность статуса' };
      v.status_text = text;
      v.status_until = h ? now + h * 3600000 : null;
    }
  }
  if ('accent' in b) {
    const a = String(b.accent ?? '');
    const hex = ACCENTS[a] || (/^#[0-9a-fA-F]{6}$/.test(a) ? a.toUpperCase() : null);
    if (!hex) return { error: 'Неверный цвет' };
    if (luminance(hex) < 0.2) return { error: 'Цвет слишком тёмный: текст на нём будет трудно читать' };
    v.accent = hex;
  }
  if ('style' in b) { if (!STYLES.includes(b.style)) return { error: 'Неверный стиль профиля' }; v.style = b.style; }
  if ('genres' in b) {
    const g = b.genres;
    if (!Array.isArray(g) || g.length > LIMITS.genres || new Set(g).size !== g.length || g.some((x) => !GENRES.includes(x))) return { error: `Жанры: до ${LIMITS.genres} из списка` };
    v.genres = g.join(',');
  }
  for (const k of ['bio', 'genres', 'tracks', 'featured', 'activity']) {
    if (('vis_' + k) in b) { if (!VIS.includes(b['vis_' + k])) return { error: 'Неверная настройка приватности' }; v['vis_' + k] = b['vis_' + k]; }
  }
  return { v };
}

function validateFavorites(list, featured, owned) {
  if (!Array.isArray(list) || list.length > LIMITS.favorites) return { error: `Избранное: не больше ${LIMITS.favorites} треков` };
  const ids = list.map(Number);
  if (ids.some((x) => !Number.isInteger(x)) || new Set(ids).size !== ids.length) return { error: 'Неверный список треков' };
  if (ids.some((x) => !owned.has(x))) return { error: 'Можно добавлять только треки из своей библиотеки' };
  const f = featured == null ? null : Number(featured);
  if (f !== null && !ids.includes(f)) return { error: 'Избранный трек должен быть в списке избранного' };
  return { ids, featured: f };
}

// Тип и размеры изображения определяются по содержимому файла, а не по расширению или MIME от браузера
function imageInfo(b) {
  if (b.length > 30 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.toString('latin1', 12, 16) === 'IHDR')
    return { type: 'png', ext: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { type: 'jpeg', ext: 'jpg', h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return null;
  }
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const k = b.toString('latin1', 12, 16);
    if (k === 'VP8 ') return { type: 'webp', ext: 'webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (k === 'VP8L') { const x = b.readUInt32LE(21); return { type: 'webp', ext: 'webp', w: (x & 0x3fff) + 1, h: ((x >> 14) & 0x3fff) + 1 }; }
    if (k === 'VP8X') return { type: 'webp', ext: 'webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
  }
  return null;
}
function checkImage(buf, kind) {
  if (buf.length > LIMITS[kind]) return { error: `Файл больше ${LIMITS[kind] / 1048576} МБ` };
  const info = imageInfo(buf);
  if (!info) return { error: 'Допустимы только изображения JPEG, PNG или WebP' };
  if (info.w < LIMITS.minDim || info.h < LIMITS.minDim || info.w > LIMITS.maxDim || info.h > LIMITS.maxDim) return { error: `Размер изображения: от ${LIMITS.minDim} до ${LIMITS.maxDim} пикселей по каждой стороне` };
  return { info };
}

// ---------- Хранилище (better-sqlite3 или node:sqlite) ----------
const DEFAULTS = { display_name: null, bio: '', status_text: null, status_until: null, accent: ACCENTS.lavender, style: 'minimal', genres: '', avatar: null, banner: null, featured: null, vis_bio: 'everyone', vis_genres: 'everyone', vis_tracks: 'everyone', vis_featured: 'everyone', vis_activity: 'friends' };
const COLS = Object.keys(DEFAULTS);
function profileStore(db) {
  const q = (s) => db.prepare(s);
  const tx = (fn) => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const ensure = (uid) => q('INSERT OR IGNORE INTO profiles(uid) VALUES(?)').run(uid);
  return {
    get(uid) { return { ...DEFAULTS, ...(q('SELECT * FROM profiles WHERE uid = ?').get(uid) || {}) }; },
    update(uid, v) {
      const keys = Object.keys(v).filter((k) => COLS.includes(k)); // имена колонок только из белого списка
      if (!keys.length) return;
      tx(() => { ensure(uid); q('UPDATE profiles SET ' + keys.map((k) => k + ' = ?').join(', ') + ' WHERE uid = ?').run(...keys.map((k) => v[k]), uid); });
    },
    setMedia(uid, kind, name) {
      const old = this.get(uid)[kind];
      tx(() => { ensure(uid); q('UPDATE profiles SET ' + (kind === 'avatar' ? 'avatar' : 'banner') + ' = ? WHERE uid = ?').run(name, uid); });
      return old;
    },
    favorites(uid) { return q('SELECT track FROM profile_favorites WHERE uid = ? ORDER BY pos').all(uid).map((x) => x.track); },
    setFavorites(uid, ids, featured) {
      tx(() => {
        ensure(uid);
        q('DELETE FROM profile_favorites WHERE uid = ?').run(uid);
        ids.forEach((t, i) => q('INSERT INTO profile_favorites(uid, track, pos) VALUES(?, ?, ?)').run(uid, t, i));
        q('UPDATE profiles SET featured = ? WHERE uid = ?').run(featured, uid);
      });
    },
    removeTrack(trackId) { q('DELETE FROM profile_favorites WHERE track = ?').run(trackId); q('UPDATE profiles SET featured = NULL WHERE featured = ?').run(trackId); },
    removeUser(uid) { q('DELETE FROM profile_favorites WHERE uid = ?').run(uid); q('DELETE FROM profiles WHERE uid = ?').run(uid); },
  };
}

module.exports = { GENRES, PRESETS, ACCENTS, STYLES, VIS, LIMITS, MEDIA_RE, DEFAULTS, luminance, statusActive, canSee, validate, validateFavorites, imageInfo, checkImage, profileStore };
