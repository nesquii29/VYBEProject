// Оболочка: навигация, разделы, комнаты, обзор, друзья, настройки, окна
import { S, $, el, api, send, ic, connect, canControl, canRoom } from './core.js';
import { onState, stopAudio, updateBar, playPersonal } from './player.js';

const ROUTES = [['home', 'Главная', 'home'], ['discover', 'Обзор', 'compass'], ['rooms', 'Комнаты', 'rooms'], ['messages', 'Сообщения', 'chat'], ['profile', 'Профиль', 'user']];
const MOODS = [['Спокойно', '#6C8BFF'], ['Заряд', '#FF6B9A'], ['Ночь', '#A27BFF']];
let panelOpen = true, tab = 'queue', timer = null, dt = null, lastSeq = -1, guard = null;
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
const avaEl = (name, url, cls = '') => { // круглый аватар или буква-заглушка
  const a = el('div', url ? '' : (name || '?')[0].toUpperCase(), 'ava ' + cls);
  if (url) { const i = el('img'); i.src = url; i.alt = ''; a.append(i); }
  return a;
};
const recent = () => JSON.parse(localStorage.getItem('recent') || '[]');
const flash = (t) => { $('#bS').textContent = t; setTimeout(updateBar, 3000); };

// ---------- Уведомления и выпадающее меню ----------
function toast(text, kind = '') {
  const t = el('div', text, 'toast ' + kind);
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, 4000);
}
function menu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const m = el('div', '', 'menu');
  m.setAttribute('role', 'menu');
  items.forEach(([label, fn, off]) => { const b = btn(label, () => { m.remove(); fn(); }); b.setAttribute('role', 'menuitem'); b.disabled = !!off; m.append(b); });
  anchor.parentElement.append(m);
  const bs = [...m.querySelectorAll('button:not(:disabled)')];
  if (bs[0]) bs[0].focus();
  m.onkeydown = (e) => {
    const i = bs.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length].focus(); }
    else if (e.key === 'Escape') { m.remove(); anchor.focus(); }
  };
}
document.addEventListener('click', (e) => { if (!e.target.closest('.menu') && !e.target.closest('[aria-haspopup]')) document.querySelectorAll('.menu').forEach((m) => m.remove()); });

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
// Клик по затемнённому фону закрывает окно (Escape закрывает его штатно)
$('#mdl').addEventListener('click', (e) => {
  const d = e.currentTarget, r = d.getBoundingClientRect();
  if ((e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) && (!guard || guard())) d.close();
});
$('#mdl').addEventListener('cancel', (e) => { if (guard && !guard()) e.preventDefault(); });
$('#mdl').addEventListener('close', () => { guard = null; $('#mdl').classList.remove('wide'); });
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
const loadHome = async () => { S.home = await api('/api/home'); };
const loadStreaks = async () => { S.streaks = Object.fromEntries((await api('/api/streaks')).map((x) => [x.id, x])); };
async function refresh() {
  await Promise.all([loadRooms(), loadFriends(), loadHome(), loadStreaks()]).catch(() => {});
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
    S.cur = r; S.st = {}; S.q = null;
    chatView(); chatStatus();
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
  chatReset();
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
  if (!pend) {
    const sv = (S.streaks || {})[f.id] || { current: 0, longest: 0 };
    const sb = btn(String(sv.current), () => streakModal(f), 'chip streak' + (sv.current ? ' on' : ''));
    sb.insertAdjacentHTML('afterbegin', ic('flame', 14));
    sb.title = sv.current ? 'Серия с ' + f.name + ': ' + sv.current + ' дн.' : sv.longest ? 'Серия прервана. Нажмите, чтобы узнать подробности' : 'Серии пока нет. Нажмите, чтобы узнать, как её начать';
    sb.setAttribute('aria-label', 'Серия прослушивания с ' + f.name + ': ' + sv.current + ' дн.');
    a.push(sb);
  }
  a.push(btn(pend ? (f.dir === 'in' ? 'Отклонить' : 'Отмена') : 'Удалить', async () => { await api('/api/friends/' + f.id, 'DELETE'); refresh(); }));
  const r = item('', st, ...a), t = r.querySelector('.tt'), l = el('a', f.display_name || f.name);
  l.href = '#/user/' + f.id; l.style.color = 'inherit';
  t.append(l, document.createTextNode(' #' + f.tag));
  r.insertBefore(avaEl(f.display_name || f.name, f.avatar), r.firstChild);
  return r;
}

// ---------- Профиль ----------
const GENRE_LABELS = { 'hip-hop': 'Хип-хоп', rap: 'Рэп', pop: 'Поп', electronic: 'Электроника', rock: 'Рок', indie: 'Инди', rnb: 'R&B', jazz: 'Джаз', ambient: 'Эмбиент', classical: 'Классика', metal: 'Метал', alternative: 'Альтернатива', other: 'Другое' };
const PRESET_LABELS = { listening: '🎧 Слушаю музыку', late: '🌙 Поздний вайб', gaming: '🎮 Играю', studying: '📚 Учусь', away: '💤 Отошёл', thoughts: '💭 Задумался', available: '✨ На связи', dnd: '🔕 Не беспокоить' };
const ACCENT_LIST = [['lavender', 'Лаванда', '#9AA5FF'], ['blue', 'Синий', '#6FA8FF'], ['mint', 'Мята', '#6FD0A8'], ['pink', 'Розовый', '#F08DB2'], ['amber', 'Янтарь', '#F0B35C'], ['rose', 'Роза', '#E87979']];

async function onProfileEvent(id) {
  try {
    if (id === S.me.id) { S.me = { ...S.me, ...(await api('/api/me')) }; renderMe(); }
    await loadFriends();
  } catch {}
  const r = route();
  if ((r.p === 'user' && r.id === id) || (r.p === 'profile' && id === S.me.id) || r.p === 'messages' || r.p === 'home') render();
}
function userPage(id) { const slot = el('div'); showProfile(slot, id); return page(slot); }
async function showProfile(slot, id) {
  slot.append(el('div', '', 'skel'));
  try { slot.replaceChildren(profileCard(await api('/api/profile/' + id))); }
  catch (e) { slot.replaceChildren(empty(e.message, btn('На главную', () => go('#/home')))); }
}

function favTrack(t, own) {
  const d = el('div', '', 'trk'), art = el('div', '', 'art'), info = el('div', '', 'grow'), can = !t.unavailable && (t.source === 'soundcloud' || own);
  if (t.art) { const im = el('img'); im.src = t.art; im.alt = ''; im.loading = 'lazy'; art.append(im); } else art.innerHTML = ic('note', 20);
  info.append(el('div', t.title, 'tt'), el('div', t.unavailable ? 'Трек недоступен' : t.artist || (t.source === 'upload' ? 'Моя загрузка' : ''), 'mu s'));
  d.append(art, info, el('span', t.source === 'soundcloud' ? 'SoundCloud' : 'MP3', 'chip'));
  if (can) {
    const pl = btn('', () => (S.cur ? toast('Вы в комнате. Выйдите из неё, чтобы послушать трек лично.') : playPersonal(t)), 'ico');
    pl.innerHTML = ic('play', 18); pl.title = 'Слушать (только у вас)'; pl.setAttribute('aria-label', 'Слушать: ' + t.title);
    d.append(pl);
  }
  if (t.source === 'soundcloud' && t.url) { // официальная ссылка на источник
    const a = el('a', 'Открыть', 'chip'); a.href = t.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.setAttribute('aria-label', 'Открыть на SoundCloud: ' + t.title);
    d.append(a);
  }
  return d;
}

function profileCard(p) {
  const own = p.rel === 'me', root = el('div', '', 'pf st-' + p.style), ban = el('div', '', 'pf-ban');
  root.style.setProperty('--pa', p.accent); // цвет проверен сервером, это только значение переменной
  if (p.banner) ban.style.backgroundImage = 'url("' + p.banner + '")';
  const head = el('div', '', 'pf-head'), av = avaEl(p.display_name, p.avatar, 'xl'), info = el('div', '', 'grow'), acts = row();
  if (p.online) { const d = el('i', '', 'on'); d.title = 'В сети'; av.append(d); }
  info.append(el('h1', p.display_name), el('p', '@' + p.name + ' · #' + p.tag, 'mu s'));
  if (p.status) info.append(el('span', p.status, 'chip pf-st'));
  if (p.bio) info.append(el('p', p.bio, 'pf-bio'));
  else if (own) info.append(el('p', 'Расскажите о себе в редакторе профиля.', 'mu s'));
  if (own) acts.append(btn('Редактировать профиль', () => editProfile(p), 'pri'));
  if (p.streak) {
    const sb = btn(String(p.streak.current), () => streakModal({ id: p.id, name: p.display_name }), 'chip streak' + (p.streak.current ? ' on' : ''));
    sb.insertAdjacentHTML('afterbegin', ic('flame', 14)); sb.setAttribute('aria-label', 'Общая серия: ' + p.streak.current + ' дн.');
    acts.append(sb);
  }
  if (p.activity && p.activity.state === 'room') acts.append(btn('Зайти в комнату', () => open(p.activity.room), 'pri'));
  info.append(acts);
  head.append(av, info);
  root.append(ban, head);
  if (p.activity) {
    const a = p.activity;
    root.append(el('p', a.state === 'room' ? (a.playing && a.track ? 'Слушает «' + a.track.title + '»' + (a.track.artist ? ' — ' + a.track.artist : '') : 'В комнате «' + a.room.name + '»') : 'Сейчас ничего не слушает', 'mu pf-act'));
  }
  const edit = () => editProfile(p);
  if (p.featured) { const f = el('div', '', 'pf-feat'); f.append(el('div', 'Избранный трек', 'lbl'), favTrack(p.featured, own)); root.append(f); }
  else if (own) root.append(empty('Выберите избранный трек, он появится здесь крупной карточкой.', btn('Выбрать', edit)));
  if (p.genres && p.genres.length) { const g = el('div', '', 'row'); p.genres.forEach((x) => g.append(el('span', GENRE_LABELS[x] || x, 'gen'))); root.append(g); }
  else if (own) root.append(empty('Отметьте любимые жанры.', btn('Выбрать', edit)));
  if (p.tracks && p.tracks.length) { const l = el('div'); p.tracks.forEach((t) => l.append(favTrack(t, own))); root.append(el('h2', 'На повторе'), l); }
  else if (own) root.append(empty('Добавьте любимые треки (до 10) из своей библиотеки.', btn('Добавить', edit)));
  return root;
}

async function editProfile(p) {
  try { await loadTracks(); } catch {}
  const st = { accent: p.accent, style: p.style, genres: new Set(p.genres || []), vis: { ...p.vis }, avatar: null, banner: null, rmAva: false, rmBan: false, clearStatus: false, favs: (p.tracks || []).map((t) => t.id), featured: p.featured ? p.featured.id : null };
  let dirty = false;
  const mark = () => { dirty = true; };
  modal('Редактировать профиль', (b, close) => {
    $('#mdl').classList.add('wide');
    guard = () => !dirty || confirm('Закрыть без сохранения? Изменения будут потеряны.');
    const f = el('form'), msg = el('p', '', 'msg'), s2 = (title, ...k) => { const d = el('div', '', 'edsec'); d.append(el('h2', title), ...k); return d; };
    msg.setAttribute('role', 'status');
    const counter = (i, max) => { const c = el('span', '', 'mu s'); const u = () => { c.textContent = i.value.length + '/' + max; }; i.addEventListener('input', u); u(); return c; };
    const toggle = (t, on, fn) => { const x = btn(t, () => { fn(); x.setAttribute('aria-pressed', String(!(x.getAttribute('aria-pressed') === 'true'))); mark(); }, 'gb'); x.setAttribute('aria-pressed', String(on)); return x; };

    // Основное
    const name = inp('Имя', p.display_name), bio = el('textarea');
    name.maxLength = 32; bio.maxLength = 160; bio.value = p.bio || ''; bio.placeholder = 'О себе (необязательно)';
    const basic = s2('Основное', field('Отображаемое имя', name), counter(name, 32), field('О себе', bio), counter(bio, 160), el('p', 'Логин @' + p.name + ' и тег #' + p.tag + ' не меняются.', 'mu s'));

    // Аватар и баннер
    const imgField = (label, cur, mb, key, rmKey) => {
      const w = el('div'), pv = el('img'), file = inp('', '', 'file');
      pv.className = 'pf-pv'; pv.alt = 'Предпросмотр: ' + label; if (cur) pv.src = cur; else pv.hidden = true;
      file.accept = 'image/jpeg,image/png,image/webp'; file.setAttribute('aria-label', label);
      file.onchange = () => { const x = file.files[0]; if (!x) return; if (x.size > mb * 1048576) { toast('Файл больше ' + mb + ' МБ', 'err'); file.value = ''; return; } st[key] = x; st[rmKey] = false; pv.src = URL.createObjectURL(x); pv.hidden = false; mark(); };
      w.append(el('label', label + ' (JPEG, PNG или WebP, до ' + mb + ' МБ)', 'lbl'), pv, row(file, btn('Убрать', () => { st[key] = null; st[rmKey] = true; pv.hidden = true; file.value = ''; mark(); })));
      return w;
    };
    const media = s2('Аватар и баннер', imgField('Аватар', p.avatar, 5, 'avatar', 'rmAva'), imgField('Баннер', p.banner, 8, 'banner', 'rmBan'));

    // Статус
    const preset = sel([['', 'Свой вариант']].concat(Object.entries(PRESET_LABELS)), ''), text = inp('Или своё сообщение', ''), hours = sel([['0', 'Без срока'], ['1', '1 час'], ['8', '8 часов'], ['24', '24 часа']], '0');
    text.maxLength = 60;
    const stRow = [field('Готовый статус', preset), field('Своё сообщение', text), counter(text, 60), field('Сколько показывать', hours)];
    if (p.status) stRow.unshift(el('p', 'Сейчас: ' + p.status, 'mu'), btn('Очистить статус', () => { st.clearStatus = true; mark(); toast('Статус будет очищен при сохранении'); }));
    const status = s2('Статус', ...stRow, el('p', 'Статус не влияет на присутствие: «Не беспокоить» не делает вас «не в сети».', 'mu s'));

    // Оформление
    const custom = inp('Свой цвет, например #8C9BFF', ''), sw = el('div', '', 'row');
    ACCENT_LIST.forEach(([k, label, hex]) => { const x = btn('', () => { st.accent = k; custom.value = ''; sw.querySelectorAll('.sw').forEach((y) => y.setAttribute('aria-pressed', String(y === x))); mark(); }, 'sw'); x.style.background = hex; x.title = label; x.setAttribute('aria-label', 'Цвет: ' + label); x.setAttribute('aria-pressed', String(hex === p.accent)); sw.append(x); });
    const style = sel([['minimal', 'Минимальный'], ['midnight', 'Полночь'], ['artist', 'Артист']], p.style);
    const look = s2('Оформление', sw, field('Свой цвет (необязательно)', custom), field('Стиль профиля', style));

    // Жанры
    const gs = el('div', '', 'row');
    Object.entries(GENRE_LABELS).forEach(([k, label]) => gs.append(toggle(label, st.genres.has(k), () => { if (st.genres.has(k)) st.genres.delete(k); else if (st.genres.size >= 5) { toast('Не больше 5 жанров', 'err'); throw new Error('limit'); } else st.genres.add(k); })));
    const genres = s2('Любимые жанры (до 5)', gs);

    // Избранные треки
    const favBox = el('div');
    const drawFavs = () => {
      favBox.replaceChildren();
      const byId = new Map(S.tracks.map((t) => [t.id, t]));
      st.favs = st.favs.filter((id) => byId.has(id) || (p.tracks || []).some((t) => t.id === id));
      st.favs.forEach((id, i) => {
        const t = byId.get(id) || p.tracks.find((x) => x.id === id), r = el('div', '', 'item');
        const radio = inp('', '', 'radio'); radio.name = 'feat'; radio.checked = st.featured === id; radio.style.cssText = 'width:auto;min-height:0;margin:0'; radio.setAttribute('aria-label', 'Избранный трек: ' + t.title);
        radio.onchange = () => { st.featured = id; mark(); };
        const tt = el('div', '', 'grow'); tt.append(el('div', t.title, 'tt'), el('div', (t.source === 'soundcloud' ? 'SoundCloud' : 'MP3, виден только вам') + (st.featured === id ? ' · избранный' : ''), 'mu s'));
        const mv = (d) => () => { const j = i + d; if (j < 0 || j >= st.favs.length) return; [st.favs[i], st.favs[j]] = [st.favs[j], st.favs[i]]; mark(); drawFavs(); };
        const up = btn('↑', mv(-1)), dn = btn('↓', mv(1)), rm = btn('✕', () => { st.favs.splice(i, 1); if (st.featured === id) st.featured = null; mark(); drawFavs(); });
        up.setAttribute('aria-label', 'Выше'); dn.setAttribute('aria-label', 'Ниже'); rm.setAttribute('aria-label', 'Убрать из избранного'); up.disabled = i === 0; dn.disabled = i === st.favs.length - 1;
        r.append(radio, tt, row(up, dn, rm)); favBox.append(r);
      });
      const rest = S.tracks.filter((t) => !st.favs.includes(t.id));
      if (rest.length) { favBox.append(el('p', 'Добавить из библиотеки (' + st.favs.length + ' из 10)', 'lbl')); rest.forEach((t) => { const a = btn('Добавить', () => { st.favs.push(t.id); mark(); drawFavs(); }); a.disabled = st.favs.length >= 10; favBox.append(item(t.title, t.source === 'soundcloud' ? 'SoundCloud' : 'MP3 (виден только вам)', a)); }); }
      else if (!st.favs.length) favBox.append(empty('В библиотеке пока нет треков. Загрузите MP3 или добавьте трек SoundCloud на главной.'));
    };
    drawFavs();
    const favs = s2('Избранные треки', el('p', 'Отметьте кружком избранный трек. Ваши MP3 другие пользователи не увидят и не смогут послушать.', 'mu s'), favBox);

    // Приватность
    const vis = {}, V = [['everyone', 'Все'], ['friends', 'Только друзья'], ['me', 'Только я']];
    const priv = s2('Приватность');
    [['bio', 'О себе'], ['genres', 'Жанры'], ['tracks', 'Избранные треки'], ['featured', 'Избранный трек'], ['activity', 'Что слушаю сейчас']].forEach(([k, label]) => { vis[k] = sel(V, st.vis[k]); vis[k].onchange = () => { st.vis[k] = vis[k].value; }; priv.append(field(label, vis[k])); });

    f.append(basic, media, status, look, genres, favs, priv, msg);
    const save = el('button', 'Сохранить', 'pri'), cancel = btn('Отмена', () => { if (guard()) close(); });
    f.append(row(save, cancel));
    f.addEventListener('input', mark); f.addEventListener('change', mark);
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      save.disabled = true; save.setAttribute('aria-busy', 'true'); msg.className = 'msg'; msg.textContent = 'Сохраняю…';
      const errs = [], run = async (label, fn) => { try { await fn(); } catch (e) { errs.push(label + ': ' + e.message); } };
      const body = { display_name: name.value, bio: bio.value, style: style.value, genres: [...st.genres], accent: custom.value.trim() || st.accent };
      Object.entries(st.vis).forEach(([k, v]) => { body['vis_' + k] = v; });
      if (st.clearStatus) body.status = null; else if (preset.value || text.value.trim()) body.status = { preset: preset.value || undefined, text: text.value, hours: +hours.value };
      const upload = async (kind, file) => { const fd = new FormData(); fd.append('file', file); await api('/api/profile/' + kind, 'PUT', fd); };
      await run('Профиль', () => api('/api/profile', 'PUT', body));
      if (st.avatar) await run('Аватар', () => upload('avatar', st.avatar)); else if (st.rmAva) await run('Аватар', () => api('/api/profile/avatar', 'DELETE'));
      if (st.banner) await run('Баннер', () => upload('banner', st.banner)); else if (st.rmBan) await run('Баннер', () => api('/api/profile/banner', 'DELETE'));
      await run('Избранное', () => api('/api/profile/favorites', 'PUT', { tracks: st.favs, featured: st.featured }));
      save.disabled = false; save.removeAttribute('aria-busy');
      if (errs.length) { msg.className = 'msg err'; msg.textContent = 'Не всё сохранено. ' + errs.join(' · '); return; } // успешные части уже сохранены, окно остаётся открытым
      dirty = false; close(); toast('Профиль сохранён', 'ok');
      S.me = { ...S.me, ...(await api('/api/me')) }; renderMe(); render();
    };
    b.append(f);
  });
}

async function streakModal(f) {
  let d;
  try { d = await api('/api/streaks/' + f.id); } catch (e) { return toast(e.message, 'err'); }
  modal('Серия с ' + f.name, (b, close) => {
    const state = d.current ? 'Серия активна' : d.longest ? 'Серия прервана. Она начнётся заново, когда вы снова послушаете вместе' : 'Серии пока нет';
    const list = el('div', '', 'row');
    d.days.forEach((x) => list.append(el('span', x, 'chip')));
    b.append(el('h1', d.current + ' дн.'), el('p', state, 'mu'),
      el('p', 'Рекорд: ' + d.longest + ' дн. · Последний общий день: ' + (d.last || '—'), 'mu s'),
      el('p', d.today ? 'Сегодня уже засчитано.' : 'Сегодня: ' + d.progress + ' из ' + d.rules.minutes + ' мин совместного прослушивания.'),
      el('h2', 'Последние общие дни'), d.days.length ? list : el('p', 'Пока нет общих дней.', 'mu s'),
      el('h2', 'Как засчитывается день'),
      el('p', 'Вы оба в одной комнате, где играет музыка, и вместе набрали не меньше ' + d.rules.minutes + ' минут за сутки по UTC. Время считает сервер по тому, кто подключён и играет ли комната. Подтвердить, что звук реально слышен, он не может. Если пропустить целые сутки, серия начнётся заново, рекорд сохранится. Бонусов за пропуск нет.', 'mu s'),
      row(btn('Закрыть', close, 'pri')));
    b.children[0].style.marginBottom = 'var(--s2)';
  });
}

function uploadBtn(cls = 'pri') {
  const l = el('label', 'Загрузить MP3', 'btn ' + cls), i = inp('', '', 'file');
  i.accept = '.mp3,audio/mpeg'; i.hidden = true;
  i.onchange = async () => {
    const f = i.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    try { await api('/api/tracks', 'POST', fd); await loadTracks(); render(); } catch (e) { toast(e.message, 'err'); }
  };
  l.append(i);
  return l;
}

// Единый компонент строки трека (библиотека, комната, профиль)
function trackRow(t) {
  const room = canRoom(), solo = !S.cur, d = el('div', '', 'trk'), art = el('div', '', 'art'), info = el('div', '', 'grow');
  if (t.art) { const im = el('img'); im.src = t.art; im.alt = ''; im.loading = 'lazy'; art.append(im); } else art.innerHTML = ic('note', 20);
  info.append(el('div', t.title, 'tt'), el('div', t.artist || 'Моя загрузка', 'mu s'));
  const now = () => (S.cur ? send({ type: 'track', id: t.id }) : playPersonal(t));
  const play = btn('', now, 'ico play');
  play.innerHTML = ic('play', 18);
  play.title = solo ? 'Слушать (только у вас)' : room ? 'Играть сейчас в комнате' : 'В этой комнате воспроизведением управляет хозяин';
  play.setAttribute('aria-label', 'Слушать: ' + t.title);
  play.disabled = !(solo || room);
  const more = btn('', () => menu(more, [
    ['В очередь комнаты', () => send({ type: 'qadd', track: t.id }), !room],
    [solo ? 'Слушать (только у вас)' : 'Играть сейчас', now, !(solo || room)],
    ['Удалить из библиотеки', () => removeTrack(t)],
  ]), 'ico');
  more.innerHTML = ic('more', 20);
  more.setAttribute('aria-label', 'Действия с треком');
  more.setAttribute('aria-haspopup', 'menu');
  const wrap = el('div', '', 'rel');
  wrap.append(more);
  d.append(art, info, el('span', t.source === 'soundcloud' ? 'SoundCloud' : 'MP3', 'chip'), play, wrap);
  return d;
}
async function removeTrack(t) {
  if (!confirm('Удалить «' + t.title + '» из библиотеки?')) return;
  try { await api('/api/tracks/' + t.id, 'DELETE'); await loadTracks(); render(); toast('Трек удалён', 'ok'); } catch (e) { toast(e.message, 'err'); }
}
function trackRows(list) {
  const box = el('div');
  list.forEach((t) => box.append(trackRow(t)));
  return box;
}

// Вкладка «Очередь»: текущий трек, дальше по порядку; кнопки только тем, у кого есть право
function queueView() {
  if (S.q === null) return el('p', 'Загрузка очереди…', 'mu');
  const box = el('div'), ctl = canControl(), now = el('div', '', 'qnow');
  if (S.st.seq !== lastSeq) { now.classList.add('swap'); lastSeq = S.st.seq; }
  now.append(el('div', S.st.track ? S.st.track.title : 'Сейчас ничего не играет', 'tt'), el('div', S.st.track ? 'Добавил ' + (S.st.by || '—') : 'Комната ждёт трек', 'mu s'));
  box.append(el('div', 'Сейчас играет', 'lbl'), now);
  if (ctl && S.st.track) box.append(btn('Пропустить', () => send({ type: 'skip' })));
  box.append(el('div', 'Далее · ' + S.q.length, 'lbl'));
  if (!S.q.length) box.append(empty(ctl ? 'Очередь пуста. Добавьте треки из своей музыки на странице комнаты.' : 'Очередь пуста.'));
  S.q.forEach((x, i) => {
    const r = el('div', '', 'item qi'), t = el('div', '', 'grow'), a = row();
    t.append(el('div', x.title, 'tt'), el('div', 'добавил ' + x.by, 'mu s'));
    r.append(t);
    if (ctl) {
      const b2 = (g, label, fn, off) => { const b = btn(g, fn); b.title = label; b.setAttribute('aria-label', label); b.disabled = !!off; a.append(b); };
      b2('▶', 'Играть сейчас', () => send({ type: 'qplay', id: x.id }));
      b2('↑', 'Выше', () => send({ type: 'qmove', id: x.id, to: i - 1 }), i === 0);
      b2('↓', 'Ниже', () => send({ type: 'qmove', id: x.id, to: i + 1 }), i === S.q.length - 1);
      b2('✕', 'Убрать', () => send({ type: 'qremove', id: x.id }));
      r.append(a);
    }
    box.append(r);
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

// Импорт музыки: ссылка SoundCloud (официальный oEmbed на сервере + Widget API в плеере) или свой MP3
function importCard(onAdded) {
  const c = el('div', '', 'import'), f = el('form'), box = el('div', '', 'row'), field = el('div', '', 'field'), i = el('input'), msg = el('p', '', 'msg'), go = el('button', 'В очередь', 'pri');
  c.append(el('h2', 'Принесите свою музыку в VYBE'), el('p', 'Вставьте ссылку на трек SoundCloud или загрузите MP3 из своей библиотеки.', 'mu'));
  msg.setAttribute('role', 'status');
  i.type = 'url'; i.placeholder = 'Вставьте ссылку на трек SoundCloud…'; i.autocomplete = 'off'; i.setAttribute('aria-label', 'Ссылка на трек SoundCloud');
  f.noValidate = true;
  field.append(el('span', 'SoundCloud', 'chip'), i);
  box.append(field, go, uploadBtn(''));
  f.append(box, msg);
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const url = i.value.trim();
    if (!url) { msg.className = 'msg err'; msg.textContent = 'Вставьте ссылку на трек'; return i.focus(); }
    go.disabled = true; go.setAttribute('aria-busy', 'true');
    msg.className = 'msg'; msg.textContent = 'Проверяю ссылку в SoundCloud…';
    try {
      const t = await api('/api/soundcloud', 'POST', { url });
      await loadTracks();
      i.value = '';
      msg.className = 'msg ok'; msg.textContent = 'Найдено: ' + t.title + (t.artist ? ' — ' + t.artist : '') + '. Трек сохранён в вашей библиотеке.';
      onAdded();
      if (S.cur && canControl()) { send({ type: 'qadd', track: t.id }); toast('Добавляю в очередь: ' + t.title, 'ok'); }
      else if (S.cur) toast('Трек сохранён в библиотеке. В этой комнате очередью управляет хозяин.');
      else toast('Трек сохранён в библиотеке. Зайдите в комнату, чтобы добавить его в очередь.');
    } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
    go.disabled = false; go.removeAttribute('aria-busy');
  };
  c.append(f);
  return c;
}

function liveCard(r) {
  const c = el('div', '', 'trk'), art = el('div', '', 'art'), info = el('div', '', 'grow'), full = r.max && r.online >= r.max && S.me.id !== r.oid;
  if (r.track && r.track.art) { const im = el('img'); im.src = r.track.art; im.alt = ''; im.loading = 'lazy'; art.append(im); } else art.innerHTML = ic('note', 20);
  info.append(el('div', r.track ? r.track.title : r.name, 'tt'), el('div', (r.track && r.track.artist ? r.track.artist + ' · ' : '') + r.name + ' · хозяин ' + r.owner + ' · слушают: ' + r.online, 'mu s'));
  const j = btn(full ? 'Заполнено' : 'Войти', () => open(r), 'pri');
  j.disabled = !!full;
  c.append(art, info);
  if (r.track) c.append(el('span', r.track.source === 'soundcloud' ? 'SoundCloud' : 'MP3', 'chip'));
  c.append(j);
  return c;
}
function homeLive() {
  const H = S.home || { listening: [], popular: [], kind: 'score' }, out = [];
  const l = el('div');
  if (H.listening.length) H.listening.forEach((r) => l.append(liveCard(r)));
  else l.append(empty('Сейчас в публичных комнатах никто не слушает музыку.', row(btn('Открыть Обзор', () => go('#/discover')), btn('Создать комнату', () => roomModal(), 'pri'))));
  out.push(sec('Сейчас слушают', l));
  if (H.popular.length) {
    const p = el('div');
    if (H.kind === 'score') p.append(el('p', 'Рейтинг внутри VYBE: слушатели, играющая музыка и недавняя активность.', 'mu s'));
    H.popular.forEach((r) => p.append(liveCard(r)));
    out.push(sec(H.kind === 'score' ? 'Популярное сейчас' : 'Недавно активные комнаты', p));
  }
  return out;
}

function home() {
  const h = new Date().getHours(), hi = h < 6 ? 'Доброй ночи' : h < 12 ? 'Доброе утро' : h < 18 ? 'Добрый день' : 'Добрый вечер';
  const head = el('div'), libBox = el('div');
  head.append(el('h1', hi + ', ' + S.me.name), el('p', 'Что слушаем сегодня?', 'mu'));
  const lib = () => libBox.replaceChildren(S.tracks.length ? trackRows(S.tracks.slice(0, 8)) : empty('Здесь появятся ваши треки. Вставьте ссылку SoundCloud выше или загрузите MP3.'), ...(S.tracks.length > 8 ? [btn('Вся библиотека', () => go('#/profile'))] : []));
  lib();
  const imp = importCard(lib);
  imp.style.marginTop = 'var(--s5)';
  const out = [head, imp, ...homeLive()];
  const live = S.friends.filter((f) => f.status === 'ok' && f.room);
  if (live.length) { const fr = el('div'); live.forEach((f) => fr.append(friendRow(f))); out.push(sec('Друзья слушают', fr)); }
  const rec = recent().map((id) => S.rooms.find((r) => r.id === id)).filter(Boolean).slice(0, 4);
  if (rec.length) out.push(sec('Недавние комнаты', grid(rec, '')));
  out.push(sec('Моя музыка', libBox));
  return page(...out);
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
  const slot = el('div');
  showProfile(slot, me.id);
  const out = [slot, acc, sec('Оформление', look), sec('Моя музыка', libHead, S.tracks.length ? trackRows(S.tracks) : empty('В библиотеке пока пусто.'))];
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
  $('#rSub').textContent = S.st.track ? 'Слушают: ' + (S.st.users || 1) + (S.st.by ? ' · добавил ' + S.st.by : '') : canControl() ? 'Выберите трек ниже' : 'Ждём, пока хозяин выберет трек';
}

// ---------- Чат комнаты (сообщения хранятся на сервере, текст выводится только как textContent) ----------
const chat = { el: null, list: null, note: null, input: null, ids: new Set(), unread: 0, more: false, loaded: false };
let sendLock = 0;
const chatVisible = () => route().p === 'room' && !!S.cur && panelOpen && tab === 'chat';
function chatView() {
  if (chat.el) return chat.el;
  const w = el('div', '', 'chat'), f = el('form', '', 'cform'), i = el('textarea');
  chat.note = el('div'); chat.list = el('div', '', 'msgs');
  i.rows = 1; i.maxLength = 500; i.placeholder = 'Сообщение…'; i.setAttribute('aria-label', 'Сообщение в чат комнаты');
  f.append(i, el('button', 'Отправить', 'pri'));
  f.onsubmit = (ev) => { ev.preventDefault(); sendChat(); };
  i.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendChat(); } };
  w.append(chat.note, chat.list, f);
  Object.assign(chat, { el: w, input: i });
  chatStatus();
  return w;
}
function chatStatus() {
  if (!chat.note) return;
  const n = chat.note;
  n.replaceChildren();
  if (!chat.loaded) n.append(el('p', 'Загрузка истории…', 'mu s'));
  else {
    if (chat.more) n.append(btn('Показать более ранние', () => send({ type: 'chat:older', before: Math.min(...chat.ids) }), 'link'));
    if (!chat.ids.size) n.append(el('p', 'Пока нет сообщений. Напишите первым!', 'mu s'));
  }
  if (!wsOn) n.append(el('p', 'Нет соединения, переподключаюсь…', 'mu s'));
}
function chatReset() {
  chat.ids = new Set(); chat.unread = 0; chat.more = false; chat.loaded = false;
  if (chat.list) chat.list.replaceChildren();
  chatStatus();
  $('#bPanel').classList.remove('dot');
}
function addMsg(m, front) {
  if (!chat.list || chat.ids.has(m.id)) return;
  chat.ids.add(m.id);
  const d = el('div', '', 'msg'), a = el('div', m.name[0].toUpperCase(), 'ava sm'), b = el('div', '', 'grow'), h = el('div', '', 'mh');
  h.append(el('span', m.name, 'mn'), el('span', new Date(m.created).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), 'mu s'));
  b.append(h, el('div', m.text, 'mt'));
  d.append(a, b);
  const l = chat.list, near = l.scrollHeight - l.scrollTop - l.clientHeight < 80;
  if (front) l.prepend(d); else { l.append(d); if (near || m.uid === S.me.id) l.scrollTop = l.scrollHeight; }
  if (!front && !m.history && m.uid !== S.me.id && !chatVisible()) { chat.unread++; $('#bPanel').classList.add('dot'); renderPanel(); }
}
function sendChat() {
  const text = chat.input.value.trim();
  if (!text || Date.now() < sendLock) return;
  if (!send({ type: 'chat:send', text, cid: Math.random().toString(36).slice(2) })) return toast('Нет соединения. Сообщение не отправлено.', 'err');
  sendLock = Date.now() + 400; // защита от двойной отправки
  chat.input.value = '';
}
function onChat(m) {
  if (m.type === 'chat:error') return toast({ empty: 'Пустое сообщение', long: 'Сообщение длиннее 500 символов', rate: 'Слишком часто. Подождите несколько секунд.', perm: 'Нет доступа к чату этой комнаты' }[m.code] || 'Сообщение не отправлено', 'err');
  if (!S.cur || m.room !== S.cur.id) return;
  if (m.type === 'chat:message') { addMsg(m); chatStatus(); return; }
  if (m.type === 'chat:history') {
    const items = m.older ? [...m.items].reverse() : m.items;
    items.forEach((x) => addMsg({ ...x, history: true }, m.older));
    chat.loaded = true; chat.more = m.more;
    chatStatus();
    if (!m.older) chat.list.scrollTop = chat.list.scrollHeight;
  }
}

// ---------- Правая панель комнаты ----------
function renderPanel() {
  const { p } = route(), show = p === 'room' && S.cur && panelOpen;
  $('#panel').hidden = !show;
  document.body.classList.toggle('with-panel', !!show); // плеер SoundCloud сдвигается, чтобы не закрывать чат
  $('#bPanel').hidden = !S.cur;
  if (!show) return;
  if (tab === 'chat') { chat.unread = 0; $('#bPanel').classList.remove('dot'); }
  $('#tabs').innerHTML = '';
  [['chat', 'Чат'], ['queue', 'Очередь'], ['who', 'Слушатели']].forEach(([k, t]) => $('#tabs').append(btn(t + (k === 'chat' && chat.unread ? ' · ' + chat.unread : ''), () => { tab = k; renderPanel(); }, tab === k ? 'on' : '')));
  const b = $('#pbody'), keep = b.scrollTop;
  if (tab === 'chat' && chat.el && b.firstChild === chat.el) return; // не пересобираем чат, чтобы не терять введённый текст
  b.innerHTML = '';
  if (tab === 'who') (S.st.names || []).forEach((n) => b.append(item(n, n === S.cur.owner ? 'хозяин' : n === S.me.name ? 'вы' : 'слушает')));
  else if (tab === 'queue') b.append(queueView());
  else b.append(chatView());
  b.scrollTop = keep;
}
$('#bPanel').onclick = () => {
  if (route().p !== 'room') { panelOpen = true; return go('#/room/' + S.cur.id); }
  panelOpen = !panelOpen;
  renderPanel();
};

// Профиль внизу боковой панели: аватар, имя, тег, статус соединения
let wsOn = false;
function renderMe() {
  const m = $('#me');
  m.hidden = !S.me;
  if (!S.me) return;
  m.innerHTML = '';
  const a = avaEl(S.me.display_name || S.me.name, S.me.avatar), dot = el('i', '', wsOn ? 'on' : ''), t = el('div', '', 'grow');
  dot.title = wsOn ? 'В сети' : 'Нет соединения';
  a.append(dot);
  t.append(el('div', S.me.display_name || S.me.name, 'tt'), el('div', '#' + S.me.tag, 'mu s'));
  m.append(a, t);
}

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
  } else v.append(({ home, discover, rooms, messages, profile, user: () => userPage(id) }[p] || home)());
  renderPanel();
  renderMe();
  updateBar();
}
addEventListener('hashchange', () => { failed = 0; $('#bar').classList.remove('full'); render(); });

// ---------- Соединение ----------
function onMsg(m) {
  if (m.type === 'presence') { clearTimeout(timer); timer = setTimeout(refresh, 300); }
  else if (m.type === 'gone') { if (S.cur && S.cur.id === m.room) { leaveRoom(false); go('#/rooms'); } refresh(); }
  else if (m.type === 'error') {
    const msgs = { perm: 'Управлять воспроизведением и очередью может только хозяин комнаты', track: 'Этот трек недоступен', qfull: 'Очередь заполнена (максимум 50 треков)', qmine: 'Вы уже добавили 10 треков' };
    if (msgs[m.code]) flash(msgs[m.code]);
    else { leaveRoom(false); joinErr = m.code === 'full' ? 'Комната заполнена. Попробуйте позже.' : 'У вас нет доступа к этой комнате.'; failed = m.room; render(); }
  } else if (m.type === 'queue') { S.q = m.items; renderPanel(); }
  else if (m.type === 'profile') onProfileEvent(m.id);
  else if (m.type === 'streak') {
    toast(m.milestone ? m.milestone + ' дн. подряд вместе с ' + m.name + '!' : 'Общий день засчитан: серия с ' + m.name + ' — ' + m.current + ' дн.', 'ok');
    loadStreaks().then(render).catch(() => {});
  }
  else if (m.type.startsWith('chat:')) onChat(m);
  else { onState(m); renderPanel(); roomHead(); }
}

async function enterApp() {
  S.me = await api('/api/me');
  connect({ open: () => { wsOn = true; renderMe(); chatStatus(); if (S.cur) send({ type: 'join', room: S.cur.id }); }, close: () => { wsOn = false; renderMe(); chatStatus(); }, msg: onMsg });
  await Promise.all([loadRooms(), loadTracks(), loadFriends(), loadHome(), loadStreaks()]);
  if (!location.hash) go('#/home');
  render();
}

api('/api/me').then((u) => (u ? enterApp() : render())).catch(render);
