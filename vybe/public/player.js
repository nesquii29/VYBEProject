// Нижний плеер: единый слой для своих mp3 и SoundCloud (официальный Widget API).
// Режимы: комната (состояние задаёт сервер) и личное прослушивание (только у вас).
// Состояния: idle → loading → ready → playing ⇄ paused, либо error (с повтором).
import { S, $, send, fmt, ic, canControl } from './core.js';

const au = $('#au'), bar = $('#bar'), vol = $('#vol');
let vol01 = +(localStorage.getItem('vol') ?? 0.8), muted = localStorage.getItem('mute') === '1';
let ps = 'idle', errMsg = '', needTap = false, token = 0, dragging = false, pseq = 0, want = null, tm = 0;
const sc = { w: null, pending: null, bound: false, url: '', live: false, playing: false, pos: 0, dur: 0, onReady: null };
vol.value = Math.round(vol01 * 100);

const isSC = () => !!S.st.track && S.st.track.source === 'soundcloud';
function setPs(v, msg = '') { ps = v; errMsg = msg; if (v !== 'paused') needTap = false; updateBar(); }
const tap = (t) => { if (t === token && ps !== 'error') { ps = 'paused'; needTap = true; updateBar(); } }; // автозапуск заблокирован
function arm(t) { clearTimeout(tm); tm = setTimeout(() => { if (t === token && ps === 'loading') setPs('error', 'Трек слишком долго загружается'); }, 15000); }
function trackError(msg) { clearTimeout(tm); setPs('error', msg); if (S.cur && !S.st.personal) send({ type: 'failed', seq: S.st.seq }); }
function ended() {
  if (S.st.personal) { idle(); S.st = {}; updateBar(); return; }
  if (S.cur && S.st.track) send({ type: 'ended', seq: S.st.seq });
}

// ---------- SoundCloud: один виджет на всё приложение, слушатели регистрируются один раз ----------
const loadApi = () => (window.SC ? Promise.resolve() : new Promise((ok, no) => {
  const s = document.createElement('script');
  s.src = 'https://w.soundcloud.com/player/api.js';
  s.onload = ok; s.onerror = () => no(new Error('api'));
  document.head.append(s);
}));
function widget(url) {
  if (sc.w) return Promise.resolve(sc.w);
  if (sc.pending) return sc.pending;
  sc.pending = loadApi().then(() => new Promise((ok, no) => {
    sc.onReady = ok;
    sc.url = url;
    $('#scf').src = 'https://w.soundcloud.com/player/?visual=false&show_comments=false&url=' + encodeURIComponent(url);
    if (!sc.bound) {
      sc.bound = true;
      const w = window.SC.Widget($('#scf')), E = window.SC.Widget.Events;
      w.bind(E.READY, () => { sc.w = w; if (sc.onReady) sc.onReady(w); });
      w.bind(E.PLAY, () => { if (sc.live) { sc.playing = true; clearTimeout(tm); setPs('playing'); } });
      w.bind(E.PAUSE, () => { if (sc.live) { sc.playing = false; if (ps === 'playing') setPs('paused'); } });
      w.bind(E.FINISH, () => { if (sc.live) { sc.playing = false; ended(); } });
      w.bind(E.PLAY_PROGRESS, (e) => { if (sc.live) { sc.pos = e.currentPosition / 1000; tick(); } });
      w.bind(E.ERROR, () => { if (sc.live) trackError('SoundCloud: трек недоступен или запрещён к встраиванию'); });
    }
    setTimeout(() => no(new Error('timeout')), 12000);
  }));
  sc.pending.then(() => { sc.pending = null; }, () => { sc.pending = null; });
  return sc.pending;
}
function scApply(w, t) {
  if (t !== token) return; // устаревший ответ от прежнего трека
  sc.live = true;
  w.setVolume(muted ? 0 : vol01 * 100); // Widget API принимает 0–100
  w.getDuration((d) => { if (t === token) { sc.dur = d / 1000; tick(); if (S.cur && !S.st.personal) send({ type: 'meta', seq: S.st.seq, dur: sc.dur }); } });
  const p = want.pos + (want.play && want.comp ? (performance.now() - want.rt) / 1000 : 0); // учитываем время загрузки
  if (p > 0.3) w.seekTo(p * 1000);
  if (want.play) { w.play(); setTimeout(() => { if (t === token && want && want.play && ps !== 'playing') tap(t); }, 3000); }
  else { w.pause(); setPs('paused'); }
}
async function startSC(track, pos, play, t) {
  want = { pos, play, rt: performance.now(), comp: !S.st.personal };
  Object.assign(sc, { live: false, playing: false, pos, dur: 0 });
  setPs('loading'); arm(t);
  $('#scbox').hidden = false;
  let w;
  try { w = await widget(track.url); } catch { if (t === token) setPs('error', 'Не удалось загрузить плеер SoundCloud'); return; }
  if (t !== token) return;
  if (sc.url === track.url) scApply(w, t);
  else { sc.url = track.url; w.load(track.url, { auto_play: false, callback: () => scApply(w, t) }); }
}
function stopSC() { sc.live = false; sc.playing = false; want = null; if (sc.w) sc.w.pause(); $('#scbox').hidden = true; }

// ---------- mp3 ----------
function startUp(track, pos, play, t) {
  want = null;
  setPs('loading'); arm(t);
  au.src = '/audio/' + track.id;
  au.currentTime = pos;
  if (play) au.play().catch(() => tap(t)); else au.pause();
}
const stopUp = () => { au.pause(); au.removeAttribute('src'); };
au.oncanplay = () => { if (ps === 'loading' && !isSC()) { clearTimeout(tm); setPs(au.paused ? 'ready' : 'playing'); } };
au.onplaying = () => { if (!isSC()) { clearTimeout(tm); setPs('playing'); } };
au.onpause = () => { if (!isSC() && ps === 'playing') setPs('paused'); };
au.onwaiting = () => { if (!isSC() && ps === 'playing') { setPs('loading'); arm(token); } };
au.onended = () => { if (!isSC() && S.st.track) ended(); };
au.onerror = () => { if (!isSC() && au.getAttribute('src')) trackError('Не удалось загрузить MP3'); };
au.ontimeupdate = au.onloadedmetadata = () => { if (!isSC()) tick(); };
au.addEventListener('loadedmetadata', () => { if (S.cur && S.st.track && !S.st.personal && !isSC() && isFinite(au.duration)) send({ type: 'meta', seq: S.st.seq, dur: au.duration }); });

// ---------- Единый интерфейс ----------
const pos = () => (isSC() ? sc.pos : au.currentTime);
const dur = () => (isSC() ? sc.dur : au.duration);
const paused = () => (isSC() ? !sc.playing : au.paused);
const seekTo = (x) => { if (isSC()) { if (sc.w) sc.w.seekTo(x * 1000); } else au.currentTime = x; };
const pause = () => { if (isSC()) { if (sc.w) sc.w.pause(); } else au.pause(); };
function play() { needTap = false; if (isSC()) { if (sc.w) sc.w.play(); } else au.play().catch(() => tap(token)); }
function startTrack(track, p, playing) {
  const t = ++token;
  clearTimeout(tm);
  if (track.source === 'soundcloud') { stopUp(); startSC(track, p, playing, t); } else { stopSC(); startUp(track, p, playing, t); }
}
function idle() { token++; clearTimeout(tm); stopUp(); stopSC(); setPs('idle'); }
function retry() {
  const s = S.st, y = S.sync;
  if (!s.track) return;
  startTrack(s.track, y ? (y.playing ? y.pos + (performance.now() - y.rt) / 1000 : y.pos) : 0, s.personal ? true : !!s.playing);
}

// ---------- Громкость: хранится только в этом браузере ----------
function applyVol() {
  au.volume = vol01; au.muted = muted;
  if (sc.w) sc.w.setVolume(muted ? 0 : vol01 * 100);
  $('#bMute').innerHTML = ic(muted || vol01 === 0 ? 'mute' : 'vol');
  $('#bMute').setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук');
  $('#bPanel').innerHTML = ic('users');
}
vol.oninput = () => { vol01 = vol.value / 100; muted = false; localStorage.setItem('vol', vol01); localStorage.setItem('mute', '0'); applyVol(); };
$('#bMute').onclick = () => { muted = !muted; localStorage.setItem('mute', muted ? '1' : '0'); applyVol(); };
applyVol();

// ---------- Интерфейс плеера ----------
export function updateBar() {
  const t = S.st.track, can = canControl(), personal = !!S.st.personal;
  bar.hidden = !S.me;
  $('#bT').textContent = t ? t.title : 'Трек не выбран';
  const ctx = personal ? 'Только у вас' : S.cur ? S.cur.name : 'Вы не в комнате';
  const st = !t ? (S.cur ? (S.q && S.q.length ? 'Ожидание' : 'Очередь пуста') : 'Выберите трек в библиотеке')
    : ps === 'error' ? errMsg + ' · ▶ — повторить'
    : needTap ? 'Нажмите ▶, чтобы начать слушать'
    : ps === 'loading' ? 'Загрузка…'
    : ps === 'playing' ? 'Играет'
    : S.st.playing && !personal ? 'Ожидание воспроизведения' : 'Пауза';
  $('#bS').textContent = (t ? (t.source === 'soundcloud' ? 'SoundCloud · ' : '') + (t.artist ? t.artist + ' · ' : '') : '') + st + ' · ' + ctx;
  const art = $('#bArt');
  art.hidden = !(t && t.art);
  if (t && t.art && art.getAttribute('src') !== t.art) art.src = t.art;
  $('#bNote').innerHTML = art.hidden ? ic('note', 22) : '';
  $('#eq').classList.toggle('on', ps === 'playing'); // анимация только при реальном воспроизведении
  $('#bPP').innerHTML = ic(ps === 'playing' ? 'pause' : 'play', 22);
  $('#bPP').setAttribute('aria-label', ps === 'error' ? 'Повторить' : ps === 'playing' ? 'Пауза' : 'Играть');
  $('#bPP').classList.toggle('attn', needTap || ps === 'error');
  $('#bPP').disabled = ps === 'error' ? false : !t || (!!S.cur && !can && !(S.st.playing && paused()));
  $('#seek').disabled = !t || !can || ps === 'error';
  $('#bNext').hidden = !(S.cur && can && t && !personal);
  $('#bNext').innerHTML = ic('next', 20);
}
function tick() {
  const d = dur(), p = pos();
  if (!dragging && d) $('#seek').value = (p / d) * 1000;
  $('#t1').textContent = fmt(p);
  $('#t2').textContent = fmt(d);
}

// ---------- Управление ----------
$('#seek').oninput = () => { dragging = true; $('#t1').textContent = fmt(($('#seek').value / 1000) * dur()); };
$('#seek').onchange = () => {
  dragging = false;
  const x = ($('#seek').value / 1000) * dur();
  if (!dur()) return;
  if (S.st.personal) seekTo(x); else if (S.cur) send({ type: 'seek', pos: x });
};
$('#bPP').onclick = () => {
  if (ps === 'error') return retry();
  if (S.st.personal) return paused() ? play() : pause();
  if (S.st.playing && paused()) return play(); // локально запускаем звук, комнату не трогаем
  send({ type: S.st.playing ? 'pause' : 'play', pos: pos() });
};
$('#bNext').onclick = () => send({ type: 'skip' });
$('#bl').onclick = () => { if (matchMedia('(max-width:720px)').matches) bar.classList.toggle('full'); };

// Ожидаемая позиция = позиция из последнего сообщения сервера + время, прошедшее у клиента.
// Поправляем только при заметном расхождении (mp3: 0,5 с; SoundCloud: 1,2 с, их плеер отдаёт позицию дискретно).
function driftFix() {
  const y = S.sync;
  if (!S.cur || !y || !S.st.track || S.st.personal || ps !== 'playing' || !y.playing) return;
  if (isSC() ? !sc.live : au.seeking || au.readyState < 3) return;
  const w = y.pos + (performance.now() - y.rt) / 1000, d = dur();
  if (d && isFinite(d) && w > d) return;
  if (Math.abs(pos() - w) > (isSC() ? 1.2 : 0.5)) seekTo(w);
}
setInterval(driftFix, 1000);

// ---------- Вход состояний ----------
export function onState(s) {
  if (!S.cur) return;
  if (S.st.ver && s.seq === S.st.seq && s.ver < S.st.ver) return; // устаревшее сообщение
  const prev = S.st;
  S.st = s;
  S.sync = { pos: s.pos, playing: s.playing, rt: performance.now() };
  if (!s.track) idle();
  else if (!prev.track || prev.seq !== s.seq || prev.personal) startTrack(s.track, s.pos, s.playing);
  else if (ps === 'loading' && isSC() && want) want = { ...want, pos: s.pos, play: s.playing, rt: performance.now() };
  else {
    if (s.playing) { if (ps === 'paused' || ps === 'ready') play(); }
    else if (ps === 'playing' || (ps === 'loading' && !isSC())) pause();
    driftFix();
  }
  updateBar();
}

// Личное прослушивание: тот же плеер, но без участия комнаты
export function playPersonal(track) {
  S.st = { track, playing: true, seq: 'p' + (++pseq), personal: true };
  S.sync = null;
  startTrack(track, 0, true);
  updateBar();
}

export function stopAudio() { idle(); S.st = {}; S.sync = null; updateBar(); }
