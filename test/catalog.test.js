// The catalog over time: scans that overlap with writes, drives that come and go.
//
//   node test/catalog.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yellide-catalog-'));
process.env.YELLIDE_HOME = path.join(tmp, 'home');
const storage = require('../server/storage.js');
const core = require('../server/core.js');
const tools = require('../server/tools.js');

let passed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log('  pass  ' + name); passed++; }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

// Contents only need to differ: identity is the bytes, and the parsers tolerate junk.
const put = (root, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body || rel);
};
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
const fresh = name => {
  const dbPath = path.join(tmp, name + '.db');
  return { db: storage.open(dbPath), dbPath };
};

(async () => {
  await check('a caption written while a scan holds the lock waits for it, not lost', async () => {
    // The scan worker commits in batches. Without a busy timeout, every write_annotations
    // that lands inside a batch failed at once with "database is locked", and the batch of
    // pictures the model had just looked at was never saved.
    const root = path.join(tmp, 'lock');
    put(root, 'Trip/a.jpg');
    const { db, dbPath } = fresh('lock');
    core.scan(db, root, { writeMarker: false });
    const id = db.prepare('select id from asset').get().id;

    const holder = spawn(process.execPath, ['-e', `
      const db = require(${JSON.stringify(require.resolve('../server/storage.js'))}).open(${JSON.stringify(dbPath)});
      db.exec('begin immediate'); db.exec("update asset set last_indexed_at = 'x'");
      process.stdout.write('locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      db.exec('commit');`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise(ok => holder.stdout.once('data', ok));

    const out = tools.writeAnnotations(db, [{ id, caption: 'a boat on the backwaters' }]);
    await new Promise(ok => holder.once('exit', ok));
    assert.ok(!/Nothing written/.test(out.text), out.text);
    assert.ok(db.prepare("select 1 from annotation where key='caption' and asset_id=?").get(id),
      'no caption in the catalog');
  });

  await check('a file on an unplugged drive is offline, not present', async () => {
    // Nothing ever set `offline`, so files on a drive that was not mounted read as on disk,
    // and reveal handed back a path that did not exist.
    const drive = path.join(tmp, 'KERALA_2023');
    put(drive, 'Backwaters/clip.mov');
    const { db } = fresh('unplug');
    core.scan(db, drive, { writeMarker: false });   // the stricter case: no marker, no volume row
    const id = db.prepare('select id from asset').get().id;

    fs.renameSync(drive, drive + '.unplugged');
    try {
      const where = tools.locationsFor(db, id).best;
      assert.strictEqual(where.state, 'offline');
      const r = tools.reveal(db, id, 'copy');
      assert.ok(/not (mounted|plugged in|connected)/i.test(r.text), `reveal said: ${r.text}`);
      assert.ok(r.text.includes('drive "KERALA_2023"'), `reveal does not name the drive: ${r.text}`);
      const hit = tools.search(db, 'clip').text;
      assert.ok(/not (mounted|plugged in|connected)/i.test(hit), `search shows it as on disk: ${hit}`);
    } finally { fs.renameSync(drive + '.unplugged', drive); }

    assert.strictEqual(tools.locationsFor(db, id).best.state, 'present', 'plugged back in, still offline');
  });

  await check('a scan that hits its file limit marks nothing missing, and says it stopped', async () => {
    // The walk stops at a cap. Every file past it went unseen, and everything unseen was
    // then marked missing, though it was still on disk. And nothing said the scan was cut.
    const root = path.join(tmp, 'capped');
    for (let i = 1; i <= 5; i++) put(root, `Shoot${i}/f${i}.jpg`);   // the cap is checked per folder
    const { db } = fresh('capped');
    core.scan(db, root, { writeMarker: false, cap: 10 });
    pause();   // "unseen" is last_seen_at older than this scan, so the clock has to move
    const r = core.scan(db, root, { writeMarker: false, cap: 2 });
    assert.strictEqual(db.prepare("select count(*) n from location where state='missing'").get().n, 0,
      'files beyond the cap were marked missing while still on disk');
    assert.ok(r.capped, 'the scan result does not say it stopped at the cap');
    const text = tools.describeArchive(db).text;
    assert.ok(/stopped|limit|not all|incomplete/i.test(text) && text.includes('2'),
      `describe_archive does not say the index is incomplete:\n${text}`);

    core.scan(db, root, { writeMarker: false, cap: 10 });
    assert.ok(!/stopped at/i.test(tools.describeArchive(db).text), 'still warns after a complete scan');
  });

  await check('a renamed file keeps its caption in both search indexes', async () => {
    // A rescan rebuilt the exact-match row from file metadata alone, so a caption survived a
    // rename only in the stemmed index, and by accident.
    const root = path.join(tmp, 'rename');
    put(root, 'Wedding/IMG_0001.jpg');
    const { db } = fresh('rename');
    core.scan(db, root, { writeMarker: false });
    const id = db.prepare('select id from asset').get().id;
    tools.writeAnnotations(db, [{ id, caption: 'garlands on the mandap' }]);
    fs.renameSync(path.join(root, 'Wedding/IMG_0001.jpg'), path.join(root, 'Wedding/renamed.jpg'));
    core.scan(db, root, { writeMarker: false });
    for (const t of ['search', 'search_en'])
      assert.strictEqual(db.prepare(`select count(*) n from ${t} where ${t} match 'mandap'`).get().n, 1,
        `caption gone from ${t} after a rename`);
  });

  await check('a file nobody has described is in the stemmed index too', async () => {
    // Scan wrote only the exact index, so "garland" never found a folder called Garlands
    // until someone captioned the file.
    const root = path.join(tmp, 'stem');
    put(root, 'Garlands/IMG_0002.jpg');
    const { db } = fresh('stem');
    core.scan(db, root, { writeMarker: false });
    assert.strictEqual(db.prepare("select count(*) n from search_en where search_en match 'garland'").get().n, 1);
  });

  await check('each search row is keyed by its asset, so replacing one is not a table scan', async () => {
    // asset_id is an unindexed FTS column, so "delete where asset_id = ?" read every row. On a
    // 21,000-file catalog that was 5.6 ms per file, paid on every scan and every caption.
    const root = path.join(tmp, 'rowid');
    for (let i = 1; i <= 3; i++) put(root, `Day${i}/IMG_${i}.jpg`);
    const { db } = fresh('rowid');
    core.scan(db, root, { writeMarker: false });
    const id = db.prepare('select id from asset limit 1').get().id;
    tools.writeAnnotations(db, [{ id, caption: 'twice over' }]);
    tools.writeAnnotations(db, [{ id, caption: 'twice over, again' }]);
    for (const t of ['search', 'search_en']) {
      const rows = db.prepare(`select rowid, asset_id from ${t}`).all();
      assert.strictEqual(rows.length, 3, `${t} has ${rows.length} rows for 3 files`);
      assert.ok(rows.every(r => r.rowid === r.asset_id), `${t} rows are not keyed by asset id`);
    }
  });

  await check('an existing catalog is migrated to asset-keyed search rows', async () => {
    const { db } = fresh('migrate');
    for (const t of ['search', 'search_en']) {
      db.prepare(`delete from ${t}`).run();
      db.prepare(`insert into ${t}(rowid, body, asset_id) values(900, 'old row', 7)`).run();
    }
    db.prepare('delete from schema_version where v >= 4').run();
    db.close();
    const again = storage.open(path.join(tmp, 'migrate.db'));
    for (const t of ['search', 'search_en'])
      assert.deepStrictEqual({ ...again.prepare(`select rowid, asset_id, body from ${t}`).get() },
        { rowid: 7, asset_id: 7, body: 'old row' }, `${t} not migrated`);
  });

  await check('the migration rebuilds rows that older scans left out or stripped', async () => {
    // A rescan skips unchanged files, so damage done by older versions (no stemmed row at
    // all, or a caption dropped after a rename) would otherwise never be repaired.
    const root = path.join(tmp, 'repair');
    put(root, 'Garlands/IMG_9.jpg');
    const { db, dbPath } = fresh('repair');
    core.scan(db, root, { writeMarker: false });
    const id = db.prepare('select id from asset').get().id;
    tools.writeAnnotations(db, [{ id, caption: 'mandap at dusk' }]);
    db.prepare('delete from search_en').run();
    db.prepare("update search set body = 'IMG_9.jpg' where rowid = ?").run(id);
    db.prepare('delete from schema_version where v >= 4').run();
    db.close();
    const again = storage.open(dbPath);
    for (const [t, word] of [['search', 'mandap'], ['search_en', 'garland']])
      assert.strictEqual(again.prepare(`select count(*) n from ${t} where ${t} match ?`).get(word).n, 1,
        `${t} was not rebuilt`);
  });

  await check('a Photos original moved to iCloud is in iCloud, not missing', async () => {
    // "Optimise Mac Storage" deletes local originals that are safe in iCloud. On a real
    // library, 2,908 of them read as "no longer on disk", as if the photographs were gone.
    // Photos itself says which are kept: listed, not trashed, held in iCloud.
    const root = path.join(tmp, 'Pictures');
    const lib = path.join(root, 'Photos Library.photoslibrary');
    for (const f of ['A/kept.jpg', 'B/trashed.jpg', 'C/deleted.jpg']) put(lib, 'originals/' + f);
    fs.mkdirSync(path.join(lib, 'database'));
    const { DatabaseSync } = require('node:sqlite');
    const p = new DatabaseSync(path.join(lib, 'database', 'Photos.sqlite'));
    p.exec(`create table ZASSET(Z_PK integer primary key, ZDIRECTORY text, ZFILENAME text,
                                ZTRASHEDSTATE integer, ZCLOUDLOCALSTATE integer)`);
    p.exec(`insert into ZASSET values (1,'A','kept.jpg',0,1), (2,'B','trashed.jpg',1,1)`);
    p.close();

    const { db } = fresh('icloud');
    core.scan(db, root, { writeMarker: false });
    const id = db.prepare("select asset_id id from location where filename = 'kept.jpg'").get().id;
    tools.writeAnnotations(db, [{ id, caption: 'a kingfisher on a wire' }]);
    for (const f of ['A/kept.jpg', 'B/trashed.jpg', 'C/deleted.jpg']) fs.unlinkSync(path.join(lib, 'originals', f));
    pause();
    core.scan(db, root, { writeMarker: false });

    const state = name => db.prepare('select state from location where filename = ?').get(name).state;
    assert.strictEqual(state('kept.jpg'), 'dematerialised', 'an original safe in iCloud reads as gone');
    assert.strictEqual(state('trashed.jpg'), 'missing', 'a trashed photo is not safe in iCloud');
    assert.strictEqual(state('deleted.jpg'), 'missing', 'a photo Photos no longer lists is gone');
    assert.ok(/kingfisher/.test(tools.getAsset(db, id).text), 'its description was lost');
    assert.ok(/iCloud/.test(tools.reveal(db, id).text), `reveal: ${tools.reveal(db, id).text}`);
    const text = tools.describeArchive(db).text;
    assert.ok(/Missing\s+2 files/.test(text), `only the two really gone should count as missing:\n${text}`);
    assert.ok(/1 (indexed )?(photo|file).*iCloud/i.test(text), `no word that one is safe in iCloud:\n${text}`);
  });

  await check('a shoot caption reaches its photos in iCloud, which never stand in for it', async () => {
    const root = path.join(tmp, 'Pictures2');
    const lib = path.join(root, 'Photos Library.photoslibrary');
    put(lib, 'originals/D/here.jpg'); put(lib, 'originals/D/away.jpg');
    fs.mkdirSync(path.join(lib, 'database'));
    const { DatabaseSync } = require('node:sqlite');
    const p = new DatabaseSync(path.join(lib, 'database', 'Photos.sqlite'));
    p.exec(`create table ZASSET(Z_PK integer primary key, ZDIRECTORY text, ZFILENAME text,
                                ZTRASHEDSTATE integer, ZCLOUDLOCALSTATE integer)`);
    p.exec(`insert into ZASSET values (1,'D','here.jpg',0,1), (2,'D','away.jpg',0,1)`);
    p.close();
    const { db } = fresh('icloud-shoot');
    core.scan(db, root, { writeMarker: false });
    fs.unlinkSync(path.join(lib, 'originals/D/away.jpg'));
    pause();
    core.scan(db, root, { writeMarker: false });

    const work = tools.getWork(db, {}).data;
    assert.strictEqual(work.length, 1, `${work.length} shoots offered`);
    assert.strictEqual(work[0].filename, 'here.jpg', 'an iCloud-only photo was offered to be looked at');
    assert.strictEqual(work[0].cluster_size, 2, 'the iCloud photo is not counted in its shoot');
    tools.writeAnnotations(db, [{ id: work[0].id, caption: 'monsoon clouds over the ghats', propagate: true }]);
    assert.strictEqual(db.prepare("select count(*) n from search where search match 'ghats'").get().n, 2,
      'the caption did not reach the photo in iCloud');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  if (!process.exitCode) console.log(`\n  catalog: ${passed} checks pass`);
})();
