// Importing album names from the macOS Photos library.
//
// Photos already holds words the user typed: album names like "Darjeeling 26th Tiger hill".
// They cost nothing to read and they are what someone actually searches with. They are NOT
// captions, though. An album name says the occasion, not what is in the frame, so it lands
// as a tag and must never move the caption coverage figure. A percentage that rises because
// of work nobody did is worse than one that stays low.
//
// The join table is named per schema version (Z_33ASSETS here, Z_28ASSETS on another Mac),
// so anything that hardcodes it works on one machine and silently finds nothing on the next.
//
//   node test/photos.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const storage = require('../server/storage.js');
const tools = require('../server/tools.js');
const photos = require('../server/photos.js');

let passed = 0;
const check = (name, fn) => {
  try { fn(); console.log('  pass  ' + name); passed++; }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

// ---- a stand-in Photos library, with the join table under a different number on purpose
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yellide-photos-'));
const photosDb = path.join(tmp, 'Photos.sqlite');
{
  const p = new DatabaseSync(photosDb);
  p.exec(`create table ZASSET(Z_PK integer primary key, ZDIRECTORY text, ZFILENAME text)`);
  p.exec(`create table ZGENERICALBUM(Z_PK integer primary key, ZKIND integer, ZTITLE text)`);
  p.exec(`create table Z_41ASSETS(Z_41ALBUMS integer, Z_3ASSETS integer)`);
  const asset = (pk, fn) => p.prepare('insert into ZASSET values(?,?,?)').run(pk, '0', fn);
  const album = (pk, title) => p.prepare('insert into ZGENERICALBUM values(?,2,?)').run(pk, title);
  const link = (al, as) => p.prepare('insert into Z_41ASSETS values(?,?)').run(al, as);
  ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'].forEach((f, i) => asset(i + 1, f));
  album(1, 'Darjeeling 26th Tiger hill, Batasia loop');
  album(2, '26-Nov-2012');            // a date, not a description
  album(3, 'WhatsApp');               // where they came from, not what they are
  album(4, '2013_09_22');             // a date in another dress
  album(5, 'Upanayanam');
  link(1, 1); link(1, 2); link(2, 3); link(3, 4); link(4, 4); link(5, 4); link(5, 5);
  p.close();
}

// ---- a catalog holding four of those five files; e.jpg is iCloud-only and not on disk
const dbPath = path.join(tmp, 'catalog.db');
const db = storage.open(dbPath);
['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'].forEach((f, i) => {
  db.prepare(`insert into asset(id, content_key, kind, size) values(?,?,?,?)`)
    .run(i + 1, 'k' + i, 'image', 1000);
  db.prepare(`insert into location(asset_id, root, rel_path, filename, state, size,
                                   first_seen_at, last_seen_at)
              values(?,?,?,?,'present',?,?,?)`)
    .run(i + 1, tmp, f, f, 1000, '2026-01-01', '2026-01-01');
});

check('a date is not a description, however it is written', () => {
  for (const d of ['26-Nov-2012', '2013_09_22', '07-Dec-2014 (1)', '12-Dec-2011'])
    assert.strictEqual(photos.isDescriptive(d), false, `${d} was treated as a description`);
});

check('where a file came from is not what it is of', () => {
  for (const n of ['WhatsApp', 'Instagram', 'Screenshots', 'Pictures', 'whatsapp',
                   // Photos appends a counter when a name repeats, and the counter should not
                   // rescue a name the filter would otherwise reject. "Pictures (1)" put 15
                   // files under a tag that says nothing.
                   'Pictures (1)', 'Originals', 'Twitter', 'Moldiv', 'Retrica', 'Layout'])
    assert.strictEqual(photos.isDescriptive(n), false, `${n} was treated as a description`);
});

check('real names survive the filter', () => {
  for (const n of ['Upanayanam', 'Darjeeling 26th Tiger hill, Batasia loop', 'world bicycle day'])
    assert.strictEqual(photos.isDescriptive(n), true, `${n} was thrown away`);
});

check('the join table is found by shape, not by its number', () => {
  // Named Z_41ASSETS in this fixture and Z_33ASSETS on the machine this was written on.
  const rows = photos.readAlbums(photosDb);
  assert.ok(rows.length, 'found nothing, so the join table name is hardcoded somewhere');
  assert.ok(rows.some(r => r.album === 'Upanayanam' && r.filename === 'e.jpg'));
});

check('only descriptive albums come back', () => {
  const names = new Set(photos.readAlbums(photosDb).map(r => r.album));
  assert.ok(names.has('Upanayanam'));
  assert.ok(!names.has('WhatsApp') && !names.has('26-Nov-2012'),
    'a date or a source name got through: ' + [...names].join(', '));
});

check('tags land on the files that are actually on disk', () => {
  const out = photos.importAlbums(db, { photosDb });
  const tagged = db.prepare("select count(distinct asset_id) n from annotation where source='photos-album'").get().n;
  assert.strictEqual(tagged, 3, `tagged ${tagged} files; a.jpg b.jpg from Darjeeling and d.jpg from Upanayanam`);
  assert.ok(/\d/.test(out.text), 'said nothing about what it did');
});

check('it says how many it could not reach, rather than quietly skipping them', () => {
  const out = photos.importAlbums(db, { photosDb });
  assert.ok(/not on this|iCloud|not on disk/i.test(out.text),
    'nothing mentions the files that are in Photos but not on this Mac: ' + out.text);
});

check('coverage does not move, because nobody looked at anything', () => {
  const before = tools.captionProgress(db).pct;
  photos.importAlbums(db, { photosDb });
  assert.strictEqual(tools.captionProgress(db).pct, before,
    'an album name counted as a description, so the percentage rose on work nobody did');
  const caps = db.prepare("select count(*) n from annotation where key='caption' and source='photos-album'").get().n;
  assert.strictEqual(caps, 0, 'album names were written as captions');
});

check('running it twice does not double the tags', () => {
  const one = db.prepare("select count(*) n from annotation where source='photos-album'").get().n;
  photos.importAlbums(db, { photosDb });
  const two = db.prepare("select count(*) n from annotation where source='photos-album'").get().n;
  assert.strictEqual(two, one, `${one} tags became ${two}`);
});

check('the tags are searchable, which is the whole point', () => {
  const hits = tools.search(db, 'Upanayanam');
  assert.ok((hits.data || []).length, 'searching the album name found nothing');
});

check('no Photos library is a sentence, not a stack trace', () => {
  const out = photos.importAlbums(db, { photosDb: path.join(tmp, 'nope.sqlite') });
  assert.ok(/no |not found|could not/i.test(out.text), 'unhelpful: ' + out.text);
});

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
if (!process.exitCode) console.log(`\n  photos: ${passed} checks pass`);
