// The counter payload, tested before it is trusted.
//
// Written first because the numbers on a public counter are the one thing nobody can
// sanity-check by looking. The first version of contribute.js reported 2% coverage while
// the diagnostics report said 51%, because it counted assets with a caption row of their
// own and ignored the shoot propagation that does most of the work. Both numbers came from
// the same database and only one was right.
//
//   node test/contribute.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storage = require('../server/storage.js');
const tools = require('../server/tools.js');
const contribute = require('../server/contribute.js');

let passed = 0;
const check = (name, fn) => {
  try { fn(); console.log('  pass  ' + name); passed++; }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

// A small catalog of its own, so the test never depends on whatever is on this machine.
const dbPath = path.join(os.tmpdir(), 'yellide-contribute-test-' + process.pid + '.db');
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
const db = storage.open(dbPath);

const iso = '2026-01-0';
function asset(id, kind, day, camera) {
  db.prepare(`insert into asset(id, content_key, kind, shot_at, shot_at_local, camera, size)
              values(?,?,?,?,?,?,?)`)
    .run(id, 'test-key-' + id, kind, iso + day, iso + day, camera, 1000);
  // A shoot is only built from assets that are actually on disk, so every fixture asset
  // needs a present location or the whole catalog reads as empty.
  db.prepare(`insert into location(asset_id, root, rel_path, filename, state, size,
                                   first_seen_at, last_seen_at)
              values(?,?,?,?,'present',?,?,?)`)
    .run(id, '/tmp/fixture', 'f' + id + '.jpg', 'f' + id + '.jpg', 1000, iso + day, iso + day);
}
function caption(assetId, value) {
  db.prepare(`insert into annotation(asset_id, key, value, source, created_at)
              values(?,?,?,?,?)`).run(assetId, 'caption', value, 'agent', new Date().toISOString());
}

// One shoot of four images with a single caption between them, which is exactly the case
// the first implementation got wrong, plus an undescribed shoot and some audio.
for (const i of [1, 2, 3, 4]) asset(i, 'image', '1', 'Canon EOS 600D');
for (const i of [5, 6]) asset(i, 'video', '2', 'Canon EOS 600D');
for (const i of [7, 8]) asset(i, 'image', '3', 'iPhone SE');
asset(9, 'audio', '4', null);
caption(1, 'two men steadying a small boy learning to ride');
caption(5, 'a red cargo cycle at dusk');

const payload = () => contribute.payload(db, '9.9.9', 'test-install-id');

check('counts each kind exactly', () => {
  const p = payload();
  assert.strictEqual(p.images, 6, 'images');
  assert.strictEqual(p.video, 2, 'video');
  assert.strictEqual(p.audio, 1, 'audio');
  assert.strictEqual(p.files_total, 9, 'files_total is the sum of the three');
});

check('coverage matches what the diagnostics report tells the user', () => {
  const truth = tools.captionProgress(db);
  assert.strictEqual(payload().coverage, truth.pct,
    `payload says ${payload().coverage}% and diagnostics says ${truth.pct}%. ` +
    'A counter that disagrees with the report in front of the user is worse than no counter.');
});

check('a caption covers its whole shoot, not just the file it was written on', () => {
  // 4 images on day 1 and 2 videos on day 2 are described by two captions; 2 images on
  // day 3 are not. 6 of 8 image-and-video files, so 75%.
  assert.strictEqual(payload().coverage, 75);
});

check('audio is counted but never inflates coverage', () => {
  // coverage is over images and video only, so the lone audio file must not move it
  const before = payload().coverage;
  asset(10, 'audio', '5', null);
  assert.strictEqual(payload().coverage, before, 'adding audio changed the coverage figure');
  assert.strictEqual(payload().audio, 2);
});

check('carries nothing but counts', () => {
  const keys = Object.keys(payload()).sort();
  assert.deepStrictEqual(keys,
    ['audio', 'captions', 'coverage', 'files_total', 'images', 'install_id', 'version', 'video'],
    'the payload gained or lost a field');
  const blob = JSON.stringify(payload());
  for (const leak of ['steadying', 'cargo cycle', '.jpg', '/Users', 'Canon', 'iPhone'])
    assert.ok(!blob.includes(leak), `payload leaked ${leak}`);
});

check('an empty index reports zero rather than dividing by it', () => {
  const p2 = path.join(os.tmpdir(), 'yellide-empty-' + process.pid + '.db');
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(p2 + s); } catch {} }
  const empty = storage.open(p2);
  const p = contribute.payload(empty, '9.9.9', 'x');
  assert.strictEqual(p.coverage, 0);
  assert.strictEqual(p.files_total, 0);
  empty.close();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(p2 + s); } catch {} }
});

check('sends nothing without consent, and nothing without an endpoint', () => {
  assert.strictEqual(contribute.consent(db), null, 'starts unasked');
  assert.strictEqual(contribute.maybeSend(db, '9.9.9', 'x'), false, 'sent while unasked');
  contribute.setConsent(db, true);
  assert.strictEqual(contribute.consent(db), 'yes');
  assert.strictEqual(contribute.maybeSend(db, '9.9.9', 'x'), false,
    'sent with consent but no endpoint configured');
  contribute.setConsent(db, false);
  assert.strictEqual(contribute.maybeSend(db, '9.9.9', 'x'), false, 'sent after being declined');
});

check('never asks before there is a finished index worth counting', () => {
  assert.strictEqual(contribute.shouldAsk(db), false);
});

db.close();
for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
if (!process.exitCode) console.log(`\n  contribute: ${passed} checks pass`);
