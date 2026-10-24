// Drives: the marker Yellide writes is what tells one drive from another, whatever it is
// called. A renamed drive is the same drive; two SD cards both called EOS_DIGITAL are not.
//
//   node test/drives.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yellide-drives-'));
process.env.YELLIDE_HOME = path.join(tmp, 'home');
const storage = require('../server/storage.js');
const core = require('../server/core.js');
const tools = require('../server/tools.js');

let passed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log('  pass  ' + name); passed++; }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};
const put = (root, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body || rel);
};
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
// A folder stands in for a mounted drive: the test cannot mount one.
const scan = (db, root) => core.scan(db, root, { treatAsVolume: true });
const hits = (db, word) => db.prepare('select count(*) n from search where search match ?').get(word).n;

(async () => {
  await check('a renamed drive is the same drive, under its new name', async () => {
    const vols = path.join(tmp, 'v1');
    put(path.join(vols, 'KERALA'), 'Day1/boat.mp4', 'boat');
    put(path.join(vols, 'KERALA'), 'Day1/tea.jpg', 'tea');
    const db = storage.open(path.join(tmp, 'rename.db'));
    scan(db, path.join(vols, 'KERALA'));
    const id = db.prepare("select asset_id id from location where filename = 'boat.mp4'").get().id;
    tools.writeAnnotations(db, [{ id, caption: 'a houseboat on the backwaters' }]);

    fs.renameSync(path.join(vols, 'KERALA'), path.join(vols, 'KERALA_2023'));
    pause();
    scan(db, path.join(vols, 'KERALA_2023'));
    const locs = db.prepare('select root, state from location').all();
    assert.strictEqual(locs.length, 2, `${locs.length} locations for 2 files: ${JSON.stringify(locs)}`);
    assert.ok(locs.every(l => l.root.endsWith('KERALA_2023') && l.state === 'present'), JSON.stringify(locs));
    assert.strictEqual(hits(db, 'houseboat'), 1);

    // Unplugged, it is asked for by the name it has now.
    fs.renameSync(path.join(vols, 'KERALA_2023'), path.join(tmp, 'unplugged1'));
    assert.ok(/drive "KERALA_2023"/.test(tools.reveal(db, id).text), tools.reveal(db, id).text);
    assert.ok(/KERALA_2023 \(2 files/.test(tools.describeArchive(db).text), tools.describeArchive(db).text);
  });

  await check('two cards with the same name are two drives', async () => {
    // Every Canon card is EOS_DIGITAL and numbers its files from IMG_0001. Scanning the second
    // card marked every file on the first as gone, and overwrote them file by file.
    const vols = path.join(tmp, 'v2'), card = path.join(vols, 'EOS_DIGITAL');
    put(card, 'DCIM/100CANON/IMG_0001.JPG', 'wedding');
    put(card, 'DCIM/100CANON/IMG_0002.JPG', 'wedding 2');
    const db = storage.open(path.join(tmp, 'cards.db'));
    scan(db, card);
    const a = db.prepare("select asset_id id from location where filename = 'IMG_0001.JPG'").get().id;
    tools.writeAnnotations(db, [{ id: a, caption: 'the mandap at the wedding' }]);

    fs.renameSync(card, path.join(tmp, 'cardA'));                 // card A out
    put(card, 'DCIM/100CANON/IMG_0001.JPG', 'birthday');         // card B in, same name
    pause();
    scan(db, card);
    const b = db.prepare("select asset_id id from location where filename = 'IMG_0001.JPG' and asset_id != ?").get(a)?.id;
    assert.ok(b, 'the second card\'s photo was not indexed separately');
    assert.strictEqual(db.prepare("select count(*) n from location where state = 'missing'").get().n, 0,
      'the first card\'s photos were marked gone');
    const first = tools.locationsFor(db, a).best;
    assert.strictEqual(first.state, 'offline', `the first card reads as ${first.state}`);
    assert.ok(/drive "EOS_DIGITAL"/.test(tools.reveal(db, a).text), tools.reveal(db, a).text);
    assert.ok(!/#/.test(tools.getAsset(db, a).text), 'an internal drive key leaked into a path');
    assert.ok(!/#[0-9a-f]{8}/.test(tools.describeArchive(db).text), tools.describeArchive(db).text);
    assert.strictEqual(hits(db, 'mandap'), 1);

    // Swap back: card A is present again, card B is the one away.
    fs.renameSync(card, path.join(tmp, 'cardB'));
    fs.renameSync(path.join(tmp, 'cardA'), card);
    pause();
    scan(db, card);
    assert.strictEqual(tools.locationsFor(db, a).best.state, 'present');
    assert.strictEqual(tools.locationsFor(db, b).best.state, 'offline');
    assert.strictEqual(db.prepare("select count(*) n from location where state = 'missing'").get().n, 0);
    assert.strictEqual(db.prepare('select count(*) n from location').get().n, 3, 'locations were duplicated');
  });

  await check('with the marker declined, nothing is written to the drive', async () => {
    const root = path.join(tmp, 'v3', 'CLIENT');
    put(root, 'a.jpg');
    const db = storage.open(path.join(tmp, 'declined.db'));
    core.scan(db, root, { treatAsVolume: true, writeMarker: false });
    assert.ok(!fs.existsSync(path.join(root, '.yellide')), 'a marker was written');
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  if (!process.exitCode) console.log(`\n  drives: ${passed} checks pass`);
})();
