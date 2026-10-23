// Модульные тесты серий. Запуск: node --test streaks.test.js (зависимости не нужны, время подменяется часами)
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('./streaks');

const D = (s) => Date.parse(s + 'Z');
const friends = () => true;
function make(start, store = S.memoryStore()) {
  const clock = { t: D(start) }, events = [];
  const tr = S.createTracker({ store, now: () => clock.t, onQualify: (a, b, day, st) => events.push({ a, b, day, st }) });
  // слушаем вместе: каждые 15 секунд замер, как на сервере
  const listen = (minutes, rooms = [{ room: 1, playing: true, users: [1, 2] }]) => { for (let i = 0; i < minutes * 4; i++) { clock.t += 15000; tr.tick(rooms, friends); } };
  tr.tick([], friends); // первый замер задаёт точку отсчёта
  return { clock, events, tr, store, listen };
}

test('день засчитывается после 10 минут совместного прослушивания', () => {
  const m = make('2026-10-01T10:00:00');
  m.listen(10);
  assert.equal(m.events.length, 1);
  assert.deepEqual(m.store.getState(1, 2), { current: 1, longest: 1, last: '2026-10-01' });
});

test('меньше 10 минут не засчитывается', () => {
  const m = make('2026-10-01T10:00:00');
  m.listen(9);
  assert.equal(m.events.length, 0);
  assert.equal(m.store.getState(1, 2), null);
});

test('если музыка не играет, время не копится', () => {
  const m = make('2026-10-01T10:00:00');
  m.listen(20, [{ room: 1, playing: false, users: [1, 2] }]);
  assert.equal(m.events.length, 0);
});

test('подряд идущие дни увеличивают серию', () => {
  const m = make('2026-10-01T10:00:00');
  m.listen(10);
  m.clock.t = D('2026-10-02T10:00:00'); m.tr.tick([], friends); m.listen(10);
  m.clock.t = D('2026-10-03T10:00:00'); m.tr.tick([], friends); m.listen(10);
  assert.deepEqual(m.store.getState(1, 2), { current: 3, longest: 3, last: '2026-10-03' });
  assert.equal(m.events.at(-1).st.current, 3);
});

test('пропущенный день прерывает серию, рекорд сохраняется, новая серия начинается с 1', () => {
  const m = make('2026-10-01T10:00:00');
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) { m.clock.t = D(d + 'T10:00:00'); m.tr.tick([], friends); m.listen(10); }
  assert.equal(S.shown(m.store.getState(1, 2), '2026-10-04'), 3); // вчера слушали: серия ещё жива
  assert.equal(S.shown(m.store.getState(1, 2), '2026-10-05'), 0); // пропущены сутки: прервана
  m.clock.t = D('2026-10-06T10:00:00'); m.tr.tick([], friends); m.listen(10);
  assert.deepEqual(m.store.getState(1, 2), { current: 1, longest: 3, last: '2026-10-06' });
});

test('дубли событий не создают второй зачёт за день', () => {
  const m = make('2026-10-01T10:00:00');
  m.listen(30);
  assert.equal(m.events.length, 1);
  assert.equal(m.store.addDay(2, 1, '2026-10-01').isNew, false); // порядок пользователей не важен
  assert.equal(m.store.getState(1, 2).current, 1);
});

test('несколько комнат и вкладок не удваивают время', () => {
  const m = make('2026-10-01T10:00:00');
  m.listen(5, [{ room: 1, playing: true, users: [1, 2, 2] }, { room: 2, playing: true, users: [2, 1] }]);
  assert.equal(Math.round(m.tr.progress(1, 2, '2026-10-01') / 60000), 5); // 5 минут, а не 10
  assert.equal(m.events.length, 0);
});

test('отключения не засчитываются, переподключение продолжает накопление', () => {
  const m = make('2026-10-01T10:00:00');
  m.listen(5);
  m.listen(5, [{ room: 1, playing: true, users: [1] }]); // второй отключился
  m.listen(4);
  assert.equal(m.events.length, 0); // 9 минут вместе
  m.listen(1);
  assert.equal(m.events.length, 1);
});

test('после перезапуска сервера накопленное время сохраняется и не считается дважды', () => {
  const store = S.memoryStore();
  const a = make('2026-10-01T10:00:00', store);
  a.listen(6); a.tr.flush();
  const b = make('2026-10-01T10:30:00', store); // новый «процесс» с тем же хранилищем
  b.listen(3);
  assert.equal(b.events.length, 0); // 6 + 3 = 9
  b.listen(1);
  assert.equal(b.events.length, 1);
  const c = make('2026-10-01T11:00:00', store);
  c.listen(20);
  assert.equal(c.events.length, 0); // день уже засчитан, повторного зачёта нет
});

test('пауза работы сервера не засчитывается (ограничение интервала между замерами)', () => {
  const m = make('2026-10-01T10:00:00');
  m.clock.t += 20 * 60000; m.tr.tick([{ room: 1, playing: true, users: [1, 2] }], friends);
  assert.ok(m.tr.progress(1, 2, '2026-10-01') <= S.MAX_GAP_MS);
});

test('граница суток UTC: время делится по дням, 5+5 минут вокруг полуночи не засчитываются', () => {
  const m = make('2026-10-01T23:55:00');
  m.listen(10);
  assert.equal(m.events.length, 0);
  assert.ok(m.tr.progress(1, 2, '2026-10-01') < 6 * 60000 && m.tr.progress(1, 2, '2026-10-02') < 6 * 60000);
  m.listen(5); // в новых сутках набралось 10 минут
  assert.equal(m.events.length, 1);
  assert.equal(m.events[0].day, '2026-10-02');
});

test('не друзья серию не получают, после удаления из друзей данные стираются', () => {
  const m = make('2026-10-01T10:00:00');
  const rooms = [{ room: 1, playing: true, users: [1, 2] }];
  for (let i = 0; i < 80; i++) { m.clock.t += 15000; m.tr.tick(rooms, () => false); }
  assert.equal(m.events.length, 0);
  m.listen(10);
  m.store.remove(1, 2); m.tr.forget(1, 2);
  assert.equal(m.store.getState(1, 2), null);
  assert.equal(m.tr.progress(1, 2, '2026-10-01'), 0);
});

test('одновременные запросы на зачёт дают ровно один новый день', () => {
  const s = S.memoryStore();
  const r = [s.addDay(1, 2, '2026-10-01'), s.addDay(2, 1, '2026-10-01'), s.addDay(1, 2, '2026-10-01')];
  assert.deepEqual(r.map((x) => x.isNew), [true, false, false]);
});

test('состояния интерфейса: ноль, активна, прервана', () => {
  assert.equal(S.shown(null, '2026-10-05'), 0);
  assert.equal(S.shown({ current: 4, longest: 4, last: '2026-10-05' }, '2026-10-05'), 4);
  assert.equal(S.shown({ current: 4, longest: 9, last: '2026-10-01' }, '2026-10-05'), 0);
});

test('расчёт серий из списка дней', () => {
  assert.deepEqual(S.compute(['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']), { current: 3, longest: 3, last: '2026-10-07' });
  assert.deepEqual(S.compute(['2026-12-31', '2027-01-01']), { current: 2, longest: 2, last: '2027-01-01' });
});

// То же самое на настоящем SQLite (node:sqlite), если он есть в этой версии Node
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch {}
test('SQLite: каноническая пара, зачёт и устойчивость к повтору', { skip: !sqlite && 'node:sqlite недоступен' }, () => {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(`CREATE TABLE streaks(a INTEGER NOT NULL, b INTEGER NOT NULL, current INTEGER NOT NULL DEFAULT 0, longest INTEGER NOT NULL DEFAULT 0, last_day TEXT, PRIMARY KEY(a,b), CHECK(a < b));
    CREATE TABLE streak_days(a INTEGER NOT NULL, b INTEGER NOT NULL, day TEXT NOT NULL, PRIMARY KEY(a,b,day), CHECK(a < b));
    CREATE TABLE streak_progress(a INTEGER NOT NULL, b INTEGER NOT NULL, day TEXT NOT NULL, ms INTEGER NOT NULL, PRIMARY KEY(a,b,day), CHECK(a < b));`);
  const store = S.sqliteStore(db);
  const m = make('2026-10-01T10:00:00', store);
  m.listen(10);
  assert.equal(m.events.length, 1);
  assert.equal(store.addDay(2, 1, '2026-10-01').isNew, false);
  assert.deepEqual(store.getState(2, 1), { current: 1, longest: 1, last: '2026-10-01' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM streaks').get().c, 1);
  m.tr.flush();
  const m2 = make('2026-10-02T10:00:00', store);
  m2.listen(10);
  assert.deepEqual(store.getState(1, 2), { current: 2, longest: 2, last: '2026-10-02' });
  assert.throws(() => db.prepare('INSERT INTO streak_days(a, b, day) VALUES(5, 3, ?)').run('2026-10-01')); // неканоническая пара запрещена
});
