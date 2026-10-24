// Настройки интерфейса пользователя (тема, цвет интерфейса, анимации): проверка и хранение в аккаунте.
// Значения лежат в колонке profiles.prefs как JSON; неизвестные и неверные значения никогда не попадают в базу.
const OPTIONS = { theme: ['dark', 'light', 'system'], accent: ['default', 'calm', 'charge', 'night'], motion: ['system', 'reduce'] };
const DEFAULTS = { theme: 'dark', accent: 'default', motion: 'system' };

function normalize(raw) { // любой мусор превращается в допустимые настройки
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = OPTIONS[k].includes(o[k]) ? o[k] : DEFAULTS[k];
  return out;
}
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Неверные настройки' };
  const v = {};
  for (const [k, val] of Object.entries(body)) {
    if (!(k in DEFAULTS)) return { error: 'Неизвестная настройка: ' + String(k).slice(0, 30) };
    if (!OPTIONS[k].includes(val)) return { error: 'Недопустимое значение настройки «' + k + '»' };
    v[k] = val;
  }
  return Object.keys(v).length ? { v } : { error: 'Нет настроек для сохранения' };
}
function get(db, uid) { // null, если пользователь ещё ничего не сохранял
  const r = db.prepare('SELECT prefs FROM profiles WHERE uid = ?').get(uid);
  if (!r || !r.prefs) return null;
  try { return normalize(JSON.parse(r.prefs)); } catch { return null; }
}
function set(db, uid, v) { // частичное обновление: остальные настройки сохраняются
  const merged = normalize({ ...(get(db, uid) || DEFAULTS), ...v });
  db.prepare('INSERT OR IGNORE INTO profiles(uid) VALUES(?)').run(uid);
  db.prepare('UPDATE profiles SET prefs = ? WHERE uid = ?').run(JSON.stringify(merged), uid);
  return merged;
}
module.exports = { OPTIONS, DEFAULTS, normalize, validate, get, set };
