// Настройки интерфейса на клиенте: применение темы, цвета и анимаций; кэш на устройстве отдельно для каждого аккаунта.
export const ACCENT_COLORS = { default: null, calm: '#6C8BFF', charge: '#FF6B9A', night: '#A27BFF' };
export const DEFAULTS = { theme: 'dark', accent: 'default', motion: 'system' };
const OPTIONS = { theme: ['dark', 'light', 'system'], accent: Object.keys(ACCENT_COLORS), motion: ['system', 'reduce'] };

export function normalize(raw) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = OPTIONS[k].includes(o[k]) ? o[k] : DEFAULTS[k];
  return out;
}
export const resolveTheme = (theme, systemDark) => (theme === 'system' ? (systemDark ? 'dark' : 'light') : theme === 'light' ? 'light' : 'dark');

// Прежние настройки в localStorage: тема 'dark'/'light' и номер настроения 0–2
export function fromLegacy(theme, mood) {
  const accent = ['calm', 'charge', 'night'][mood === null || mood === undefined || mood === '' ? -1 : Number(mood)];
  const t = theme === 'dark' || theme === 'light' ? theme : null;
  return t || accent ? normalize({ theme: t || 'dark', accent: accent || 'default' }) : null;
}

// env: { root, systemDark() }. Возвращает снимок для мгновенной установки темы при следующей загрузке страницы
export function applyPrefs(p, env) {
  env.root.dataset.theme = resolveTheme(p.theme, env.systemDark());
  if (p.motion === 'reduce') env.root.dataset.motion = 'reduce'; else delete env.root.dataset.motion;
  const c = ACCENT_COLORS[p.accent];
  if (c) env.root.style.setProperty('--ac', c); else env.root.style.removeProperty('--ac');
  return { ...p, accentColor: c || null };
}

export const cacheKey = (uid) => 'vybe:prefs:' + uid;
export function loadCached(storage, uid) {
  try { const r = storage.getItem(cacheKey(uid)); return r ? normalize(JSON.parse(r)) : null; } catch { return null; }
}
export function saveCached(storage, uid, prefs, snap) {
  try { if (uid) storage.setItem(cacheKey(uid), JSON.stringify(prefs)); storage.setItem('vybe:snap', JSON.stringify(snap)); } catch {}
}
// Когда выбрана «Как в системе», тема следует за настройкой операционной системы
export function watchSystem(mq, getTheme, reapply) {
  const h = () => { if (getTheme() === 'system') reapply(); };
  mq.addEventListener('change', h);
  return () => mq.removeEventListener('change', h);
}
