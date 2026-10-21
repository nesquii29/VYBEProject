// Нижний плеер: воспроизведение, личная громкость, состояния
import { S, $, send, fmt, ic, canControl } from './core.js';

const au = $('#au'), bar = $('#bar'), vol = $('#vol');
let loading = false, dragging = false;

// Личная громкость: хранится только в этом браузере и никому больше не передаётся
vol.value = Math.round(+(localStorage.getItem('vol') ?? 0.8) * 100);
au.volume = vol.value / 100;
au.muted = localStorage.getItem('mute') === '1';
function icons() {
  $('#bMute').innerHTML = ic(au.muted || au.volume === 0 ? 'mute' : 'vol');
  $('#bMute').setAttribute('aria-label', au.muted ? 'Включить звук' : 'Выключить звук');
  $('#bPanel').innerHTML = ic('users');
}
vol.oninput = () => {
  au.volume = vol.value / 100;
  au.muted = false;
  localStorage.setItem('vol', au.volume);
  localStorage.setItem('mute', '0');
  icons();
};
$('#bMute').onclick = () => { au.muted = !au.muted; localStorage.setItem('mute', au.muted ? '1' : '0'); icons(); };
icons();

export function updateBar() {
  const t = S.st.track, playing = !!S.st.playing;
  bar.hidden = !S.me;
  $('#bT').textContent = t ? t.title : 'Трек не выбран';
  $('#bS').textContent = !S.cur ? 'Вы не в комнате'
    : !t ? 'Выберите трек в комнате · ' + S.cur.name
    : (loading && playing ? 'Загрузка…' : playing ? 'Играет' : 'Пауза') + ' · ' + S.cur.name;
  const real = !au.paused && !loading; // анимация только при реальном воспроизведении
  $('#eq').classList.toggle('on', real);
  bar.classList.toggle('live', real);
  $('#bPP').innerHTML = ic(playing ? 'pause' : 'play', 22);
  const can = canControl();
  $('#bPP').disabled = !S.cur || !t || (!can && !(playing && au.paused)); // участник без прав может лишь включить звук у себя
  $('#seek').disabled = !t || !can;
}

au.onwaiting = () => { loading = true; updateBar(); };
au.onplaying = au.oncanplay = () => { loading = false; updateBar(); };
au.onplay = au.onpause = updateBar;
au.ontimeupdate = au.onloadedmetadata = () => {
  if (!dragging && au.duration) $('#seek').value = (au.currentTime / au.duration) * 1000;
  $('#t1').textContent = fmt(au.currentTime);
  $('#t2').textContent = fmt(au.duration);
};

// Перемотка: протокол синхронизации прежний (сообщение seek)
$('#seek').oninput = () => { dragging = true; $('#t1').textContent = fmt(($('#seek').value / 1000) * au.duration); };
$('#seek').onchange = () => {
  dragging = false;
  if (S.cur && au.duration) send({ type: 'seek', pos: ($('#seek').value / 1000) * au.duration });
};
$('#bPP').onclick = () => {
  if (S.st.playing && au.paused) return au.play().catch(() => {});
  send({ type: S.st.playing ? 'pause' : 'play', pos: au.currentTime });
};
$('#bl').onclick = () => { if (matchMedia('(max-width:720px)').matches) bar.classList.toggle('full'); };

export function onState(s) {
  if (!S.cur) return;
  if (s.track && (!S.st.track || S.st.track.id !== s.track.id)) { loading = true; au.src = '/audio/' + s.track.id; }
  S.st = s;
  if (s.track) {
    if (Math.abs(au.currentTime - s.pos) > 0.7) au.currentTime = s.pos;
    if (s.playing) au.play().catch(() => { loading = false; updateBar(); $('#bS').textContent = 'Нажмите ▶, чтобы включить звук'; });
    else au.pause();
  }
  updateBar();
}

export function stopAudio() {
  au.pause();
  au.removeAttribute('src');
  loading = false;
  S.st = {};
  updateBar();
}
