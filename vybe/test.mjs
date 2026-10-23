// Автотест комнат. Запуск: при работающем сервере выполните  node test.mjs
// (адрес можно сменить: BASE=http://localhost:3001 node test.mjs)
import WebSocket from 'ws';
import tu from './testutil.js';
const { makePng } = tu;
const BASE = process.env.BASE || 'http://localhost:3000';
const tag = Math.random().toString(36).slice(2, 7);
let fails = 0;
const ok = (c, t) => { console.log((c ? 'PASS  ' : 'FAIL  ') + t); if (!c) fails++; };

async function user(name) {
  const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name + tag, password: 'secret123' }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const uid = (await r.json()).id;
  const call = async (m, path, body) => {
    const res = await fetch(BASE + path, { method: m, headers: { 'Content-Type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
  const sock = () => new Promise((res) => {
    const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: { cookie } });
    ws.msgs = []; ws.on('message', (d) => ws.msgs.push(JSON.parse(d))); ws.on('open', () => res(ws));
  });
  return { call, sock, cookie, id: uid };
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


// ---------- Очередь ----------
const mp3 = (n) => { const f = new FormData(); f.append('file', new Blob([Buffer.alloc(2048, 1)]), n + '.mp3'); return f; };
const upT = async (u, n) => (await (await fetch(BASE + '/api/tracks', { method: 'POST', headers: { cookie: u.cookie }, body: mp3(n) })).json()).id;
const J = (w, o) => w.send(JSON.stringify(o));
const lastQ = (w) => [...w.msgs].reverse().find((m) => m.type === 'queue');
const lastS = (w) => [...w.msgs].reverse().find((m) => m.type === 'state');
const qr = (await A.call('POST', '/api/rooms', { name: 'queue' + tag, control: 'all' })).data;
const t1 = await upT(A, 'q1'), t2 = await upT(A, 'q2'), t3 = await upT(A, 'q3'), tb = await upT(B, 'qb');
const qa = await A.sock(), qb = await B.sock();
J(qa, { type: 'join', room: qr.id }); J(qb, { type: 'join', room: qr.id }); await wait(300);
J(qa, { type: 'qadd', track: t1 }); await wait(200);
ok(lastS(qb).track && lastS(qb).track.id === t1 && !lastS(qb).playing, 'очередь: первый трек в пустой комнате становится текущим (на паузе)');
J(qb, { type: 'qadd', track: tb }); await wait(150); J(qa, { type: 'qadd', track: t2 }); await wait(150); J(qa, { type: 'qadd', track: t3 }); await wait(300);
ok(lastQ(qa).items.map((x) => x.track).join() === [tb, t2, t3].join(), 'очередь: порядок сохраняется');
ok(lastQ(qb).items.length === 3 && lastQ(qb).items[0].by.startsWith('guestB'), 'очередь: участник получает обновление и видит, кто добавил');
J(qb, { type: 'qadd', track: t1 }); await wait(200);
ok(lastQ(qb).items.length === 3 && has(qb, (m) => m.type === 'error' && m.code === 'track'), 'очередь: чужой трек добавить нельзя');
J(qa, { type: 'qmove', id: lastQ(qa).items[2].id, to: 0 }); await wait(200);
ok(lastQ(qb).items[0].track === t3, 'очередь: перестановка видна всем');
J(qa, { type: 'qremove', id: lastQ(qa).items[0].id }); await wait(200);
ok(lastQ(qb).items.length === 2, 'очередь: удаление видно всем');
J(sb, { type: 'qadd', track: tb }); J(sb, { type: 'skip' }); await wait(200);
ok(sb.msgs.filter((m) => m.type === 'error' && m.code === 'perm').length >= 2, 'очередь и пропуск: без прав не работают даже через прямой WebSocket');
const qc = await C.sock(); J(qc, { type: 'join', room: qr.id }); await wait(300);
ok(lastS(qc) && lastS(qc).track && lastQ(qc).items.length === 2, 'новый участник сразу получает состояние и очередь');
qb.close(); const qb2 = await B.sock(); J(qb2, { type: 'join', room: qr.id }); await wait(300);
ok(lastS(qb2).track && lastQ(qb2).items.length === 2, 'переподключение: клиент снова получает состояние и очередь');
J(qa, { type: 'play', pos: 0 }); await wait(200);
const s0 = lastS(qa).seq;
J(qa, { type: 'ended', seq: s0 }); J(qb2, { type: 'ended', seq: s0 }); J(qa, { type: 'ended', seq: s0 }); await wait(300);
ok(lastS(qb2).seq === s0 + 1, 'автопереход: дублирующиеся «трек закончился» дают ровно один переход');
ok(lastS(qb2).playing && lastQ(qb2).items.length === 1, 'следующий трек запускается автоматически, очередь сокращается');
J(qa, { type: 'skip' }); await wait(200); J(qa, { type: 'skip' }); await wait(200);
ok(!lastS(qb2).track && !lastS(qb2).playing && lastQ(qb2).items.length === 0, 'пустая очередь: комната переходит в состояние ожидания');

// ---------- SoundCloud (проверка ссылок не требует интернета) ----------
const sc = (u, url) => u.call('POST', '/api/soundcloud', { url });
ok((await sc(A, 'не ссылка')).status === 400, 'SoundCloud: текст вместо ссылки отклоняется');
ok((await sc(A, 'https://youtube.com/watch?v=1')).status === 400, 'SoundCloud: чужой сайт отклоняется');
ok((await sc(A, 'http://soundcloud.com/artist/track')).status === 400, 'SoundCloud: небезопасная http-ссылка отклоняется');
ok((await sc(A, 'https://soundcloud.com/artist/sets/mix')).status === 400, 'SoundCloud: плейлист даёт понятную ошибку');
ok((await sc(A, 'https://evil.com/soundcloud.com/a/b')).status === 400, 'SoundCloud: подмена адреса не проходит');
const live1 = await sc(A, process.env.SC_URL || 'https://soundcloud.com/nonexistent-' + tag + '/none');
console.log('INFO  реальная проверка SoundCloud: статус ' + live1.status + (live1.status === 200 ? ' (трек добавлен: ' + live1.data.title + ')' : ' (' + (live1.data.error || '') + ')'));
console.log('      Чтобы проверить добавление настоящего трека: SC_URL=https://soundcloud.com/автор/трек node test.mjs');

[qa, qb2, qc].forEach((w) => w.close());


// ---------- Чат комнаты ----------
const chatRoom = (await A.call('POST', '/api/rooms', { name: 'chat' + tag, control: 'owner' })).data;
const ca = await A.sock(), cb = await B.sock();
J(ca, { type: 'join', room: chatRoom.id }); J(cb, { type: 'join', room: chatRoom.id }); await wait(300);
J(ca, { type: 'chat:send', text: 'привет <b>всем</b>', cid: 'c1' }); await wait(250);
ok(has(cb, (m) => m.type === 'chat:message' && m.text === 'привет <b>всем</b>' && m.name.startsWith('ownerA')), 'чат: сообщение доходит до другого участника (текст не изменяется сервером)');
ok(has(ca, (m) => m.type === 'chat:message' && m.cid === 'c1'), 'чат: отправитель получает подтверждение с тем же cid');
const cc = await C.sock(); J(cc, { type: 'join', room: chatRoom.id }); await wait(300);
ok(has(cc, (m) => m.type === 'chat:history' && m.items.length === 1), 'чат: история загружается при входе в комнату');
J(cb, { type: 'chat:send', text: '   ', cid: 'e' }); J(cb, { type: 'chat:send', text: 'x'.repeat(501), cid: 'l' }); await wait(250);
ok(has(cb, (m) => m.type === 'chat:error' && m.code === 'empty') && has(cb, (m) => m.type === 'chat:error' && m.code === 'long'), 'чат: пустые и слишком длинные сообщения отклоняются');
for (let k = 0; k < 8; k++) J(cb, { type: 'chat:send', text: 'спам ' + k, cid: 's' + k });
await wait(400);
ok(has(cb, (m) => m.type === 'chat:error' && m.code === 'rate'), 'чат: ограничение частоты сообщений работает');
const privR = (await A.call('POST', '/api/rooms', { name: 'privchat' + tag, visibility: 'private' })).data;
const pa = await A.sock(), pc = await C.sock();
J(pa, { type: 'join', room: privR.id }); J(pc, { type: 'join', room: privR.id }); await wait(300);
J(pa, { type: 'chat:send', text: 'секрет', cid: 'p1' }); J(pc, { type: 'chat:send', text: 'взлом', cid: 'p2' }); J(pc, { type: 'chat:older', before: 9999 }); await wait(300);
ok(has(pc, (m) => m.type === 'error' && m.code === 'denied'), 'чат: посторонний не может войти в приватную комнату');
ok(!has(pc, (m) => m.type === 'chat:message' || (m.type === 'chat:history' && m.room === privR.id)) && !has(pa, (m) => m.type === 'chat:message' && m.text === 'взлом'), 'чат: приватные сообщения не доходят до посторонних и посторонние не могут писать');

// ---------- Главная: «Сейчас слушают» и «Популярное» ----------
J(pa, { type: 'track', id: up.id }); await wait(150); J(pa, { type: 'play', pos: 0 }); await wait(250);
const home = (await B.call('GET', '/api/home')).data;
ok(home.listening.some((r) => r.id === room2.id && r.track), 'главная: играющая публичная комната видна с данными трека');
ok(!JSON.stringify(home).includes(privR.name), 'главная: приватная комната не раскрывается, даже когда в ней играет музыка');
ok(home.popular.length > 0 && home.popular.every((r) => r.online > 0 || home.kind === 'recent'), 'главная: популярные комнаты определяются по реальной активности');
[ca, cb, cc, pa, pc].forEach((w) => w.close());


// ---------- Профиль ----------
const tagB2 = (await B.call('GET', '/api/me')).data.tag;
await A.call('POST', '/api/friends', { tag: tagB2 }); await B.call('POST', `/api/friends/${A.id}/accept`);
ok((await fetch(BASE + '/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401, 'профиль: без входа изменить нельзя');
ok((await A.call('PUT', '/api/profile', { display_name: '   ' })).status === 400, 'профиль: пустое имя отклоняется');
ok((await A.call('PUT', '/api/profile', { bio: 'x'.repeat(161) })).status === 400, 'профиль: слишком длинное «о себе» отклоняется');
ok((await A.call('PUT', '/api/profile', { display_name: 'Аня', bio: 'привет', accent: 'mint', genres: ['jazz'], vis_bio: 'friends', status: { preset: 'dnd', hours: 1 } })).status === 200, 'профиль: обновление полей');
const profA = (await A.call('GET', '/api/profile/me')).data;
ok(profA.display_name === 'Аня' && profA.bio === 'привет' && profA.accent === '#6FD0A8' && profA.status.includes('Не беспокоить'), 'профиль: изменения сохранены');
ok((await B.call('PUT', '/api/profile', { display_name: 'Боря' })).status === 200 && (await A.call('GET', '/api/profile/me')).data.display_name === 'Аня', 'профиль: чужой профиль изменить нельзя (каждый меняет только свой)');
ok((await B.call('GET', `/api/profile/${A.id}`)).data.bio === 'привет', 'приватность: друг видит «о себе»');
ok(!('bio' in (await C.call('GET', `/api/profile/${A.id}`)).data), 'приватность: посторонний не получает «о себе» через API');
await A.call('PUT', '/api/profile', { vis_bio: 'me', vis_activity: 'me' });
ok(!('bio' in (await B.call('GET', `/api/profile/${A.id}`)).data) && !('activity' in (await B.call('GET', `/api/profile/${A.id}`)).data), 'приватность: «только я» скрывает поля и от друзей');
const upImg = (u, kind, buf, name = 'a.png') => { const f = new FormData(); f.append('file', new Blob([buf]), name); return fetch(BASE + '/api/profile/' + kind, { method: 'PUT', headers: { cookie: u.cookie }, body: f }); };
ok((await upImg(A, 'avatar', Buffer.from('просто текст'), 'fake.png')).status === 400, 'аватар: текст с расширением .png отклоняется');
ok((await upImg(A, 'avatar', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), 'a.svg')).status === 400, 'аватар: SVG отклоняется');
const okUp = await upImg(A, 'avatar', makePng(64, 64), 'whatever.exe');
const avUrl = (await okUp.json()).avatar;
ok(okUp.status === 200 && /^\/media\/[a-f0-9]{24}\.png$/.test(avUrl), 'аватар: настоящее изображение принято, имя файла выбирает сервер');
const got = await fetch(BASE + avUrl, { headers: { cookie: A.cookie } });
ok(got.status === 200 && got.headers.get('content-type').startsWith('image/png') && got.headers.get('x-content-type-options') === 'nosniff', 'аватар: отдаётся с безопасными заголовками');
ok((await fetch(BASE + avUrl)).status === 401, 'аватар: без входа недоступен');
ok((await fetch(BASE + '/media/..%2Fserver.js', { headers: { cookie: A.cookie } })).status === 404, 'аватар: обход пути невозможен');
ok((await upImg(A, 'banner', Buffer.concat([makePng(64, 64), Buffer.alloc(9 * 1024 * 1024)]), 'b.png')).status === 413, 'баннер: файл больше 8 МБ отклоняется');
ok((await upImg(A, 'avatar', makePng(64, 64))).status === 200 && (await fetch(BASE + avUrl, { headers: { cookie: A.cookie } })).status === 404, 'аватар: при замене старый файл удаляется');
const mp3f = () => { const f = new FormData(); f.append('file', new Blob([Buffer.alloc(2048, 1)]), 'fav.mp3'); return f; };
const fa = await (await fetch(BASE + '/api/tracks', { method: 'POST', headers: { cookie: A.cookie }, body: mp3f() })).json();
const fb = await (await fetch(BASE + '/api/tracks', { method: 'POST', headers: { cookie: A.cookie }, body: mp3f() })).json();
ok((await A.call('PUT', '/api/profile/favorites', { tracks: [fb.id, fa.id], featured: fa.id })).status === 200, 'избранное: сохраняется с порядком и избранным треком');
ok((await A.call('GET', '/api/profile/me')).data.tracks.map((x) => x.id).join() === [fb.id, fa.id].join(), 'избранное: порядок сохранён');
ok((await A.call('PUT', '/api/profile/favorites', { tracks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] })).status === 400, 'избранное: больше 10 треков отклоняется');
ok((await A.call('PUT', '/api/profile/favorites', { tracks: [fa.id], featured: fb.id })).status === 400, 'избранное: избранный трек должен быть в списке');
ok((await B.call('PUT', '/api/profile/favorites', { tracks: [fa.id] })).status === 400, 'избранное: чужой трек добавить нельзя');
const seenB = (await B.call('GET', `/api/profile/${A.id}`)).data;
ok(seenB.tracks.length === 0 && seenB.featured === null, 'приватность MP3: чужие MP3 не показываются в профиле другим пользователям');
ok((await fetch(BASE + '/audio/' + fa.id, { headers: { cookie: B.cookie } })).status === 404, 'приватность MP3: другой пользователь не может скачать трек, добавленный в профиль');

// ---------- Серии: доступ (логика накопления проверяется в streaks.test.js) ----------
const tagB = (await B.call('GET', '/api/me')).data.tag;
ok((await fetch(BASE + '/api/streaks')).status === 401, 'серии: без входа данные недоступны');
ok((await C.call('GET', `/api/streaks/${A.id}`)).status === 404, 'серии: чужую серию (не друг) посмотреть нельзя');
await A.call('POST', '/api/friends', { tag: tagB }); await B.call('POST', `/api/friends/${A.id}/accept`);
ok((await A.call('GET', '/api/streaks')).data.some((x) => x.id === B.id && x.current === 0), 'серии: у друзей показывается серия 0, пока нет общих дней');
const det = (await A.call('GET', `/api/streaks/${B.id}`)).data;
ok(det.rules && det.rules.minutes === 10 && Array.isArray(det.days), 'серии: подробности друзей содержат правила и историю');
ok((await A.call('GET', `/api/streaks/${C.id}`)).status === 404, 'серии: серия с недругом недоступна');
await A.call('DELETE', `/api/friends/${B.id}`);
ok((await B.call('GET', `/api/streaks/${A.id}`)).status === 404, 'серии: после удаления из друзей данные недоступны');

[wa, wb, wa2, sa, sb].forEach((w) => w.close());
console.log(fails ? `\nПровалено проверок: ${fails}` : '\nВсе проверки пройдены');
process.exit(fails ? 1 : 0);
