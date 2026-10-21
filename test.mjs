// Автотест комнат. Запуск: при работающем сервере выполните  node test.mjs
// (адрес можно сменить: BASE=http://localhost:3001 node test.mjs)
import WebSocket from 'ws';
const BASE = process.env.BASE || 'http://localhost:3000';
const tag = Math.random().toString(36).slice(2, 7);
let fails = 0;
const ok = (c, t) => { console.log((c ? 'PASS  ' : 'FAIL  ') + t); if (!c) fails++; };

async function user(name) {
  const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name + tag, password: 'secret123' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const call = async (m, path, body) => {
    const res = await fetch(BASE + path, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const sock = () => new Promise((res) => {
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { cookie } });
    ws.msgs = []; ws.on('message', (d) => ws.msgs.push(JSON.parse(d))); ws.on('open', () => res(ws));
  });
  return { call, sock, cookie };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (ws, f) => ws.msgs.some(f);

const A = await user('ownerA'), B = await user('guestB'), C = await user('guestC');
const disc = async (u, q = '') => (await u.call('GET', '/api/discover?q=' + q)).data.rooms || [];

// Публичная комната
const pub = (await A.call('POST', '/api/rooms', { name: 'pub' + tag, visibility: 'public', tags: 'lo-fi', control: 'owner' })).data;
ok(pub.id && pub.visibility === 'public', 'пользователь создаёт публичную комнату');
ok((await disc(B, 'pub' + tag)).some((r) => r.id === pub.id), 'публичная комната видна другому пользователю в Обзоре');
ok((await B.call('POST', `/api/rooms/${pub.id}/join`, {})).status === 200, 'другой пользователь входит в публичную комнату');
ok((await A.call('POST', '/api/rooms', { name: '' })).status === 400, 'пустое название отклоняется');

// Приватная и по ссылке
for (const v of ['private', 'unlisted']) {
  const r = (await A.call('POST', '/api/rooms', { name: v + tag, visibility: v })).data;
  ok(!(await disc(B, v + tag)).some((x) => x.id === r.id), `${v}: не попадает в Обзор`);
  ok(!(await B.call('GET', '/api/rooms')).data.some((x) => x.id === r.id), `${v}: не видна посторонним в списке комнат`);
  ok((await B.call('POST', `/api/rooms/${r.id}/join`, {})).status === 404, `${v}: вход без приглашения запрещён`);
  ok((await B.call('POST', `/api/rooms/${r.id}/join`, { invite: 'wrong' })).status === 404, `${v}: неверный ключ не работает`);
  ok((await B.call('POST', `/api/rooms/${r.id}/join`, { invite: r.invite })).status === 200, `${v}: приглашение работает`);
  ok((await C.call('POST', `/api/rooms/${r.id}/join`, {})).status === 404, `${v}: другие по-прежнему не заходят`);
}

// Права владельца
ok((await A.call('PATCH', `/api/rooms/${pub.id}`, { description: 'новое' })).data.description === 'новое', 'владелец меняет настройки');
ok((await B.call('PATCH', `/api/rooms/${pub.id}`, { name: 'hack' })).status === 403, 'не владелец не может менять настройки');
await B.call('DELETE', `/api/rooms/${pub.id}`);
ok((await A.call('GET', '/api/rooms')).data.some((r) => r.id === pub.id), 'не владелец не может удалить комнату');

// Лимит участников и права на управление
const cap = (await A.call('POST', '/api/rooms', { name: 'cap' + tag, max_users: 1, control: 'owner' })).data;
const wa = await A.sock(); wa.send(JSON.stringify({ type: 'join', room: cap.id }));
await wait(300);
const wb = await B.sock(); wb.send(JSON.stringify({ type: 'join', room: cap.id }));
await wait(300);
ok(has(wb, (m) => m.type === 'error' && m.code === 'full'), 'лимит участников соблюдается');
const wa2 = await A.sock(); wa2.send(JSON.stringify({ type: 'join', room: cap.id }));
await wait(300);
ok(wa2.msgs.some((m) => m.type === 'state' && m.users === 1), 'повторное подключение того же пользователя не создаёт дубликата');

// Синхронизация и доступ к аудио
const form = new FormData();
form.append('file', new Blob([Buffer.alloc(2048, 1)]), 'test.mp3');
const up = await (await fetch(BASE + '/api/tracks', { method: 'POST', headers: { cookie: A.cookie }, body: form })).json();
const room2 = (await A.call('POST', '/api/rooms', { name: 'sync' + tag, control: 'owner' })).data;
const sa = await A.sock(), sb = await B.sock();
sa.send(JSON.stringify({ type: 'join', room: room2.id })); sb.send(JSON.stringify({ type: 'join', room: room2.id }));
await wait(300);
sb.send(JSON.stringify({ type: 'play', pos: 0 }));
await wait(200);
ok(has(sb, (m) => m.type === 'error' && m.code === 'perm'), 'участник без прав не может управлять воспроизведением');
sa.send(JSON.stringify({ type: 'track', id: up.id })); await wait(200);
sa.send(JSON.stringify({ type: 'play', pos: 0 })); await wait(300);
ok(has(sb, (m) => m.type === 'state' && m.track && m.track.id === up.id && m.playing), 'синхронизация: участник получает трек и play');
const audio = (u) => fetch(BASE + '/audio/' + up.id, { headers: { cookie: u.cookie } }).then((r) => r.status);
ok(await audio(B) === 200, 'участник комнаты получает аудио');
ok(await audio(C) === 404, 'посторонний не получает аудио');

[wa, wb, wa2, sa, sb].forEach((w) => w.close());
console.log(fails ? `\nПровалено проверок: ${fails}` : '\nВсе проверки пройдены');
process.exit(fails ? 1 : 0);
