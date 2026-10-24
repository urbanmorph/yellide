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

  fs.rmSync(tmp, { recursive: true, force: true });
  if (!process.exitCode) console.log(`\n  catalog: ${passed} checks pass`);
})();
