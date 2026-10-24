// Indexing everything it sees: files listed before they are read, online-only placeholders,
// photos that live only in iCloud, files with no date inside them, older video formats,
// deep folders and cloud folders under ~/Library.
//
//   node test/coverage.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yellide-coverage-'));
process.env.YELLIDE_HOME = path.join(tmp, 'home');
const storage = require('../server/storage.js');
const core = require('../server/core.js');
const tools = require('../server/tools.js');
const video = require('../server/video.js');

let passed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log('  pass  ' + name); passed++; }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};
const put = (root, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body || rel);
};
// APFS keeps a truncated empty file sparse: a size, no blocks. That is exactly what an
// online-only iCloud Drive or Dropbox file looks like to stat.
const placeholder = (root, rel, size = 300000) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), ''); fs.truncateSync(path.join(root, rel), size);
};
const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
const fresh = name => storage.open(path.join(tmp, name + '.db'));
const hits = (db, word) => db.prepare('select count(*) n from search where search match ?').get(word).n;
const HEX = /^[0-9a-f]{64}$/;

// ---- container fixtures, the smallest each parser will accept ----
const ebml = (id, payload) => {
  const size = Buffer.alloc(8); size[0] = 0x01; size.writeUIntBE(payload.length, 2, 6);
  return Buffer.concat([Buffer.from(id, 'hex'), size, payload]);
};
const uint = (n, bytes = 4) => { const b = Buffer.alloc(bytes); b.writeUIntBE(n, 0, bytes); return b; };
function mkv({ ms, date, w, h }) {
  const f64 = Buffer.alloc(8); f64.writeDoubleBE(ms);
  const d = Buffer.alloc(8); d.writeBigInt64BE(BigInt(Date.parse(date) - Date.UTC(2001, 0, 1)) * 1000000n);
  const info = ebml('1549a966', Buffer.concat([ebml('2ad7b1', uint(1000000, 3)), ebml('4489', f64), ebml('4461', d)]));
  const tracks = ebml('1654ae6b', ebml('ae', ebml('e0', Buffer.concat([ebml('b0', uint(w, 2)), ebml('ba', uint(h, 2))]))));
  const segment = Buffer.concat([Buffer.from('18538067', 'hex'), Buffer.from('01ffffffffffffff', 'hex'), info, tracks]);
  return Buffer.concat([ebml('1a45dfa3', ebml('4282', Buffer.from('matroska'))), segment]);
}
function avi({ usPerFrame, frames, w, h, idit }) {
  const chunk = (id, body) => {
    const pad = body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    const n = Buffer.alloc(4); n.writeUInt32LE(body.length);
    return Buffer.concat([Buffer.from(id), n, body, pad]);
  };
  const avih = Buffer.alloc(56);
  avih.writeUInt32LE(usPerFrame, 0); avih.writeUInt32LE(frames, 16);
  avih.writeUInt32LE(w, 32); avih.writeUInt32LE(h, 36);
  const hdrl = chunk('LIST', Buffer.concat([Buffer.from('hdrl'), chunk('avih', avih),
                                            chunk('IDIT', Buffer.from(idit + '\n\0'))]));
  return chunk('RIFF', Buffer.concat([Buffer.from('AVI '), hdrl, chunk('LIST', Buffer.from('movi'))]));
}
// An MPEG-2 programme stream: a pack header at each end, 90 kHz clock between them.
function mpg(seconds) {
  const pack = scr => {
    const b = Buffer.alloc(14); b.writeUInt32BE(0x000001ba, 0);
    const v = BigInt(scr);
    b[4] = 0x44 | Number((v >> 27n) & 0x38n) | Number((v >> 28n) & 0x03n);
    b[5] = Number((v >> 20n) & 0xffn);
    b[6] = 0x04 | Number((v >> 12n) & 0xf8n) | Number((v >> 13n) & 0x03n);
    b[7] = Number((v >> 5n) & 0xffn);
    b[8] = 0x04 | Number((v << 3n) & 0xf8n);
    b[9] = 0x01; return b;
  };
  return Buffer.concat([pack(0), Buffer.alloc(200000, 0xff), pack(seconds * 90000)]);
}
// AVCHD: 192-byte transport packets, a programme clock reference in the first and the last.
function mts(seconds) {
  const packet = ticks => {
    const b = Buffer.alloc(192, 0xff); b.writeUInt32BE(0, 0);
    b[4] = 0x47; b[5] = 0x01; b[6] = 0x00; b[7] = 0x30; b[8] = 183; b[9] = 0x10;
    const base = ticks;
    b[10] = Math.floor(base / 2 ** 25) & 0xff; b[11] = Math.floor(base / 2 ** 17) & 0xff;
    b[12] = Math.floor(base / 2 ** 9) & 0xff; b[13] = Math.floor(base / 2) & 0xff; b[14] = (base & 1) << 7;
    return b;
  };
  const filler = Buffer.alloc(192 * 3000); for (let o = 0; o < filler.length; o += 192) filler[o + 4] = 0x47;
  return Buffer.concat([packet(1000), filler, packet(1000 + seconds * 90000)]);
}
function threeGp(seconds) {
  const box = (t, body) => Buffer.concat([uint(8 + body.length), Buffer.from(t), body]);
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(seconds * 1000, 16);
  return Buffer.concat([box('ftyp', Buffer.from('3gp4\0\0\0\0')), box('moov', box('mvhd', mvhd))]);
}

// A Photos library the way Photos lays it out, with the columns Yellide reads.
const APPLE_EPOCH = Date.UTC(2001, 0, 1) / 1000;
function photosLibrary(root, rows) {
  const lib = path.join(root, 'Photos Library.photoslibrary');
  fs.mkdirSync(path.join(lib, 'database'), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const p = new DatabaseSync(path.join(lib, 'database', 'Photos.sqlite'));
  p.exec(`create table ZASSET(Z_PK integer primary key, ZUUID text, ZDIRECTORY text, ZFILENAME text,
            ZKIND integer, ZTRASHEDSTATE integer, ZCLOUDLOCALSTATE integer, ZDATECREATED real,
            ZLATITUDE real, ZLONGITUDE real, ZDURATION real, ZWIDTH integer, ZHEIGHT integer);
          create table ZADDITIONALASSETATTRIBUTES(Z_PK integer primary key, ZASSET integer,
            ZORIGINALFILENAME text, ZTIMEZONEOFFSET integer);
          create table ZEXTENDEDATTRIBUTES(Z_PK integer primary key, ZASSET integer,
            ZCAMERAMAKE text, ZCAMERAMODEL text);`);
  rows.forEach((r, i) => {
    const pk = i + 1;
    p.prepare('insert into ZASSET values (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(pk, r.uuid, r.dir, r.file,
      r.video ? 1 : 0, r.trashed ? 1 : 0, r.cloud ?? 1, Date.parse(r.utc) / 1000 - APPLE_EPOCH,
      r.lat ?? -180, r.lon ?? -180, r.duration ?? 0, 4000, 3000);
    p.prepare('insert into ZADDITIONALASSETATTRIBUTES values (?,?,?,?)').run(pk, pk, r.original, 19800);
    p.prepare('insert into ZEXTENDEDATTRIBUTES values (?,?,?,?)').run(pk, pk, 'Canon', 'Canon EOS 600D');
    if (r.onDisk) put(lib, `originals/${r.dir}/${r.file}`);
  });
  p.close();
  return lib;
}

(async () => {
  await check('every file is searchable by name before any of them is read', async () => {
    // The first full scan of a real archive took 1h42m, hashing 2 MB a file. Nothing could be
    // found until a file's turn came. Listing costs a stat; reading can follow.
    const root = path.join(tmp, 'listed');
    put(root, 'Kerala 2023/houseboat.jpg'); put(root, 'Kerala 2023/DJI_0847.mp4');
    const db = fresh('listed');
    const r = core.inventory(db, root);
    assert.strictEqual(r.listed, 2, JSON.stringify(r));
    assert.strictEqual(hits(db, 'kerala'), 2, 'listed files are not searchable');
    assert.ok(/houseboat/.test(tools.search(db, 'kerala').text));
    const id = db.prepare("select asset_id id from location where filename = 'houseboat.jpg'").get().id;
    tools.writeAnnotations(db, [{ id, caption: 'a houseboat at dawn' }]);

    core.scan(db, root, { writeMarker: false });
    const assets = db.prepare('select content_key k from asset').all();
    assert.strictEqual(assets.length, 2, 'reading a listed file made a second asset');
    assert.ok(assets.every(a => HEX.test(a.k)), 'a read file kept its listing key');
    assert.strictEqual(hits(db, 'dawn'), 1, 'a caption written before the file was read was lost');
    assert.strictEqual(core.inventory(db, root).listed, 0, 'listing twice added files twice');
  });

  await check('an id handed out before a file is read still works after it is read', async () => {
    // caption_next hands out ids during a first scan. Reading the file used to replace the
    // asset, so a caption written to that id afterwards said "Wrote 0" and was lost.
    const root = path.join(tmp, 'rekey');
    put(root, 'Ghats/IMG_1.jpg');
    const db = fresh('rekey');
    core.inventory(db, root);
    const id = db.prepare('select id from asset').get().id;
    core.scan(db, root, { writeMarker: false });
    tools.writeAnnotations(db, [{ id, caption: 'mist over the ghats' }]);
    assert.strictEqual(hits(db, 'mist'), 1, 'a caption written to an id from before the read was lost');
  });

  await check('a file that cannot be read is still on disk, not missing', async () => {
    const root = path.join(tmp, 'unreadable');
    put(root, 'x/locked.mp4', 'bytes');
    fs.chmodSync(path.join(root, 'x/locked.mp4'), 0);
    const db = fresh('unreadable');
    core.scan(db, root, { writeMarker: false });
    pause();
    core.scan(db, root, { writeMarker: false });
    fs.chmodSync(path.join(root, 'x/locked.mp4'), 0o644);
    assert.strictEqual(db.prepare('select state from location').get().state, 'present');
  });

  await check('a file not yet read is never offered to be looked at', async () => {
    // Six copies of one ID card are six assets until read, so marking one private would not
    // reach the others, and a caption on one would spread.
    const root = path.join(tmp, 'unread');
    put(root, 'Docs/card.jpg');
    const db = fresh('unread');
    core.inventory(db, root);
    assert.strictEqual(tools.getWork(db, {}).data.length, 0, 'an unread file was offered');
  });

  await check('online-only placeholders are searchable by name, folder and date, never read', async () => {
    const root = path.join(tmp, 'dropbox');
    placeholder(root, 'Camera Uploads/2014-09-02 18.15.21.jpg');
    const db = fresh('dropbox');
    const r = core.scan(db, root, { writeMarker: false });
    assert.strictEqual(r.placeholders, 1, JSON.stringify(r));
    assert.strictEqual(hits(db, '"camera uploads"'), 1, 'a placeholder cannot be found by its folder');
    const a = db.prepare('select a.*, l.state from asset a join location l on l.asset_id = a.id').get();
    assert.strictEqual(a.state, 'dematerialised');
    assert.strictEqual(a.shot_at_local, '2014-09-02 18:15:21', 'no date from the name');
    assert.ok(/☁/.test(tools.search(db, 'uploads').text), 'search does not say it is online only');
    assert.ok(!/Photos/.test(tools.reveal(db, a.id, 'copy').text), 'a Dropbox file is not in Photos');
    assert.ok(/1 more|placeholder|online-only/i.test(tools.describeArchive(db).text));

    // Once the file is downloaded, the next scan reads it, and keeps what was known.
    tools.writeAnnotations(db, [{ id: a.id, tags: ['ghats'] }]);
    fs.writeFileSync(path.join(root, 'Camera Uploads/2014-09-02 18.15.21.jpg'), 'real bytes now');
    pause();
    core.scan(db, root, { writeMarker: false });
    const after = db.prepare('select a.content_key k, l.state from asset a join location l on l.asset_id = a.id').all();
    assert.strictEqual(after.length, 1, `${after.length} assets after the download`);
    assert.ok(HEX.test(after[0].k) && after[0].state === 'present', JSON.stringify(after));
    assert.strictEqual(hits(db, 'ghats'), 1, 'the tag did not survive the download');
  });

  await check('photos that exist only in iCloud are indexed from Photos itself', async () => {
    // Half a real library, 12,000 photos, had never been on this Mac, so no scan saw them.
    // Photos still holds their date, place, camera and original name.
    const root = path.join(tmp, 'Pictures');
    const lib = photosLibrary(root, [
      { uuid: 'U1', dir: 'D', file: 'U1.jpeg', original: 'IMG_0001.JPG', utc: '2019-06-27T14:02:47Z', onDisk: true },
      { uuid: 'U2', dir: 'E', file: 'U2.jpeg', original: 'IMG_0002.JPG', utc: '2019-06-27T15:10:00Z',
        lat: 12.9716, lon: 77.5946 },
      { uuid: 'U3', dir: 'F', file: 'U3.mov', original: 'IMG_0003.MOV', utc: '2019-06-28T09:00:00Z',
        video: true, duration: 42.5 },
      { uuid: 'U4', dir: 'F', file: 'U4.jpeg', original: 'IMG_0004.JPG', utc: '2019-06-28T09:00:00Z', trashed: true },
      { uuid: 'U5', dir: 'F', file: 'U5.jpeg', original: 'IMG_0005.JPG', utc: '2019-06-28T09:00:00Z', cloud: 0 },
    ]);
    const db = fresh('photos');
    core.scan(db, root, { writeMarker: false });

    const away = db.prepare(`select a.*, l.state from asset a join location l on l.asset_id = a.id
                             where l.filename = 'U2.jpeg'`).get();
    assert.ok(away, 'a photo only in iCloud was not indexed');
    assert.strictEqual(away.state, 'dematerialised');
    assert.strictEqual(away.shot_at_local, '2019-06-27 20:40:00', 'not dated in local time');
    assert.strictEqual(away.camera, 'Canon EOS 600D');
    assert.ok(Math.abs(away.gps_lat - 12.9716) < 1e-6, 'no GPS');
    const vid = db.prepare(`select a.* from asset a join location l on l.asset_id = a.id
                            where l.filename = 'U3.mov'`).get();
    assert.ok(vid && vid.kind === 'video' && vid.duration_s === 42.5, JSON.stringify(vid));
    for (const f of ['U4.jpeg', 'U5.jpeg'])
      assert.ok(!db.prepare('select 1 from location where filename = ?').get(f), `${f} was indexed`);

    assert.ok(/IMG_0002\.JPG/.test(tools.search(db, 'IMG_0002').text), 'not found by its original name');
    assert.ok(/Photos/.test(tools.reveal(db, away.id).text));
    const here = db.prepare(`select a.* from asset a join location l on l.asset_id = a.id
                             where l.filename = 'U1.jpeg'`).get();
    assert.strictEqual(here.shot_at_local, '2019-06-27 19:32:47', 'Photos did not date the file on disk');
    assert.strictEqual(hits(db, 'IMG_0001'), 1, 'the file on disk is not found by its original name');
    assert.ok(/Photos\s+2 /.test(tools.describeArchive(db).text), tools.describeArchive(db).text);

    // Same day, same camera: one shoot, looked at through the file on disk.
    const work = tools.getWork(db, { kind: 'image' }).data;
    assert.strictEqual(work.length, 1, `${work.length} image shoots offered`);
    assert.strictEqual(work[0].cluster_size, 2);
    tools.writeAnnotations(db, [{ id: work[0].id, caption: 'a temple tank at dusk', propagate: true }]);
    assert.strictEqual(hits(db, 'tank'), 2, 'the caption did not reach the photo in iCloud');

    // Read once with no date of its own, then moved to iCloud by Photos: Photos still dates it.
    db.prepare("update asset set shot_at = null, shot_at_local = null, dated_by = null where id = ?").run(here.id);
    fs.unlinkSync(path.join(lib, 'originals/D/U1.jpeg'));
    pause();
    core.scan(db, root, { writeMarker: false });
    assert.strictEqual(db.prepare('select shot_at_local d from asset where id = ?').get(here.id).d,
      '2019-06-27 19:32:47', 'a photo moved to iCloud was not dated from Photos');
    put(lib, 'originals/D/U1.jpeg');

    // Photos downloads it. The next scan reads it and it stays one asset.
    put(lib, 'originals/E/U2.jpeg', 'downloaded');
    pause();
    core.scan(db, root, { writeMarker: false });
    const now = db.prepare(`select a.content_key k, l.state from asset a join location l on l.asset_id = a.id
                            where l.filename = 'U2.jpeg'`).all();
    assert.strictEqual(now.length, 1);
    assert.ok(HEX.test(now[0].k) && now[0].state === 'present', JSON.stringify(now));
    assert.strictEqual(hits(db, 'tank'), 2, 'the caption was lost when the photo came down');
    assert.strictEqual(hits(db, 'IMG_0002'), 1, 'the original name was lost when the photo came down');

    // A scan cut short by its cap never saw the rest, so Photos must not call those in iCloud.
    const capped = core.scan(db, root, { writeMarker: false, cap: 1 });
    assert.ok(capped.capped);
    assert.strictEqual(db.prepare("select state from location where filename = 'U2.jpeg'").get().state, 'present',
      'a capped scan moved a photo on disk to iCloud');

    // Hourly rescans must not churn: nothing changed, nothing is written.
    pause();
    const again = core.scan(db, root, { writeMarker: false });
    assert.strictEqual(again.indexed, 0, JSON.stringify(again));
    assert.strictEqual(again.missing, 0, JSON.stringify(again));
  });

  await check('a file with no date inside it is dated by its name, then by the file', async () => {
    const root = path.join(tmp, 'dates');
    const names = {
      'WhatsApp Image 2026-02-16 at 14.35.13.jpeg': '2026-02-16 14:35:13',
      'IMG-20240612-WA0004.jpg': '2024-06-12',
      'Screenshot 2024-12-21 at 9.14.23 PM.png': '2024-12-21 21:14:23',
      'PXL_20230721_155524970.jpg': '2023-07-21 15:55:24',
      'VID_20220101_090000.mp4': '2022-01-01 09:00:00',
      'ab20140612cd.jpg': null,
    };
    for (const n of Object.keys(names)) put(root, 'Chat/' + n);
    put(root, 'Chat/logo.png');
    fs.utimesSync(path.join(root, 'Chat/logo.png'), new Date('2018-03-04T10:00:00'), new Date('2018-03-04T10:00:00'));
    const db = fresh('dates');
    core.scan(db, root, { writeMarker: false });
    const got = n => db.prepare(`select a.shot_at_local d, a.dated_by b from asset a
                                 join location l on l.asset_id = a.id where l.filename = ?`).get(n);
    for (const [n, want] of Object.entries(names)) {
      if (want === null) { assert.strictEqual(got(n).b, 'file', `${n} dated from inside a hex run`); continue; }
      assert.strictEqual(got(n).d, want, n);
      assert.strictEqual(got(n).b, 'filename', n);
    }
    assert.strictEqual(got('logo.png').d.slice(0, 10), '2018-03-04', 'no fallback to the file date');
    assert.strictEqual(got('logo.png').b, 'file');
    // A catalog built before dates were guessed: its files are unchanged, so they are never
    // read again, and must still be dated.
    db.prepare("update asset set shot_at = null, shot_at_local = null, dated_by = null").run();
    pause();
    core.scan(db, root, { writeMarker: false });
    assert.strictEqual(got('IMG-20240612-WA0004.jpg').d, '2024-06-12', 'an unchanged undated file stayed undated');
    assert.strictEqual(got('logo.png').b, 'file');
    // A copy date is not a shoot date: these stay grouped by folder, as undated files were.
    const shoots = tools.getWork(db, {}).data;
    assert.strictEqual(shoots.length, 1, `${shoots.length} shoots from one folder of chat images`);
  });

  await check('older and professional video formats are found and read', async () => {
    const root = path.join(tmp, 'formats');
    put(root, 'old/clip.mkv', mkv({ ms: 12500, date: '2016-05-04T10:20:30Z', w: 1920, h: 1080 }));
    put(root, 'old/casio.avi', avi({ usPerFrame: 40000, frames: 250, w: 640, h: 480, idit: 'Sat Mar 14 15:30:12 2009' }));
    put(root, 'old/handycam.mpg', mpg(7));
    put(root, 'old/nokia.3gp', threeGp(9));
    put(root, 'old/avchd.mts', mts(11));
    for (const ext of ['wmv', 'mod', 'tod', 'vob', 'dv', 'flv', 'mpeg', '3g2']) put(root, `old/x.${ext}`);
    put(root, 'old/frame.avif'); put(root, 'old/frame.jxl');
    const db = fresh('formats');
    core.scan(db, root, { writeMarker: false });
    const by = n => db.prepare(`select a.* from asset a join location l on l.asset_id = a.id
                                where l.filename = ?`).get(n);
    assert.ok(by('clip.mkv').duration_s === 12.5 && by('clip.mkv').width === 1920, JSON.stringify(by('clip.mkv')));
    assert.strictEqual(by('clip.mkv').shot_at.slice(0, 19), '2016-05-04T10:20:30');
    // An empty or oversized field must not cost the fields after it.
    const odd = video.matroska(...(() => {
      const f = path.join(root, 'old/odd.mkv');
      const info = ebml('1549a966', Buffer.concat([ebml('2ad7b1', Buffer.alloc(0)), ebml('4461', Buffer.from('7fffffffffffffff', 'hex')),
                                                  ebml('4489', Buffer.from([1, 2]))]));
      const tracks = ebml('1654ae6b', ebml('ae', ebml('e0', Buffer.concat([ebml('b0', uint(640, 2)), ebml('ba', uint(360, 2))]))));
      fs.writeFileSync(f, Buffer.concat([ebml('1a45dfa3', Buffer.alloc(0)), Buffer.from('18538067', 'hex'),
                                         Buffer.from('01ffffffffffffff', 'hex'), info, tracks]));
      return [fs.openSync(f, 'r'), fs.statSync(f).size];
    })());
    assert.ok(odd.width === 640 && odd.height === 360 && !odd.duration_s, JSON.stringify(odd));
    assert.strictEqual(by('casio.avi').duration_s, 10);
    assert.strictEqual(by('casio.avi').shot_at_local, '2009-03-14 15:30:12');
    assert.strictEqual(by('handycam.mpg').duration_s, 7);
    assert.strictEqual(by('nokia.3gp').duration_s, 9);
    assert.strictEqual(by('avchd.mts').duration_s, 11);
    for (const ext of ['wmv', 'mod', 'tod', 'vob', 'dv', 'flv', 'mpeg', '3g2'])
      assert.strictEqual(by(`x.${ext}`)?.kind, 'video', `.${ext} not indexed as video`);
    assert.strictEqual(by('frame.avif')?.kind, 'image');
    assert.strictEqual(by('frame.jxl')?.kind, 'image');
  });

  await check('deep folders and big archives are walked completely', async () => {
    const root = path.join(tmp, 'deep');
    put(root, 'a/b/c/d/e/f/g/h/i/j/k/l/deep.jpg');
    const db = fresh('deep');
    const r = core.scan(db, root, { writeMarker: false });
    assert.strictEqual(r.indexed, 1, 'a file twelve folders down was not indexed');
    assert.strictEqual(r.too_deep, 0);
    assert.ok(core.SCAN_CAP >= 500000, `the cap per folder is still ${core.SCAN_CAP}`);
  });

  await check('cloud folders under ~/Library are found, and a symlinked one only once', async () => {
    const home = path.join(tmp, 'h');
    const cs = path.join(home, 'Library', 'CloudStorage');
    put(cs, 'Dropbox/a.jpg'); put(cs, 'GoogleDrive-me@example.com/My Drive/b.jpg');
    fs.symlinkSync(path.join(cs, 'Dropbox'), path.join(home, 'Dropbox'));
    const out = spawnSync(process.execPath, ['-e',
      `console.log(JSON.stringify(require(${JSON.stringify(require.resolve('../server/discover.js'))}).candidateRoots()))`],
      { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    const roots = JSON.parse(out.stdout).map(r => r.path).filter(p => p.startsWith(home));
    assert.ok(roots.some(p => p.endsWith('GoogleDrive-me@example.com')), `no Google Drive: ${roots}`);
    assert.strictEqual(roots.filter(p => /Dropbox$/.test(p)).length, 1, `Dropbox twice: ${roots}`);
  });

  await check('a scan cut off by quitting Claude does not block every later scan', async () => {
    // The job row stayed "running" forever, and auto-scan never starts while one runs.
    const home = path.join(tmp, 'stale');
    fs.mkdirSync(home);
    const d = storage.open(path.join(home, 'catalog.db'));
    d.prepare("insert into scan_job(root, state, started_at) values('/x', 'running', '2026-01-01')").run();
    d.close();
    const rpc = [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18',
                   capabilities: {}, clientInfo: { name: 't', version: '0' } } }]
      .map(m => JSON.stringify(m)).join('\n') + '\n';
    spawnSync(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { input: rpc, timeout: 8000,
      env: { ...process.env, YELLIDE_HOME: home, YELLIDE_COUNTER: 'http://127.0.0.1:9' } });
    const again = storage.open(path.join(home, 'catalog.db'));
    assert.strictEqual(again.prepare("select count(*) n from scan_job where state = 'running'").get().n, 0);
    // But a scan another live Yellide is running (Claude Desktop and Claude Code at once) is not.
    again.prepare("insert into scan_job(root, state, started_at, pid) values('/y', 'running', '2026-01-01', ?)").run(process.pid);
    again.close();
    spawnSync(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], { input: rpc, timeout: 8000,
      env: { ...process.env, YELLIDE_HOME: home, YELLIDE_COUNTER: 'http://127.0.0.1:9' } });
    const third = storage.open(path.join(home, 'catalog.db'));
    assert.strictEqual(third.prepare("select count(*) n from scan_job where state = 'running'").get().n, 1,
      'a live scan in another process was cancelled');
  });

  await check('diagnostics says when the last scan was, and that an old index refreshes on asking', async () => {
    // After an upgrade the report showed the new version beside the old counts, with nothing
    // to say a fresh scan had not run yet and would start the moment anyone asked.
    const db = fresh('diag');
    db.prepare("insert into scan_job(root, state, started_at, finished_at) values('/x','done','2026-08-12T13:02:04Z','2026-08-12T13:02:07Z')").run();
    const text = tools.diagnosticsReport(db, {}).text;
    assert.ok(/last scan\s+2026-08-12/.test(text), text);
    assert.ok(/ask about your media/i.test(text), 'nothing says how to start a fresh scan:\n' + text);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  if (!process.exitCode) console.log(`\n  coverage: ${passed} checks pass`);
})();
