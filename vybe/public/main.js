// Оболочка: навигация, разделы, комнаты, обзор, друзья, настройки, окна
import { S, $, el, api, send, ic, connect, canControl } from './core.js';
import { onState, stopAudio, updateBar } from './player.js';

const ROUTES = [['home', 'Главная', 'home'], ['discover', 'Обзор', 'compass'], ['rooms', 'Комнаты', 'rooms'], ['messages', 'Сообщения', 'chat'], ['profile', 'Профиль', 'user']];
const MOODS = [['Спокойно', '#6C8BFF'], ['Заряд', '#FF6B9A'], ['Ночь', '#A27BFF']];
let panelOpen = true, tab = 'who', timer = null, dt = null;
let joinErr = '', failed = 0, joining = 0;
const D = { q: '', sort: 'active', tag: '', playing: false };

// ---------- Помощники ----------
const route = () => { const [, p = 'home', id, key] = location.hash.split('/'); return { p, id: +id || 0, key: key || '' }; };
const go = (h) => { location.hash = h; };
const open = (r) => go('#/room/' + r.id);
const btn = (t, fn, cls = '') => { const b = el('button', t, cls); b.type = 'button'; b.onclick = fn; return b; };
const row = (...k) => { const d = el('div', '', 'row'); d.append(...k); return d; };
const page = (...k) => { const d = el('div', '', 'page'); d.append(...k); return d; };
const sec = (title, ...k) => { const s = el('section', '', 'sec'); s.append(el('h2', title), ...k); return s; };
const empty = (text, ...a) => { const d = el('div', '', 'empty'); d.append(el('span', text), ...a); return d; };
const item = (title, sub, ...a) => { const d = el('div', '', 'item'), t = el('div', '', 'grow'); t.append(el('div', title, 'tt'), el('div', sub, 'mu s')); d.append(t, row(...a)); return d; };
const copy = async (text, ask) => { try { await navigator.clipboard.writeText(text); return true; } catch { prompt(ask, text); return false; } };
const recent = () => JSON.parse(localStorage.getItem('recent') || '[]');
const flash = (t) => { $('#bS').textContent = t; setTimeout(updateBar, 3000); };

// ---------- Тема и настроение ----------
const setTheme = (t) => { document.documentElement.dataset.theme = t; localStorage.setItem('theme', t); };
function setMood(i) {
  const c = MOODS[i][1], st = document.documentElement.style;
  localStorage.setItem('mood', i);
  st.setProperty('--ac', c);
  st.setProperty('--glow', c + '4D');
}
setTheme(localStorage.getItem('theme') || 'dark');
if (localStorage.getItem('mood') !== null) setMood(+localStorage.getItem('mood'));

// ---------- Модальные окна ----------
function modal(title, build) {
  const d = $('#mdl');
  $('#mt').textContent = title;
  $('#mb').innerHTML = '';
  build($('#mb'), () => d.close());
  if (!d.open) { try { d.showModal(); } catch { d.setAttribute('open', ''); } }
}
const field = (label, node) => { const d = el('div'); d.append(el('label', label, 'lbl'), node); return d; };
const inp = (ph, val = '', type = 'text') => { const i = el('input'); i.type = type; i.placeholder = ph; i.value = val; return i; };
const sel = (opts, val) => { const s = el('select'); opts.forEach(([v, t]) => s.add(new Option(t, v))); s.value = val; return s; };

function authModal(m) {
  modal(m === 'login' ? 'Вход' : 'Регистрация', (b, close) => {
    const f = el('form'), n = inp('Имя'), p = inp('Пароль (от 6 символов)', '', 'password'), e = el('p', '', 'mu s');
    n.autocomplete = 'username'; p.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    const sw = btn(m === 'login' ? 'Нет аккаунта? Регистрация' : 'Уже есть аккаунт? Войти', () => authModal(m === 'login' ? 'register' : 'login'), 'link');
    f.append(n, p, e, row(el('button', m === 'login' ? 'Войти' : 'Создать аккаунт', 'pri'), btn('Отмена', close)), sw);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      try { await api('/api/' + m, 'POST', { name: n.value.trim(), password: p.value }); close(); enterApp(); }
      catch (er) { e.textContent = er.message; }
    };
    b.append(f);
    setTimeout(() => n.focus(), 50);
  });
}

// Создание и настройки комнаты (одно окно: room передан, значит это редактирование)
function roomModal(room) {
  modal(room ? 'Настройки комнаты' : 'Новая комната', (b, close) => {
    const f = el('form'), name = inp('Название', room ? room.name : ''), desc = el('textarea'),
      vis = sel([['public', 'Публичная: видна в Обзоре'], ['unlisted', 'По ссылке: не видна в Обзоре'], ['private', 'Приватная: только по приглашению']], room ? room.visibility : 'public'),
      tags = inp('Например: lo-fi, rock', room ? room.tags.join(', ') : ''),
      max = inp('0 — без лимита', room ? room.max : 0, 'number'),
      ctl = sel([['all', 'Все участники'], ['owner', 'Только хозяин']], room ? room.control : 'owner'),
      hint = el('p', '', 'mu s'), err = el('p', '', 'mu s');
    name.maxLength = 40; desc.maxLength = 200; desc.placeholder = 'Описание (необязательно)'; desc.value = room ? room.description : '';
    max.min = 0; max.max = 50;
    const upd = () => {
      hint.textContent = vis.value === 'public' ? 'В публичной комнате музыку услышат незнакомые люди. Включайте только то, на что у вас есть права.'
        : vis.value === 'unlisted' ? 'Комната откроется только по ссылке, которую вы отправите.' : 'Войти смогут только те, кому вы отправите приглашение.';
    };
    vis.onchange = upd; upd();
    f.append(field('Название', name), field('Описание', desc), field('Тип', vis), hint, field('Жанр или теги (через запятую, до 5)', tags),
      field('Максимум участников', max), field('Кто управляет воспроизведением', ctl), err,
      row(el('button', room ? 'Сохранить' : 'Создать', 'pri'), btn('Отмена', close)));
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const body = { name: name.value, description: desc.value, visibility: vis.value, tags: tags.value, max_users: +max.value || 0, control: ctl.value };
      try {
        const r = room ? await api('/api/rooms/' + room.id, 'PATCH', body) : await api('/api/rooms', 'POST', body);
        close();
        if (room) { S.cur = r; await loadRooms(); render(); } else open(r);
      } catch (er) { err.textContent = er.message; }
    };
    b.append(f);
    setTimeout(() => name.focus(), 50);
  });
}

// ---------- Данные ----------
const loadRooms = async () => { S.rooms = await api('/api/rooms'); };
const loadTracks = async () => { S.tracks = await api('/api/tracks'); };
const loadFriends = async () => { S.friends = await api('/api/friends'); };
async function refresh() {
  await Promise.all([loadRooms(), loadFriends()]).catch(() => {});
  if (S.cur) { const f = S.rooms.find((x) => x.id === S.cur.id); if (f) S.cur = f; } // подхватываем изменения настроек
  if (!document.activeElement.closest('#view input, #view textarea')) render();
}

// ---------- Вход в комнату ----------
async function joinRoom(id, key) {
  if (joining === id) return;
  joining = id; joinErr = '';
  try {
    const r = await api('/api/rooms/' + id + '/join', 'POST', key ? { invite: key } : {});
    leaveRoom(false);
    S.cur = r; S.st = {};
    send({ type: 'join', room: id });
    localStorage.setItem('recent', JSON.stringify([id, ...recent().filter((x) => x !== id)].slice(0, 8)));
    if (key) history.replaceState(null, '', '#/room/' + id); // ключ приглашения убираем из адресной строки
    await loadRooms();
  } catch (e) { joinErr = e.message; failed = id; }
  joining = 0;
  render();
}
function leaveRoom(notify = true) {
  if (S.cur && notify) send({ type: 'leave' });
  S.cur = null;
  stopAudio();
}

// ---------- Общие блоки ----------
function friendRow(f) {
  const pend = f.status === 'pending';
  const st = pend ? (f.dir === 'in' ? 'хочет дружить' : 'ждёт ответа') : f.room ? 'в комнате «' + f.room.name + '»' : f.online ? 'онлайн' : 'не в сети';
  const a = [];
  if (pend && f.dir === 'in') a.push(btn('Принять', async () => { await api('/api/friends/' + f.id + '/accept', 'POST'); refresh(); }, 'pri'));
  if (!pend && f.room) a.push(btn('Зайти', () => open(f.room), 'pri'));
  a.push(btn(pend ? (f.dir === 'in' ? 'Отклонить' : 'Отмена') : 'Удалить', async () => { await api('/api/friends/' + f.id, 'DELETE'); refresh(); }));
  return item(f.name + ' #' + f.tag, st, ...a);
}

function uploadBtn() {
  const l = el('label', 'Загрузить mp3', 'btn pri'), i = inp('', '', 'file');
  i.accept = '.mp3,audio/mpeg'; i.hidden = true;
  i.onchange = async () => {
    const f = i.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    try { await api('/api/tracks', 'POST', fd); await loadTracks(); render(); } catch (e) { alert(e.message); }
  };
  l.append(i);
  return l;
}

function trackRows(list) {
  const box = el('div');
  list.forEach((t) => {
    const play = btn('В комнату', () => send({ type: 'track', id: t.id }), 'pri');
    play.disabled = !canControl();
    box.append(item(t.title, 'mp3', play, btn('Удалить', async () => { await api('/api/tracks/' + t.id, 'DELETE'); await loadTracks(); render(); })));
  });
  return box;
}

function roomCard(r) {
  const here = S.cur && S.cur.id === r.id;
  const c = el('div', '', 'card' + (here ? ' live' : ''));
  const vis = r.visibility === 'private' ? 'приватная' : r.visibility === 'unlisted' ? 'по ссылке' : '';
  c.append(el('div', r.name, 'tt'));
  if (r.description) c.append(el('div', r.description, 'mu s'));
  if (r.track) c.append(el('div', (r.playing ? 'Играет: ' : 'Пауза: ') + r.track, 's'));
  c.append(el('div', [vis, 'хозяин ' + r.owner, 'слушают: ' + r.online + (r.max ? ' из ' + r.max : '')].filter(Boolean).join(' · '), 'mu s'));
  if (r.tags.length) c.append(el('div', r.tags.map((t) => '#' + t).join(' '), 's'));
  const full = r.max && r.online >= r.max && S.me.id !== r.oid && !here;
  const j = btn(full ? 'Заполнено' : here ? 'Вы здесь' : 'Войти', () => open(r), 'pri');
  j.disabled = !!full;
  c.append(row(j));
  return c;
}
const grid = (list, msg, ...act) => {
  if (!list.length) return empty(msg, ...act);
  const g = el('div', '', 'grid');
  list.forEach((r) => g.append(roomCard(r)));
  return g;
};

// ---------- Разделы ----------
function welcome() {
  const c = el('div', '', 'card');
  c.append(el('h1', 'Слушайте музыку вместе'), el('p', 'Создавайте комнаты, зовите друзей и включайте свои треки синхронно.', 'mu'), row(btn('Войти', () => authModal('login'), 'pri'), btn('Регистрация', () => authModal('register'))));
  return page(c);
}

function home() {
  const head = el('div'), acts = row(btn('Создать комнату', () => roomModal(), 'pri'), uploadBtn());
  head.append(el('h1', 'Привет, ' + S.me.name), el('p', 'Что слушаем сегодня?', 'mu'), acts);
  acts.style.marginTop = 'var(--s4)';
  const live = S.friends.filter((f) => f.status === 'ok' && f.room);
  const fr = live.length ? el('div') : empty('Сейчас никто из друзей не слушает музыку.', btn('Найти друзей', () => go('#/messages')));
  live.forEach((f) => fr.append(friendRow(f)));
  const rec = recent().map((id) => S.rooms.find((r) => r.id === id)).filter(Boolean).slice(0, 4);
  const lib = S.tracks.length ? trackRows(S.tracks.slice(0, 5)) : empty('В библиотеке пока пусто.', uploadBtn());
  return page(head, sec('Друзья слушают', fr),
    sec('Недавние комнаты', grid(rec, 'Вы ещё не заходили в комнаты.', btn('Найти в Обзоре', () => go('#/discover')))),
    sec('Моя музыка', lib, ...(S.tracks.length > 5 ? [btn('Вся библиотека', () => go('#/profile'))] : [])));
}

function discover() {
  const chips = el('div', '', 'row'), out = el('div'), q = inp('Поиск по названию и описанию', D.q);
  chips.style.margin = '0 0 var(--s4)';
  async function load() {
    out.replaceChildren(el('p', 'Загрузка…', 'mu'));
    try {
      const d = await api('/api/discover?' + new URLSearchParams({ q: D.q, sort: D.sort, tag: D.tag, playing: D.playing ? '1' : '' }));
      chips.replaceChildren(
        btn('Самые активные', () => { D.sort = 'active'; load(); }, D.sort === 'active' ? 'pri' : ''),
        btn('Недавние', () => { D.sort = 'recent'; load(); }, D.sort === 'recent' ? 'pri' : ''),
        btn('Сейчас играют', () => { D.playing = !D.playing; load(); }, D.playing ? 'pri' : ''),
        ...d.tags.map((t) => btn('#' + t, () => { D.tag = D.tag === t ? '' : t; load(); }, D.tag === t ? 'pri' : '')));
      const filtered = D.q || D.tag || D.playing;
      out.replaceChildren(grid(d.rooms, filtered ? 'Ничего не найдено. Измените поиск или фильтры.' : 'Публичных комнат пока нет. Создайте первую!', btn('Создать комнату', () => roomModal(), 'pri')));
    } catch (e) { out.replaceChildren(empty('Не удалось загрузить комнаты: ' + e.message, btn('Повторить', load))); }
  }
  q.oninput = () => { D.q = q.value; clearTimeout(dt); dt = setTimeout(load, 300); };
  load();
  return page(el('h1', 'Обзор'), sec('Публичные комнаты', q, chips, out));
}

function rooms() {
  const head = el('div', '', 'row between');
  head.append(el('h1', 'Комнаты'), btn('Создать комнату', () => roomModal(), 'pri'));
  return page(head,
    sec('Мои комнаты', grid(S.rooms.filter((r) => r.oid === S.me.id), 'Вы ещё не создавали комнат.')),
    sec('Где я участник', grid(S.rooms.filter((r) => r.oid !== S.me.id), 'Комнат, куда вы заходили, пока нет. Найдите их в Обзоре.')));
}

function messages() {
  const f = el('form', '', 'row'), i = inp('Тег друга, например 48213'), e = el('p', '', 'mu s');
  i.inputMode = 'numeric'; i.autocomplete = 'off';
  f.append(i, el('button', 'Добавить', 'pri'));
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    try { await api('/api/friends', 'POST', { tag: i.value }); i.value = ''; e.textContent = 'Готово'; refresh(); }
    catch (er) { e.textContent = er.message; }
  };
  const list = S.friends.length ? el('div') : empty('Пока никого. Добавьте друга по его тегу.');
  S.friends.forEach((x) => list.append(friendRow(x)));
  return page(el('h1', 'Сообщения'),
    sec('Друзья', el('p', 'Ваш тег: #' + S.me.tag, 'mu'), f, e, list),
    sec('Личные сообщения', empty('Личные сообщения появятся на одном из следующих этапов.')));
}

function profile() {
  const me = S.me, mood = +localStorage.getItem('mood') || 0;
  const acc = el('div', '', 'card');
  acc.append(el('h1', me.name), el('p', 'Тег: #' + me.tag + (me.admin ? ' · администратор' : ''), 'mu'),
    row(btn('Копировать тег', () => copy('#' + me.tag, 'Ваш тег:')), btn('Выйти', async () => { await api('/api/logout', 'POST'); location.reload(); })));
  const dark = () => document.documentElement.dataset.theme === 'dark';
  const th = btn(dark() ? 'Тёмная тема' : 'Светлая тема', () => { setTheme(dark() ? 'light' : 'dark'); th.textContent = dark() ? 'Тёмная тема' : 'Светлая тема'; });
  const look = el('div', '', 'card');
  look.append(row(th), row(el('span', 'Настроение комнаты:', 'mu'), ...MOODS.map((m, i) => btn(m[0], () => { setMood(i); render(); }, i === mood ? 'pri' : ''))));
  const libHead = row(uploadBtn());
  libHead.style.marginBottom = 'var(--s3)';
  const out = [acc, sec('Оформление', look), sec('Моя музыка', libHead, S.tracks.length ? trackRows(S.tracks) : empty('В библиотеке пока пусто.'))];
  if (me.admin) {
    const holder = el('div');
    api('/api/users').then((list) => list.forEach((u) => holder.append(item(u.name + ' #' + u.tag, u.admin ? 'администратор' : 'пользователь',
      ...(u.admin ? [] : [btn('Удалить', async () => { if (confirm('Удалить пользователя ' + u.name + ' и его данные?')) { await api('/api/users/' + u.id, 'DELETE'); refresh(); } })]))))).catch(() => {});
    out.push(sec('Админка · пользователи', holder));
  }
  return page(...out);
}

function roomPage(id) {
  const r = S.cur;
  if (!r || r.id !== id) return page(empty(joinErr || 'Подключаюсь к комнате…', ...(joinErr ? [btn('К комнатам', () => go('#/rooms'))] : [])));
  const owner = S.me.admin || S.me.id === r.oid;
  const vis = r.visibility === 'private' ? 'приватная' : r.visibility === 'unlisted' ? 'по ссылке' : 'публичная';
  const t = el('div');
  t.append(el('h1', r.name), el('p', vis + ' · хозяин ' + r.owner + (r.max ? ' · до ' + r.max + ' участников' : ''), 'mu'));
  if (r.description) t.append(el('p', r.description));
  if (r.tags.length) t.append(el('p', r.tags.map((x) => '#' + x).join(' '), 'mu s'));
  const acts = [];
  if (r.visibility === 'public' || r.invite) acts.push(btn('Позвать друзей', async (e) => {
    const link = location.origin + '/#/room/' + r.id + (r.visibility !== 'public' ? '/' + r.invite : '');
    if (await copy(link, 'Скопируйте ссылку и отправьте друзьям:')) { e.target.textContent = 'Ссылка скопирована'; setTimeout(() => (e.target.textContent = 'Позвать друзей'), 2000); }
  }));
  if (owner) acts.push(btn('Настройки', () => roomModal(r)));
  acts.push(btn('Выйти', () => { leaveRoom(); go('#/rooms'); }));
  if (owner) acts.push(btn('Удалить комнату', async () => {
    if (!confirm('Удалить комнату «' + r.name + '»?')) return;
    await api('/api/rooms/' + r.id, 'DELETE');
    leaveRoom(false);
    go('#/rooms');
    refresh();
  }));
  const head = el('div', '', 'row between');
  head.append(t, row(...acts));
  const now = el('div', '', 'card live');
  now.append(el('div', '', 'tt'), el('div', '', 'mu s'));
  now.children[0].id = 'rTitle'; now.children[1].id = 'rSub';
  const note = canControl() ? [] : [el('p', 'Воспроизведением в этой комнате управляет хозяин.', 'mu s')];
  const p = page(head, sec('Сейчас играет', now, ...note), sec('Выбрать трек из моей музыки', S.tracks.length ? trackRows(S.tracks) : empty('Чтобы включить музыку, загрузите свой mp3.', uploadBtn())));
  setTimeout(roomHead);
  return p;
}
function roomHead() {
  if (!$('#rTitle')) return;
  $('#rTitle').textContent = S.st.track ? S.st.track.title : 'Трек не выбран';
  $('#rSub').textContent = S.st.track ? 'Слушают: ' + (S.st.users || 1) : canControl() ? 'Выберите трек ниже' : 'Ждём, пока хозяин выберет трек';
}

// ---------- Правая панель комнаты ----------
function renderPanel() {
  const { p } = route(), show = p === 'room' && S.cur && panelOpen;
  $('#panel').hidden = !show;
  $('#bPanel').hidden = !S.cur;
  if (!show) return;
  $('#tabs').innerHTML = '';
  [['chat', 'Чат'], ['queue', 'Очередь'], ['who', 'Слушатели']].forEach(([k, t]) => $('#tabs').append(btn(t, () => { tab = k; renderPanel(); }, tab === k ? 'on' : '')));
  const b = $('#pbody');
  b.innerHTML = '';
  if (tab === 'who') (S.st.names || []).forEach((n) => b.append(item(n, n === S.cur.owner ? 'хозяин' : n === S.me.name ? 'вы' : 'слушает')));
  else b.append(empty(tab === 'chat' ? 'Чат комнаты появится на одном из следующих этапов.' : 'Очередь появится на одном из следующих этапов.'));
}
$('#bPanel').onclick = () => {
  if (route().p !== 'room') { panelOpen = true; return go('#/room/' + S.cur.id); }
  panelOpen = !panelOpen;
  renderPanel();
};

// ---------- Рендер и маршрутизация ----------
$('#nav').innerHTML = ROUTES.map(([p, t, i]) => `<a href="#/${p}" data-p="${p}" title="${t}" aria-label="${t}">${ic(i, 22)}<span>${t}</span></a>`).join('');
function render() {
  const { p, id, key } = route();
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.p === (p === 'room' ? 'rooms' : p)));
  const v = $('#view');
  v.innerHTML = '';
  if (!S.me) v.append(welcome());
  else if (p === 'room') {
    v.append(roomPage(id));
    if ((!S.cur || S.cur.id !== id) && failed !== id) joinRoom(id, key);
  } else v.append(({ home, discover, rooms, messages, profile }[p] || home)());
  renderPanel();
  updateBar();
}
addEventListener('hashchange', () => { failed = 0; $('#bar').classList.remove('full'); render(); });

// ---------- Соединение ----------
function onMsg(m) {
  if (m.type === 'presence') { clearTimeout(timer); timer = setTimeout(refresh, 300); }
  else if (m.type === 'gone') { if (S.cur && S.cur.id === m.room) { leaveRoom(false); go('#/rooms'); } refresh(); }
  else if (m.type === 'error') {
    if (m.code === 'perm') flash('Управлять воспроизведением может только хозяин комнаты');
    else { leaveRoom(false); joinErr = m.code === 'full' ? 'Комната заполнена. Попробуйте позже.' : 'У вас нет доступа к этой комнате.'; failed = m.room; render(); }
  } else { onState(m); renderPanel(); roomHead(); }
}

async function enterApp() {
  S.me = await api('/api/me');
  connect({ open: () => S.cur && send({ type: 'join', room: S.cur.id }), msg: onMsg });
  await Promise.all([loadRooms(), loadTracks(), loadFriends()]);
  if (!location.hash) go('#/home');
  render();
}

api('/api/me').then((u) => (u ? enterApp() : render())).catch(render);
