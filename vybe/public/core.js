// Общее: состояние, запросы к API, WebSocket, иконки
export const S = { me: null, rooms: [], tracks: [], friends: [], cur: null, st: {}, q: [], sync: null };
export const $ = (s) => document.querySelector(s);
export const el = (tag, text, cls) => { const e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; };
export const canRoom = () => !!S.cur && (S.me.admin || S.me.id === S.cur.oid || S.cur.control === 'all'); // права в комнате
export const canControl = () => !!S.st.personal || canRoom(); // плюс личное прослушивание
export const fmt = (t) => (isFinite(t) ? Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0') : '0:00');

export async function api(url, method = 'GET', body) {
  const isForm = body instanceof FormData;
  const r = await fetch(url, {
    method,
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : {},
    body: isForm ? body : body && JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Ошибка');
  return d;
}

let ws = null;
export const send = (m) => { if (!ws || ws.readyState !== 1) return false; ws.send(JSON.stringify(m)); return true; };
export function connect(h) {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = h.open;
  ws.onmessage = (e) => h.msg(JSON.parse(e.data));
  ws.onclose = () => { if (h.close) h.close(); setTimeout(() => connect(h), 2000); };
}

const P = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  rooms: '<rect x="3" y="4" width="7" height="7" rx="1.5"/><rect x="14" y="4" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  play: '<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  next: '<path d="M5 4l10 8-10 8z" fill="currentColor"/><path d="M19 5v14" stroke-width="3"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="3"/>',
  vol: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 9a4 4 0 0 1 0 6"/>',
  mute: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/>',
  note: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/>',
  flame: '<path d="M12 3c1 3.5 4.5 5.5 4.5 9.5a4.5 4.5 0 0 1-9 0c0-2.2 1-3.6 2.2-4.700.3 1.700 1.100 2.600 2.300 2.800C11.200 8.500 11 6 12 3z"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0"/><path d="M17 5a3.5 3.5 0 0 1 0 6M19 20a6 6 0 0 0-3-5.2"/>',
};
export const ic = (n, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[n]}</svg>`;
