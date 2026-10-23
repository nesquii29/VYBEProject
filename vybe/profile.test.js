// Модульные тесты профиля. Запуск: node --test profile.test.js (внешние зависимости не нужны)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const P = require('./profile');
const { makePng, makeJpegHeader, makeWebpX } = require('./testutil');

test('отображаемое имя: границы и служебные символы', () => {
  assert.equal(P.validate({ display_name: '  Аня   Ким ' }).v.display_name, 'Аня Ким');
  assert.ok(P.validate({ display_name: '   ' }).error);
  assert.ok(P.validate({ display_name: 'x'.repeat(33) }).error);
  assert.ok(P.validate({ display_name: 'a\u0000b' }).error);
  assert.equal(P.validate({ display_name: 'x'.repeat(32) }).v.display_name.length, 32);
});

test('о себе: до 160 символов, пустое допустимо, текст остаётся текстом', () => {
  assert.equal(P.validate({ bio: 'x'.repeat(160) }).v.bio.length, 160);
  assert.ok(P.validate({ bio: 'x'.repeat(161) }).error);
  assert.equal(P.validate({ bio: '' }).v.bio, '');
  assert.equal(P.validate({ bio: '<img src=x onerror=alert(1)>' }).v.bio, '<img src=x onerror=alert(1)>'); // не меняем: выводится только как textContent
});

test('статус: готовый, свой, очистка и срок действия', () => {
  const now = 1_000_000;
  const a = P.validate({ status: { preset: 'dnd', hours: 8 } }, now).v;
  assert.equal(a.status_text, P.PRESETS.dnd);
  assert.equal(a.status_until, now + 8 * 3600000);
  assert.equal(P.validate({ status: { text: 'сижу в студии', hours: 0 } }, now).v.status_until, null);
  assert.deepEqual(P.validate({ status: null }).v, { status_text: null, status_until: null });
  assert.ok(P.validate({ status: { text: 'x'.repeat(61) } }).error);
  assert.ok(P.validate({ status: { text: 'ок', hours: 5 } }).error);
  assert.ok(P.validate({ status: {} }).error);
  assert.equal(P.statusActive(now + 1, now), true);
  assert.equal(P.statusActive(now - 1, now), false); // истёк
  assert.equal(P.statusActive(null, now), true);
});

test('цвет: палитра, свой HEX, слишком тёмный отклоняется, CSS не принимается', () => {
  assert.equal(P.validate({ accent: 'mint' }).v.accent, '#6FD0A8');
  assert.equal(P.validate({ accent: '#abcdef' }).v.accent, '#ABCDEF');
  assert.ok(P.validate({ accent: '#101114' }).error);
  assert.ok(P.validate({ accent: 'red; background:url(x)' }).error);
  assert.ok(P.validate({ accent: '#12345' }).error);
  assert.ok(Object.values(P.ACCENTS).every((h) => P.luminance(h) >= 0.2));
});

test('жанры, стиль и приватность: допустимые значения', () => {
  assert.equal(P.validate({ genres: ['jazz', 'rock'] }).v.genres, 'jazz,rock');
  assert.ok(P.validate({ genres: ['jazz', 'jazz'] }).error);
  assert.ok(P.validate({ genres: ['polka'] }).error);
  assert.ok(P.validate({ genres: ['pop', 'rap', 'rock', 'indie', 'jazz', 'metal'] }).error);
  assert.ok(P.validate({ style: 'neon' }).error);
  assert.ok(P.validate({ vis_bio: 'public' }).error);
  assert.equal(P.validate({ vis_activity: 'me' }).v.vis_activity, 'me');
});

test('изображения: JPEG, PNG, WebP принимаются, остальное нет', () => {
  assert.equal(P.checkImage(makePng(64, 64), 'avatar').info.type, 'png');
  assert.equal(P.checkImage(makeJpegHeader(800, 300), 'banner').info.type, 'jpeg');
  assert.equal(P.checkImage(makeWebpX(640, 200), 'banner').info.ext, 'webp');
  const bad = {
    svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    html: Buffer.from('<!doctype html><script>alert(1)</script>'),
    exe: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200)]),
    gif: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)]),
    empty: Buffer.alloc(0),
    pngSigOnly: Buffer.concat([makePng(64, 64).subarray(0, 8), Buffer.alloc(8)]),
  };
  for (const [k, b] of Object.entries(bad)) assert.ok(P.checkImage(b, 'avatar').error, k + ' должен быть отклонён');
});

test('изображения: ограничения размера файла и размеров картинки', () => {
  const big = Buffer.concat([makePng(64, 64), Buffer.alloc(5 * 1024 * 1024)]);
  assert.ok(P.checkImage(big, 'avatar').error); // больше 5 МБ
  assert.ok(P.checkImage(big, 'banner').info); // для баннера лимит 8 МБ
  assert.ok(P.checkImage(Buffer.concat([makePng(64, 64), Buffer.alloc(8 * 1024 * 1024)]), 'banner').error);
  assert.ok(P.checkImage(makePng(16, 16), 'avatar').error); // слишком маленькое
  assert.ok(P.checkImage(makeJpegHeader(9000, 100), 'banner').error); // слишком большое
});

test('имена файлов: только серверные, обход пути невозможен', () => {
  assert.ok(P.MEDIA_RE.test('0123456789abcdef01234567.png'));
  for (const n of ['../server.js', '..%2fserver.js', 'a/b.png', '0123456789abcdef01234567.svg', '0123456789abcdef01234567.png/../x', 'avatar.png']) assert.equal(P.MEDIA_RE.test(n), false, n);
});

test('правила видимости', () => {
  const rows = [['everyone', 'me', true], ['everyone', 'friend', true], ['everyone', 'other', true], ['friends', 'me', true], ['friends', 'friend', true], ['friends', 'other', false], ['me', 'me', true], ['me', 'friend', false], ['me', 'other', false]];
  for (const [v, r, want] of rows) assert.equal(P.canSee(v, r), want, v + '/' + r);
});

test('избранное: лимит, дубли, чужие треки, порядок и избранный трек', () => {
  const owned = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(P.validateFavorites([3, 1, 2], 1, owned), { ids: [3, 1, 2], featured: 1 }); // порядок сохраняется
  assert.ok(P.validateFavorites([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], null, owned).error); // больше 10
  assert.ok(P.validateFavorites([1, 1], null, owned).error);
  assert.ok(P.validateFavorites([99], null, owned).error); // не из моей библиотеки
  assert.ok(P.validateFavorites([1, 2], 3, owned).error); // избранный не из списка
  assert.ok(P.validateFavorites('1,2', null, owned).error);
  assert.deepEqual(P.validateFavorites([], null, owned), { ids: [], featured: null });
});

// Хранилище на настоящем SQLite (node:sqlite), включая перезапуск
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch {}
const SCHEMA = `CREATE TABLE profiles(uid INTEGER PRIMARY KEY, display_name TEXT, bio TEXT NOT NULL DEFAULT '', status_text TEXT, status_until INTEGER, accent TEXT NOT NULL DEFAULT '#9AA5FF', style TEXT NOT NULL DEFAULT 'minimal', genres TEXT NOT NULL DEFAULT '', avatar TEXT, banner TEXT, featured INTEGER, vis_bio TEXT NOT NULL DEFAULT 'everyone', vis_genres TEXT NOT NULL DEFAULT 'everyone', vis_tracks TEXT NOT NULL DEFAULT 'everyone', vis_featured TEXT NOT NULL DEFAULT 'everyone', vis_activity TEXT NOT NULL DEFAULT 'friends');
  CREATE TABLE profile_favorites(id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER NOT NULL, track INTEGER NOT NULL, pos INTEGER NOT NULL, UNIQUE(uid, track));`;
test('SQLite: пользователь без настроек получает значения по умолчанию', { skip: !sqlite && 'нет node:sqlite' }, () => {
  const db = new sqlite.DatabaseSync(':memory:'); db.exec(SCHEMA);
  const s = P.profileStore(db);
  assert.deepEqual(s.get(42), P.DEFAULTS);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM profiles').get().c, 0); // чтение ничего не создаёт
  assert.deepEqual(s.favorites(42), []);
});
test('SQLite: частичное обновление не затирает остальные поля, данные переживают перезапуск', { skip: !sqlite && 'нет node:sqlite' }, () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vybe-')), 'p.db');
  let db = new sqlite.DatabaseSync(file); db.exec(SCHEMA);
  let s = P.profileStore(db);
  s.update(1, P.validate({ display_name: 'Аня', bio: 'привет', accent: 'blue', genres: ['jazz'], vis_bio: 'friends' }).v);
  s.update(1, P.validate({ bio: 'новое' }).v);
  s.setFavorites(1, [5, 3, 9], 3);
  s.update(1, P.validate({ status: { preset: 'dnd', hours: 1 } }, 1000).v);
  db.close();
  db = new sqlite.DatabaseSync(file); s = P.profileStore(db); // «перезапуск»
  const p = s.get(1);
  assert.equal(p.display_name, 'Аня'); assert.equal(p.bio, 'новое'); assert.equal(p.accent, '#6FA8FF'); assert.equal(p.genres, 'jazz'); assert.equal(p.vis_bio, 'friends');
  assert.deepEqual(s.favorites(1), [5, 3, 9]); assert.equal(p.featured, 3);
  assert.equal(P.statusActive(p.status_until, 1000 + 3600000 - 1), true);
  assert.equal(P.statusActive(p.status_until, 1000 + 3600000 + 1), false);
  assert.equal(s.get(2).display_name, null); // другой пользователь не затронут
  s.setFavorites(1, [9, 5], null); assert.deepEqual(s.favorites(1), [9, 5]); // перестановка
  s.removeTrack(9); assert.deepEqual(s.favorites(1), [5]); // удалённый трек исчезает из избранного
  s.update(1, { 'bio = 1; DROP TABLE profiles; --': 'x', nope: 1 }); // чужие ключи игнорируются, таблица цела
  assert.equal(s.get(1).bio, 'новое');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM profiles').get().c, 1);
  db.close();
});
