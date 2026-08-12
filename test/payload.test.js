// How much a tool call is allowed to hand back.
//
// `look` sent up to 12 thumbnails at 768px and quality 60. Measured against a real Photos
// library that averages 132 KB of base64 each, so twelve came to 1.54 MB against a 1 MB
// ceiling, and the whole call failed. A failed look is a batch of pictures that never gets
// described, which is the one thing this tool exists to do. Counting images was always the
// wrong unit: a 71 KB frame and a 200 KB frame are not interchangeable.
//
//   node test/payload.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storage = require('../server/storage.js');
const vision = require('../server/vision.js');
const tools = require('../server/tools.js');

let passed = 0;
const check = (name, fn) => {
  try { fn(); console.log('  pass  ' + name); passed++; }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

const dbPath = path.join(os.tmpdir(), 'yellide-payload-' + process.pid + '.db');
const clean = p => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(p + s); } catch {} } };
clean(dbPath);
const db = storage.open(dbPath);

// Real files on disk, because look() refuses anything it cannot find. Contents do not matter:
// thumbnail() is stubbed below to return a fixed payload, which is what makes this a test of
// the budget rather than of whatever happens to be in ~/Pictures today.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yellide-payload-'));
const ids = [];
for (let i = 1; i <= 90; i++) {
  const f = path.join(dir, `f${i}.jpg`);
  fs.writeFileSync(f, 'not a real jpeg');
  db.prepare(`insert into asset(id, content_key, kind, size) values(?,?,?,?)`)
    .run(i, 'k' + i, 'image', 1000);
  db.prepare(`insert into location(asset_id, root, rel_path, filename, state, size,
                                   first_seen_at, last_seen_at)
              values(?,?,?,?,'present',?,?,?)`)
    .run(i, dir, `f${i}.jpg`, `f${i}.jpg`, 1000, '2026-01-01', '2026-01-01');
  ids.push(i);
}

// 132 KB of base64 per image, the measured average of a real library.
const HEAVY = 'A'.repeat(132 * 1024);
const realThumb = vision.thumbnail;
vision.thumbnail = () => HEAVY;

const CEILING = 1024 * 1024;
const sizeOf = blocks => blocks.reduce((n, b) =>
  n + (b.type === 'image' ? b.data.length : (b.text || '').length), 0);

check('look never hands back more than the protocol will carry', () => {
  const bytes = sizeOf(tools.look(db, ids).blocks);
  assert.ok(bytes < CEILING,
    `look returned ${(bytes / 1048576).toFixed(2)} MB against a ${CEILING / 1048576} MB ceiling. ` +
    'The whole call fails, so none of those pictures get described.');
});

check('a budget, not a count: heavy frames mean fewer of them', () => {
  const heavy = tools.look(db, ids).blocks.filter(b => b.type === 'image').length;
  vision.thumbnail = () => 'A'.repeat(20 * 1024);
  const light = tools.look(db, ids).blocks.filter(b => b.type === 'image').length;
  vision.thumbnail = () => HEAVY;
  assert.ok(light > heavy,
    `${light} light frames vs ${heavy} heavy ones. If the number is the same either way it is ` +
    'still counting images, and the next big library overflows again.');
});

check('it says how many it left behind, rather than silently truncating', () => {
  const text = tools.look(db, ids).blocks.filter(b => b.type === 'text').map(b => b.text).join(' ');
  assert.ok(/\d+ shown/.test(text), 'no count of what was shown');
  const m = text.match(/(\d+) (?:more|remaining|not shown)/i);
  assert.ok(m, 'nothing states how many were left out, so the caller assumes it saw everything');
  assert.ok(Number(m[1]) > 0, 'claims nothing was left out while 90 ids went in');
});

check('the contact sheet is a file on disk, so it holds far more than a tool result', () => {
  vision.thumbnail = () => 'A'.repeat(40 * 1024);
  const many = Array.from({ length: 90 }, (_, i) => i + 1);
  const out = tools.showPictures(db, many, { title: 'test' });
  const m = String(out.text).match(/(\d+)/);
  assert.ok(m && Number(m[1]) >= 90,
    `sheet reported ${m ? m[1] : 'nothing'} for 90 ids. It is written to disk, not returned, ` +
    'so the old 60 cap was a protocol limit that does not apply to it.');
  vision.thumbnail = () => HEAVY;
});

check('caption_next is limited by payload, not by an obsolete shoot count', () => {
  // The old cap was 10 shoots with a default of 6, sized to a look() that could only carry 12
  // images. look() budgets bytes now, so the cap was the only thing left holding batches down
  // to roughly 24 files a round: at that rate a half-described archive needs 150 more rounds.
  vision.thumbnail = () => 'A'.repeat(25 * 1024);
  const out = tools.captionNext(db, { limit: 40 });
  const imgs = out.blocks.filter(b => b.type === 'image').length;
  assert.ok(imgs > 10, `caption_next offered ${imgs} shoots. Anything at or under 10 is the old cap.`);
  const bytes = out.blocks.reduce((n, b) =>
    n + (b.type === 'image' ? b.data.length : (b.text || '').length), 0);
  assert.ok(bytes < CEILING, `caption_next returned ${(bytes / 1048576).toFixed(2)} MB`);
});

check('it tells the model to keep going rather than stopping to report', () => {
  vision.thumbnail = () => 'A'.repeat(25 * 1024);
  const text = tools.captionNext(db, { limit: 40 })
    .blocks.filter(b => b.type === 'text').map(b => b.text).join(' ');
  assert.ok(/without (stopping|asking|pausing)|do not stop|keep going/i.test(text),
    'nothing tells the model to loop, so each round costs the user another prompt');
});

vision.thumbnail = realThumb;
db.close(); clean(dbPath); fs.rmSync(dir, { recursive: true, force: true });
if (!process.exitCode) console.log(`\n  payload: ${passed} checks pass`);
