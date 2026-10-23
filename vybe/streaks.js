// VYBE Streaks: серия дней, в которые двое друзей вместе слушали музыку.
// Модуль не зависит от Express и WebSocket: на вход получает «снимки» комнат от сервера и часы,
// поэтому его можно проверять детерминированными тестами.
// Правила: сутки считаются по UTC; день засчитывается, когда пара суммарно набрала THRESHOLD_MS
// совместного прослушивания (оба в одной комнате, где по данным сервера играет музыка).
const THRESHOLD_MS = 10 * 60 * 1000;
const MAX_GAP_MS = 30 * 1000; // сколько времени между двумя замерами можно засчитать (защита от простоев сервера)
const MILESTONES = [3, 7, 14, 30, 100];

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayNum = (d) => Math.round(Date.parse(d + 'T00:00:00Z') / 86400000);
const pair = (x, y) => (x < y ? [x, y] : [y, x]); // каноническая пара: (A,B) и (B,A) — одна серия

// Серия считается по списку засчитанных дней: он и есть источник истины
function compute(days) {
  const nums = [...new Set(days)].sort().map(dayNum);
  let longest = 0, run = 0;
  nums.forEach((n, i) => { run = i && n === nums[i - 1] + 1 ? run + 1 : 1; longest = Math.max(longest, run); });
  const last = days.length ? [...new Set(days)].sort().pop() : null;
  return { current: nums.length ? run : 0, longest, last };
}
// Серия «жива» только если последний общий день сегодня или вчера, иначе она прервана
const shown = (st, today) => (st && st.last && dayNum(today) - dayNum(st.last) <= 1 ? st.current : 0);

// ---------- Хранилища ----------
function memoryStore() {
  const days = new Map(), prog = new Map(), states = new Map();
  const k = (a, b) => pair(a, b).join(':');
  return {
    getProgress: (a, b, d) => prog.get(k(a, b) + ':' + d) || 0,
    saveProgress: (a, b, d, ms) => prog.set(k(a, b) + ':' + d, ms),
    hasDay: (a, b, d) => (days.get(k(a, b)) || new Set()).has(d),
    addDay(a, b, d) {
      const s = days.get(k(a, b)) || new Set();
      const isNew = !s.has(d);
      s.add(d); days.set(k(a, b), s);
      const state = compute([...s]);
      states.set(k(a, b), state);
      return { isNew, state };
    },
    getState: (a, b) => states.get(k(a, b)) || null,
    days: (a, b, n) => [...(days.get(k(a, b)) || [])].sort().reverse().slice(0, n),
    remove(a, b) { days.delete(k(a, b)); states.delete(k(a, b)); [...prog.keys()].filter((x) => x.startsWith(k(a, b) + ':')).forEach((x) => prog.delete(x)); },
    pruneProgress(d) { [...prog.keys()].filter((x) => x.split(':')[2] < d).forEach((x) => prog.delete(x)); },
  };
}

// SQLite (better-sqlite3 или node:sqlite): таблицы создаёт миграция в server.js
function sqliteStore(db) {
  const q = (sql) => db.prepare(sql);
  return {
    getProgress(a, b, d) { [a, b] = pair(a, b); const r = q('SELECT ms FROM streak_progress WHERE a = ? AND b = ? AND day = ?').get(a, b, d); return r ? r.ms : 0; },
    saveProgress(a, b, d, ms) { [a, b] = pair(a, b); q('INSERT INTO streak_progress(a, b, day, ms) VALUES(?, ?, ?, ?) ON CONFLICT(a, b, day) DO UPDATE SET ms = excluded.ms').run(a, b, d, ms); },
    hasDay(a, b, d) { [a, b] = pair(a, b); return !!q('SELECT 1 FROM streak_days WHERE a = ? AND b = ? AND day = ?').get(a, b, d); },
    addDay(a, b, d) {
      [a, b] = pair(a, b);
      const isNew = q('INSERT OR IGNORE INTO streak_days(a, b, day) VALUES(?, ?, ?)').run(a, b, d).changes > 0; // уникальный ключ: день засчитывается один раз
      const state = compute(q('SELECT day FROM streak_days WHERE a = ? AND b = ?').all(a, b).map((x) => x.day));
      q('INSERT INTO streaks(a, b, current, longest, last_day) VALUES(?, ?, ?, ?, ?) ON CONFLICT(a, b) DO UPDATE SET current = excluded.current, longest = excluded.longest, last_day = excluded.last_day').run(a, b, state.current, state.longest, state.last);
      return { isNew, state };
    },
    getState(a, b) { [a, b] = pair(a, b); const r = q('SELECT current, longest, last_day FROM streaks WHERE a = ? AND b = ?').get(a, b); return r ? { current: r.current, longest: r.longest, last: r.last_day } : null; },
    days(a, b, n) { [a, b] = pair(a, b); return q('SELECT day FROM streak_days WHERE a = ? AND b = ? ORDER BY day DESC LIMIT ?').all(a, b, n).map((x) => x.day); },
    remove(a, b) { [a, b] = pair(a, b); ['streaks', 'streak_days', 'streak_progress'].forEach((t) => q('DELETE FROM ' + t + ' WHERE a = ? AND b = ?').run(a, b)); },
    pruneProgress(d) { q('DELETE FROM streak_progress WHERE day < ?').run(d); },
  };
}

// ---------- Накопление времени ----------
function createTracker({ store, now = Date.now, thresholdMs = THRESHOLD_MS, maxGapMs = MAX_GAP_MS, onQualify = () => {} }) {
  let last = null;
  const acc = new Map(), dirty = new Set(), done = new Set();
  const key = (a, b, d) => pair(a, b).join(':') + ':' + d;

  function credit(a, b, day, dt) {
    const k = key(a, b, day);
    if (done.has(k)) return;
    if (store.hasDay(a, b, day)) { done.add(k); return; }
    const ms = (acc.has(k) ? acc.get(k) : store.getProgress(a, b, day)) + dt;
    acc.set(k, ms); dirty.add(k);
    if (ms >= thresholdMs) {
      const r = store.addDay(a, b, day);
      done.add(k);
      if (r.isNew) onQualify(...pair(a, b), day, r.state);
    }
  }

  // rooms: [{ room, playing, users: [uid, ...] }] — состояние, наблюдаемое сервером прямо сейчас
  function tick(rooms, areFriends) {
    const t = now(), dt = last === null ? 0 : Math.min(Math.max(t - last, 0), maxGapMs);
    last = t;
    if (!dt) return;
    const day = utcDay(t), seen = new Set();
    for (const r of rooms) {
      if (!r.playing) continue;
      const u = [...new Set(r.users)].sort((x, y) => x - y); // несколько вкладок одного аккаунта считаются один раз
      for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) {
        const pk = u[i] + ':' + u[j];
        if (seen.has(pk)) continue; // одна пара получает время один раз за замер, даже если они вместе в нескольких комнатах
        seen.add(pk);
        if (areFriends(u[i], u[j])) credit(u[i], u[j], day, dt);
      }
    }
  }
  function flush() {
    dirty.forEach((k) => { const [a, b, d] = k.split(':'); store.saveProgress(+a, +b, d, acc.get(k)); });
    dirty.clear();
    store.pruneProgress(utcDay(now() - 2 * 86400000));
    [...acc.keys()].filter((k) => k.split(':')[2] < utcDay(now() - 2 * 86400000)).forEach((k) => { acc.delete(k); done.delete(k); });
  }
  const progress = (a, b, d) => { const k = key(a, b, d); return acc.has(k) ? acc.get(k) : store.getProgress(a, b, d); };
  function forget(a, b) { const p = pair(a, b).join(':') + ':'; [acc, dirty, done].forEach((c) => [...c.keys ? c.keys() : c].filter((k) => k.startsWith(p)).forEach((k) => c.delete(k))); }
  return { tick, flush, progress, forget };
}

module.exports = { THRESHOLD_MS, MAX_GAP_MS, MILESTONES, utcDay, dayNum, pair, compute, shown, memoryStore, sqliteStore, createTracker };
