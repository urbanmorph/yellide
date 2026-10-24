// Yellide core — the entire release-one loop, as one dependency-free module.
// scan → identity → Tier 0 container metadata → SQLite → FTS5 → query.
// Used by both the CLI test and the MCP server, so what runs here runs there.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const exif = require('./exif.js');
const audio = require('./audio.js');
const storage = require('./storage.js');
const photos = require('./photos.js');
const video = require('./video.js');

// A "video index" would miss a terabyte of podcast recordings entirely. Media, not video.
// Older phones wrote 3GP, SD camcorders MPEG-2 (.mpg .mod), AVCHD ones MPEG-TS (.mts .tod),
// MiniDV tapes .dv, Windows .wmv. Leaving them out left a decade of family video unseen.
const VIDEO = new Set(['.mp4','.mov','.m4v','.mxf','.avi','.mkv','.mts','.m2ts','.m2t','.braw','.r3d','.ari',
                       '.insv','.lrv','.webm','.3gp','.3g2','.mpg','.mpeg','.m2v','.vob','.mod','.tod','.dv',
                       '.wmv','.asf','.flv','.f4v','.ogv']);
const AUDIO = new Set(['.wav','.aif','.aiff','.mp3','.m4a','.m4b','.flac','.aac','.ogg','.opus','.caf','.wma','.amr']);
// The containers the atom parser reads. Everything else has its own parser or none.
const ISO_BMFF = new Set(['.mp4','.mov','.m4v','.3gp','.3g2','.insv','.lrv','.m4a','.m4b','.aac','.caf']);
// What you shot, not what you wrote: video, audio and stills. No documents.
const MEDIA = new Set([...VIDEO, ...AUDIO, ...exif.IMAGE]);
const KIND = ext => VIDEO.has(ext) ? 'video' : AUDIO.has(ext) ? 'audio'
                  : exif.IMAGE.has(ext) ? 'image' : null;
// Real drives contain code, caches and app bundles. A scanner that walks them hangs.
const SKIP = /^(node_modules|\.git|Library|venv|\.venv|__pycache__|dist|build|target|vendor|Pods|\.next|\.cache|site-packages|AppData|Program Files|Program Files \(x86\)|Windows|\$Recycle\.Bin|System Volume Information|snap|\.local|\.cache|miniforge3|anaconda3|miniconda3|\.conda|\.rustup|\.cargo|\.npm|\.pyenv|\.nvm|\.gradle|\.m2|\.pub-cache|flutter|Homebrew)$/i;
const PKG_DIR = /\.(app|bundle|framework|rdc|xcodeproj|lrdata)$/i;
// Apple media libraries are packages, but they hold the user's real photos and footage.
// Index only their originals; their derivatives/renders/caches are thumbnails and edits.
const MEDIA_LIBRARY = /\.(photoslibrary|aplibrary|imovielibrary|fcpbundle|theater)$/i;
const ORIGINALS_DIR = /^(originals|Original Media|Modified Media|Masters)$/i;

// ---- cross-platform: removable/mounted volumes ----
// macOS /Volumes · Windows drive letters · Linux /media,/run/media,/mnt.
// Deliberately no shelling out to diskutil/wmic — one code path, every OS.
function volumeRoots() {
  const out = [];
  const push = p => { try { if (fs.statSync(p).isDirectory()) out.push(p); } catch {} };
  if (process.platform === 'darwin') {
    try { for (const n of fs.readdirSync('/Volumes')) if (!n.startsWith('.')) push(path.join('/Volumes', n)); } catch {}
  } else if (process.platform === 'win32') {
    for (let c = 67; c <= 90; c++) push(String.fromCharCode(c) + ':\\');   // C: .. Z:
  } else {
    const user = process.env.USER || process.env.LOGNAME || '';
    for (const base of [`/media/${user}`, '/media', `/run/media/${user}`, '/mnt']) {
      try { for (const n of fs.readdirSync(base)) if (!n.startsWith('.')) push(path.join(base, n)); } catch {}
    }
  }
  return out;
}

// A drive manifest written on Windows must resolve on macOS. Store POSIX separators and
// NFC always; convert back to native only when touching the filesystem.
const toPortable = p => p.split(path.sep).join('/').normalize('NFC');
const fromPortable = p => p.split('/').join(path.sep);
const MAC_EPOCH = -2082844800;
const CONTAINERS = new Set(['moov','trak','mdia','minf','stbl','udta','meta','ilst']);
// Vendor metadata containers to descend into, and leaves to read text from.
const VENDOR_BOX  = /^(NCDT|CNDA|CNTH|GPMF|AMBA|SDPX)$/;                 // Nikon, Canon, GoPro, Sony
const VENDOR_LEAF = /^(NCHD|NCTG|NCDB|CNCV|CNMN|CNFV|FIRM|LENS|CAME|MINF|SDPX|manu|modl)$/;
const UDTA_TEXT   = new Set(['\xa9mak','\xa9mod','\xa9swr','\xa9nam','\xa9day','\xa9enc','\xa9too',
                             '©mak','©mod','©swr','©nam','©day','©enc','©too','mdta','data']);
const CAM_DATE    = /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/;
const printableRuns = buf => [...buf.toString('latin1').matchAll(/[\x20-\x7e]{3,}/g)]
  .map(m => m[0].trim()).filter(Boolean).slice(0, 24);
// "NIKON CORPORATION" + "NIKON D5300" -> "Nikon D5300". Longest informative run wins.
const ENCODER_JUNK = /^(Lavf|Lavc|libav|ffmpeg|x264|x265|HandBrake|isom|mp42|qt +|Apple Video Media|Sound Media|Core Media|Google|GStreamer|Chrome|Mac OS X|Motion|Compressor)/i;
function pickCamera(parts) {
  if (!parts.length) return null;
  // A muxer name is not a camera. "Lavf58.20.100" appearing as camera metadata is worse
  // than a blank, because it looks like a real answer.
  const clean = parts.filter(x => !ENCODER_JUNK.test(x)
                                && !/^(PRESET|STANDARD|AUTO|NORMAL|OFF|ON|\d[\d:. ]*)$/i.test(x)
                                && x.length >= 3 && /[a-z]/i.test(x));
  if (!clean.length) return null;
  const model = clean.find(x => /\d/.test(x) && x.length < 40 && !/^Ver/i.test(x)) || clean[0];
  const make  = clean.find(x => /corporation|nikon|sony|canon|apple|dji|gopro|panasonic|fujifilm|blackmagic/i.test(x));
  const norm  = s2 => s2.replace(/\s+corporation/i, '').replace(/\s+/g, ' ').trim();
  if (make && model && norm(model).toLowerCase().includes(norm(make).toLowerCase())) return norm(model);
  return [make && norm(make), model && norm(model)].filter(Boolean).join(' ').slice(0, 80) || null;
}

// A source tree is not an archive. Dropping documents still left 20,001 PNGs in ~/GitHub —
// app icons, sprites and test fixtures, 53% of everything found and 0.88 GB across all of
// them. A project manifest is a reliable marker: skip the whole subtree.
const PROJECT_MARKER = new Set(['package.json','pubspec.yaml','Cargo.toml','go.mod','requirements.txt',
  'pyproject.toml','Gemfile','Podfile','composer.json','pom.xml','build.gradle','CMakeLists.txt',
  'Makefile','tsconfig.json','.venv','manifest.json']);

// `stats` records where the walk gave up, so a partial walk is never mistaken for a whole one.
function walkTree(dir, out, depth = 0, cap = 5000, maxDepth = 8, stats = {}) {
  if (depth > maxDepth) { stats.deep = (stats.deep || 0) + 1; return out; }
  if (out.length >= cap) { stats.capped = true; return out; }
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  // Never skip the root the user pointed at — only subtrees discovered on the way down.
  if (depth > 0 && ents.some(e => e.isFile() && PROJECT_MARKER.has(e.name))) return out;
  for (const e of ents) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.test(e.name) || PKG_DIR.test(e.name)) continue;
      if (MEDIA_LIBRARY.test(e.name)) {
        if (/\.photoslibrary$/i.test(e.name)) (stats.libraries ||= []).push(p);
        walkLibrary(p, out, cap, stats); continue;
      }
      walkTree(p, out, depth + 1, cap, maxDepth, stats);
    }
    else if (MEDIA.has(path.extname(e.name).toLowerCase())) {
      try { const st = fs.statSync(p); out.push({ p, size: st.size, mtime: st.mtimeMs, blocks: st.blocks }); } catch {}
    }
  }
  return out;
}

// Inside a Photos/iMovie/FCP library: find the originals, ignore everything else.
function walkLibrary(lib, out, cap, stats) {
  const roots = [];
  const scan = (dir, depth) => {
    if (depth > 3) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (ORIGINALS_DIR.test(e.name)) { roots.push(path.join(dir, e.name)); continue; }
      if (/^(resources|private|database|caches|thumbnails|previews)$/i.test(e.name)) continue;
      scan(path.join(dir, e.name), depth + 1);
    }
  };
  scan(lib, 0);
  for (const r of roots) walkTree(r, out, 0, cap, 6, stats);
  return out;
}

function topLevel(fd, fileSize) {
  const hdr = Buffer.alloc(16), found = []; let off = 0;
  while (off + 8 <= fileSize && found.length < 64) {
    const n = fs.readSync(fd, hdr, 0, 16, off); if (n < 8) break;
    let size = hdr.readUInt32BE(0), h = 8;
    const type = hdr.toString('latin1', 4, 8);
    if (!/^[\x20-\x7e]{4}$/.test(type)) break;
    if (size === 1) { if (n < 16) break; size = Number(hdr.readBigUInt64BE(8)); h = 16; }
    else if (size === 0) size = fileSize - off;
    if (size < h) break;
    found.push({ type, off, size, hdr: h }); off += size;
  }
  return found;
}

function atoms(buf, start, end, cb) {
  let o = start;
  while (o + 8 <= end) {
    let size = buf.readUInt32BE(o), h = 8;
    const type = buf.toString('latin1', o + 4, o + 8);
    if (!/^[\x20-\x7e\xa9]{4}$/.test(type)) return;
    if (size === 1) { if (o + 16 > end) return; size = Number(buf.readBigUInt64BE(o + 8)); h = 16; }
    else if (size === 0) size = end - o;
    if (size < h || o + size > end) return;
    cb(type, o + h, o + size, buf); o += size;
  }
}

function extract(file) {
  const kind = KIND(path.extname(file).toLowerCase());
  const ext = path.extname(file).toLowerCase();
  if (kind === 'audio' && !ISO_BMFF.has(ext)) {
    const r = audio.extractAudio(file, kind);
    return { ...r, content_key: r.dematerialised ? null : contentKey(file) };
  }
  if (kind === 'image' || kind === 'design') {
    const r = kind === 'image' ? exif.extractImage(file) : exif.extractDesign(file);
    // Never hash a placeholder either — hashing reads the first and last megabyte.
    return { ...r, content_key: r.dematerialised ? null : contentKey(file) };
  }
  return extractVideo(file, kind, ext);
}

// Identity is the same for every format — it is the one thing that must never differ.
function contentKey(file) {
  const st = fs.statSync(file), fd = fs.openSync(file, 'r');
  try {
    const MB = 1 << 20, h = crypto.createHash('sha256');
    const a = Buffer.alloc(Math.min(MB, st.size)); fs.readSync(fd, a, 0, a.length, 0); h.update(a);
    if (st.size > MB) { const b = Buffer.alloc(MB); fs.readSync(fd, b, 0, MB, st.size - MB); h.update(b); }
    h.update(String(st.size));
    return h.digest('hex');
  } finally { fs.closeSync(fd); }
}

function extractVideo(file, kind, ext) {
  const st = fs.statSync(file);
  if (exif.isDataless(st))
    return { size: st.size, kind: kind || 'video', dematerialised: true, container: null,
             brand: null, duration_s: null, shot_at: null, shot_at_local: null,
             width: null, height: null, camera: null, gps: null, meta_bytes: 0,
             content_key: null };
  const fd = fs.openSync(file, 'r');
  const r = { size: st.size, kind: kind || 'video', container: null, brand: null, duration_s: null, shot_at: null,
              width: null, height: null, camera: null, camera_parts: [], gps: null,
              shot_at_local: null, meta_bytes: 0,
              dematerialised: false };
  try {
    if (!ISO_BMFF.has(ext)) {
      // AVI, MKV and the MPEG streams have parsers of their own; MXF, BRAW, R3D and the rest are
      // found and hashed, and dated by their name or their file when nothing inside says.
      if (video.BY_EXT[ext]) { try { Object.assign(r, video.BY_EXT[ext](fd, st.size)); } catch {} }
      delete r.camera_parts;
      r.content_key = contentKey(file);
      return r;
    }
    const tops = topLevel(fd, st.size);
    const ftyp = tops.find(a => a.type === 'ftyp');
    if (ftyp) { r.container = 'ISO-BMFF'; const b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, ftyp.off + 8); r.brand = b.toString('latin1').trim(); }
    const moov = tops.find(a => a.type === 'moov');
    if (moov && moov.size < (64 << 20)) {
      const buf = Buffer.alloc(moov.size); fs.readSync(fd, buf, 0, moov.size, moov.off); r.meta_bytes = moov.size;
      atoms(buf, moov.hdr, moov.size, function visit(t, s, e, b) {
        if (t === 'mvhd') {
          const ver = b[s];
          const c  = ver === 0 ? b.readUInt32BE(s + 4)  : Number(b.readBigUInt64BE(s + 4));
          const ts = ver === 0 ? b.readUInt32BE(s + 12) : b.readUInt32BE(s + 20);
          const du = ver === 0 ? b.readUInt32BE(s + 16) : Number(b.readBigUInt64BE(s + 24));
          if (ts) r.duration_s = +(du / ts).toFixed(2);
          if (c)  r.shot_at = new Date((c + MAC_EPOCH) * 1000).toISOString();
        }
        if (t === 'tkhd') {
          const ver = b[s], o2 = ver === 0 ? s + 76 : s + 88;
          if (o2 + 8 <= e) { const w = b.readUInt32BE(o2) / 65536, h2 = b.readUInt32BE(o2 + 4) / 65536;
            if (w > 0 && h2 > 0 && w > (r.width || 0)) { r.width = Math.round(w); r.height = Math.round(h2); } }
        }
        // Camera metadata is vendor-specific, not standard. Apple/DJI use ©mak/©mod;
        // Nikon buries it in udta/NCDT/NCHD+NCTG; Canon uses CNCV/CNMN; GoPro FIRM/CAME.
        // Looking only for ©mak reports "0% camera tags" on a Nikon file that plainly
        // says NIKON D5300 — so harvest printable runs from every udta leaf instead.
        if (/^[\xa9©](xyz)$/.test(t)) {
          r.gps = b.toString('utf8', s, Math.min(e, s + 120)).replace(/[\x00-\x1f]/g, ' ').trim().replace(/^\W+/, '');
        } else if (UDTA_TEXT.has(t) || VENDOR_LEAF.test(t)) {
          const runs = printableRuns(b.slice(s, Math.min(e, s + 2048)));
          for (const run of runs) {
            if (CAM_DATE.test(run)) { r.shot_at_local = r.shot_at_local || run; continue; }
            if (run.length < 3 || /^\d+$/.test(run)) continue;
            if (!r.camera_parts.includes(run)) r.camera_parts.push(run);
          }
        }
        if (CONTAINERS.has(t) || VENDOR_BOX.test(t)) atoms(b, s, e, visit);
      });
    }
    r.camera = pickCamera(r.camera_parts);
    delete r.camera_parts;
    r.content_key = contentKey(file);
  } finally { fs.closeSync(fd); }
  return r;
}

// Tier 1: the folder tree and filename are the user's own vocabulary. Free tags.
function tier1(fullPath, root) {
  const rel = path.relative(root, fullPath);
  const parts = rel.split(path.sep).slice(0, -1).filter(Boolean);
  const tags = [];
  parts.forEach((seg, i) => tags.push({ key: i === 0 ? 'project' : 'folder', value: seg, source: 'folder' }));
  const base = path.basename(fullPath, path.extname(fullPath));
  const m = base.match(/^([A-Z]{1,4})[_-]?(\d{3,5})$/);       // DJI_0847, A001, DSC_0001
  if (m) tags.push({ key: 'camera_prefix', value: m[1], source: 'filename' });
  return tags;
}

// When the file itself carries no date. Phones, chat apps and screenshot tools write the moment
// into the name: "WhatsApp Image 2026-02-16 at 14.35.13", "IMG-20240612-WA0004",
// "PXL_20230721_155524970", "Screenshot 2024-12-21 at 9.14.23 PM", "2014-09-02 18.15.21".
// Separators must agree, the year must be plausible, and a run of digits or hex is never split.
const NAME_DATE = /(?<![0-9a-f])((?:19[89]|20[0-4])\d)([-_.]?)(0[1-9]|1[0-2])\2(0[1-9]|[12]\d|3[01])(?!\d)(?:[^\d]{0,4}?(?:at\s*)?([01]?\d|2[0-3])[.:_-]?([0-5]\d)[.:_-]?([0-5]\d)\d*\s*([AP]M)?)?/i;
const pad2 = n => String(n).padStart(2, '0');
function dateFromName(name) {
  const m = String(name).match(NAME_DATE);
  if (!m || +m[1] > new Date().getFullYear() + 1) return null;
  const d = `${m[1]}-${m[3]}-${m[4]}`;
  if (new Date(d + 'T00:00:00Z').getUTCDate() !== +m[4]) return null;       // 2023-02-30
  if (m[5] == null) return d;
  let h = +m[5];
  if (m[8]) { const pm = /p/i.test(m[8]); if (h > 12) return d; h = (h % 12) + (pm ? 12 : 0); }
  return `${d} ${pad2(h)}:${m[6]}:${m[7]}`;
}
const localStamp = ms => {
  const t = new Date(ms);
  return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ` +
         `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
};
// Fill a missing date: the name first, then the file's own timestamp, which may only say when
// it was copied, so it is marked as such and never groups files into a shoot.
function fallbackDate(x, name, mtime) {
  if (x.shot_at || x.shot_at_local) return x;
  const n = dateFromName(name);
  const local = n || (mtime ? localStamp(mtime) : null);
  if (!local) return x;
  return { ...x, shot_at_local: local, shot_at: local.replace(' ', 'T'), dated_by: n ? 'filename' : 'file' };
}

// Camera blocks use colons in the date part. Normalise so ordering and display both work.
function normDate(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` + (m[4] ? ` ${m[4]}:${m[5]}:${m[6]}` : '') : null;
}

// ---- storage ----
const openDb = storage.open;                 // persistent catalog + migrations

// Every file the walk can see, and how deep it looks. A cap of 20,000 stopped real archives
// part way; this one exists only so a runaway walk cannot exhaust memory.
const SCAN_CAP = 500000, SCAN_DEPTH = 24;

// The walk, the drive marker and the volume row: what both passes need, done once.
function walkRoot(db, root, opts) {
  const now = new Date().toISOString();
  const walk = {};
  const files = walkTree(root, [], 0, opts.cap || SCAN_CAP, SCAN_DEPTH, walk);
  const marker = opts.writeMarker === false ? { id: null }
                 : storage.volumeMarker(root, { consent: opts.consent, treatAsVolume: opts.treatAsVolume });
  let volumeId = null;
  if (marker.id) {
    db.prepare(`insert into volume(marker_id,label,first_seen_at,last_seen_at) values(?,?,?,?)
                on conflict(marker_id) do update set last_seen_at = excluded.last_seen_at`)
      .run(marker.id, path.basename(root), now, now);
    volumeId = db.prepare('select id from volume where marker_id = ?').get(marker.id).id;
    db.exec('begin immediate');
    try { storage.claimRoot(db, volumeId, toPortable(root)); db.exec('commit'); }
    catch (e) { db.exec('rollback'); throw e; }
  }
  return { root, portableRoot: toPortable(root), files, walk, volumeId, now, cap: opts.cap || SCAN_CAP };
}

const stmtCache = new WeakMap();
function stmts(db) {
  let q = stmtCache.get(db);
  if (q) return q;
  stmtCache.set(db, q = {
    findLoc: db.prepare(`select l.id, l.asset_id, l.size, l.mtime, l.state, a.provisional
                         from location l left join asset a on a.id = l.asset_id where l.root = ? and l.rel_path = ?`),
    touchLoc: db.prepare('update location set last_seen_at = ?, state = ? where id = ?'),
    insAsset: db.prepare(`insert into asset(content_key,kind,container,brand,duration_s,width,height,
        shot_at,shot_at_local,camera,lens,gps,gps_lat,gps_lon,iso,fnumber,focal_mm,
        sample_rate,channels,title,artist,description,size,first_seen_at,last_indexed_at,provisional,dated_by)
        values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        on conflict(content_key) do update set last_indexed_at = excluded.last_indexed_at`),
    getAsset: db.prepare('select id from asset where content_key = ?'),
    insLoc: db.prepare(`insert into location(asset_id,volume_id,root,rel_path,filename,state,size,mtime,first_seen_at,last_seen_at)
        values(?,?,?,?,?,?,?,?,?,?)
        on conflict(root,rel_path) do update set asset_id=excluded.asset_id, state=excluded.state,
          volume_id=coalesce(excluded.volume_id, location.volume_id),
          size=excluded.size, mtime=excluded.mtime, last_seen_at=excluded.last_seen_at`),
    delAnn: db.prepare("delete from annotation where asset_id = ? and source in ('folder','filename')"),
    insAnn: db.prepare('insert into annotation(asset_id,key,value,source,created_at) values(?,?,?,?,?)'),
  });
  return q;
}

// One asset row from whatever is known. Provisional ones are keyed by where they were seen.
function putAsset(db, key, x, now, provisional) {
  const q = stmts(db);
  q.insAsset.run(key, x.kind || null, x.container || null, x.brand || null,
    x.duration_s ?? null, x.width ?? null, x.height ?? null, x.shot_at ?? null, x.shot_at_local ?? null,
    x.camera ?? null, x.lens ?? null, x.gps ?? null, x.gps_lat ?? null, x.gps_lon ?? null,
    x.iso ?? null, x.fnumber ?? null, x.focal_mm ?? null, x.sample_rate ?? null, x.channels ?? null,
    x.title ?? null, x.artist ?? null, x.description ?? null, x.size ?? null, now, now,
    provisional ? 1 : 0, x.dated_by ?? null);
  return q.getAsset.get(key).id;
}
// A provisional asset becomes the real one in place. A date Photos gave it outranks one the
// file only implies by its name or timestamp.
function promote(db, id, x, now) {
  const old = db.prepare('select * from asset where id = ?').get(id);
  const d = storage.rankOf(old) < storage.rankOf(x) ? old : x;
  db.prepare(`update asset set content_key=?, kind=?, container=?, brand=?, duration_s=?, width=?, height=?,
      shot_at=?, shot_at_local=?, dated_by=?, camera=?, lens=?, gps=?, gps_lat=?, gps_lon=?, iso=?, fnumber=?,
      focal_mm=?, sample_rate=?, channels=?, title=?, artist=?, description=?, size=?, last_indexed_at=?,
      provisional=0 where id=?`).run(x.content_key, x.kind || old.kind, x.container || null, x.brand || null,
    x.duration_s ?? old.duration_s, x.width ?? old.width, x.height ?? old.height,
    d.shot_at ?? null, d.shot_at_local ?? null, d.dated_by ?? null, x.camera ?? old.camera, x.lens ?? null,
    x.gps ?? old.gps, x.gps_lat ?? old.gps_lat, x.gps_lon ?? old.gps_lon, x.iso ?? null, x.fnumber ?? null,
    x.focal_mm ?? null, x.sample_rate ?? null, x.channels ?? null, x.title ?? null, x.artist ?? null,
    x.description ?? null, x.size ?? old.size, now, id);
}
function tagFromPath(db, id, file, root, now) {
  const q = stmts(db);
  q.delAnn.run(id);
  for (const t of tier1(file, root)) q.insAnn.run(id, t.key, t.value, t.source, now);
}

// Commit at least once a second and every `every` files, so progress is visible, a crash
// loses seconds rather than hours, and a caption written meanwhile never waits long.
function batcher(db, every, tick) {
  let since = 0, last = Date.now();
  return r => {
    if (++since >= every || Date.now() - last > 1000) {
      since = 0; last = Date.now();
      db.exec('commit'); if (tick) tick(r); db.exec('begin immediate');
    }
  };
}

// Pass one: list every file nobody has listed yet, by name, folder and a best-guess date, at
// the cost of a stat. Search works on all of it at once; reading the files follows. The first
// full read of a real archive took 1h42m, and nothing was findable until a file's turn came.
// Online-only placeholders are listed the same way and are never read at all.
function inventory(db, root, opts = {}) {
  const ctx = walkRoot(db, root, opts);
  const q = stmts(db), r = { listed: 0 };
  const commit = batcher(db, opts.progressEvery || 500, opts.onProgress);
  db.exec('begin immediate');
  try {
    for (const f of ctx.files) {
      const rel = toPortable(path.relative(root, f.p));
      const prev = q.findLoc.get(ctx.portableRoot, rel);
      if (prev && prev.asset_id != null) continue;
      const name = path.basename(f.p);
      const x = fallbackDate({ kind: KIND(path.extname(name).toLowerCase()), size: f.size }, name, f.mtime);
      const id = putAsset(db, `list:${ctx.portableRoot}/${rel}`, x, ctx.now, true);
      q.insLoc.run(id, ctx.volumeId, ctx.portableRoot, rel, name, exif.isDataless(f) ? 'dematerialised' : 'present',
                   f.size, f.mtime, ctx.now, ctx.now);
      tagFromPath(db, id, f.p, root, ctx.now);
      storage.reindex(db, id);
      r.listed++;
      commit(r);
    }
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  return { ...ctx, listed: r.listed };
}

// Pass two: read what pass one listed, and anything that changed. Incremental by design: a
// file whose size and mtime are unchanged is never re-opened, re-hashed or re-parsed, so a
// rescan of a whole machine takes seconds.
function scan(db, root, opts = {}) {
  const ctx = opts.listed || inventory(db, root, opts);
  const { files, walk, volumeId, now, portableRoot } = ctx;
  const q = stmts(db);
  const r = { found: files.length, listed: ctx.listed, indexed: 0, unchanged: 0, placeholders: 0,
              failed: 0, meta_bytes: 0 };
  const commit = batcher(db, opts.progressEvery || 200, opts.onProgress);
  const seen = new Set();
  db.exec('begin immediate');
  try {
    for (const f of files) {
      const rel = toPortable(path.relative(root, f.p));
      seen.add(rel);
      const prev = q.findLoc.get(portableRoot, rel);
      const same = prev && prev.asset_id != null && prev.size === f.size && Math.abs((prev.mtime || 0) - f.mtime) < 1000;
      if (same && prev.state === 'present' && !prev.provisional) {
        q.touchLoc.run(now, 'present', prev.id); r.unchanged++; continue;      // untouched: skip entirely
      }
      // Still online-only: a stat said so, and reading it would download it.
      if (same && exif.isDataless(f)) { q.touchLoc.run(now, 'dematerialised', prev.id); r.placeholders++; continue; }

      // A file that cannot be read is still there: it stays listed, and is tried again next scan.
      let x; try { x = extract(f.p); }
      catch { r.failed++; if (prev) q.touchLoc.run(now, prev.state === 'dematerialised' ? 'dematerialised' : 'present', prev.id); continue; }
      if (x.dematerialised) {
        // Listed but never read, never hashed. Kept on its provisional asset, so it is findable.
        if (prev) q.touchLoc.run(now, 'dematerialised', prev.id);
        r.placeholders++; continue;
      }
      x.shot_at_local = normDate(x.shot_at_local);
      x = fallbackDate(x, path.basename(f.p), f.mtime);
      r.meta_bytes += x.meta_bytes || 0;

      // What was known before the file was read becomes what it turned out to be. Its id is kept
      // when nothing else has those bytes, because the agent may already be holding it.
      let id;
      if (prev?.provisional && !q.getAsset.get(x.content_key)) promote(db, (id = prev.asset_id), x, now);
      else {
        id = putAsset(db, x.content_key, x, now, false);
        if (prev?.provisional) storage.adopt(db, prev.asset_id, id);
      }
      q.insLoc.run(id, volumeId, portableRoot, rel, path.basename(f.p), 'present', f.size, f.mtime, now, now);
      // Machine-derived tags are rebuilt each time; human ones are never touched.
      tagFromPath(db, id, f.p, root, now);
      storage.reindex(db, id);
      r.indexed++;
      commit(r);
    }

    r.dated = dateUndated(db, portableRoot);
    // A walk cut short never saw the rest, so it cannot say which originals are in iCloud.
    r.photos = 0;
    if (!walk.capped) for (const lib of walk.libraries || []) r.photos += syncPhotos(db, ctx, lib, seen);

    // The index never forgets: vanished files are marked, never deleted. A walk cut short
    // by the cap never saw the rest, so it cannot say what has vanished.
    r.capped = !!walk.capped; r.too_deep = walk.deep || 0;
    r.missing = r.capped ? 0 : db.prepare(`update location set state = 'missing'
                            where root = ? and last_seen_at < ? and state != 'missing'`)
                  .run(portableRoot, now).changes;
    storage.noteScanLimits(db, portableRoot, r.capped || r.too_deep
      ? { cap: ctx.cap, depth: SCAN_DEPTH, found: r.found, too_deep: r.too_deep, capped: r.capped, at: now } : null);
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  return r;
}

// Files indexed before dates were guessed are unchanged, so they are never read again. Date
// them from what the catalog already holds. Once done, this finds nothing.
function dateUndated(db, portableRoot) {
  const rows = db.prepare(`select a.id, l.filename, l.mtime from asset a join location l on l.asset_id = a.id
                           where l.root = ? and l.mtime is not null and a.shot_at is null and a.shot_at_local is null
                           group by a.id`).all(portableRoot);
  const set = db.prepare('update asset set shot_at = ?, shot_at_local = ?, dated_by = ? where id = ?');
  let n = 0;
  for (const row of rows) {
    const d = fallbackDate({}, row.filename, row.mtime);
    if (!d.dated_by) continue;
    set.run(d.shot_at, d.shot_at_local, d.dated_by, row.id); storage.reindex(db, row.id); n++;
  }
  return n;
}

// Everything Photos lists in a library, against what the walk found on disk.
//   on disk          → gains the original name, and the date, place and camera if it had none
//   only in iCloud   → stays known, or becomes known from Photos' own record
//   trashed, or gone → untouched here, so the missing pass marks it
// "Optimise Mac Storage" deletes local originals that are safe in iCloud, and half a real
// library had never been on the Mac at all. Re-decided every scan, so a photo deleted in
// Photos goes back to missing. Writes only what differs, so an unchanged library costs reads.
function syncPhotos(db, ctx, libPath, seen) {
  const records = photos.libraryRecords(libPath);
  if (!records.length) return 0;
  const q = stmts(db), libRel = toPortable(path.relative(ctx.root, libPath));
  const under = libRel ? libRel + '/originals/' : 'originals/';
  const hasName = db.prepare("select 1 from annotation where asset_id = ? and key = 'original_name' and value = ?");
  const asset = db.prepare(`select id, camera, gps, ${storage.dateRank('asset')} rank from asset where id = ?`);
  const fill = db.prepare(`update asset set camera = coalesce(camera, ?), gps = coalesce(gps, ?),
      gps_lat = coalesce(gps_lat, ?), gps_lon = coalesce(gps_lon, ?),
      shot_at = case when ? then ? else shot_at end, shot_at_local = case when ? then ? else shot_at_local end,
      dated_by = case when ? then 'photos' else dated_by end where id = ?`);
  // Gains the original name, and the date, place and camera if the file did not say.
  const enrich = (assetId, p, gps) => {
    const a = asset.get(assetId);
    if (!a) return;
    let changed = false;
    if (p.original && !hasName.get(a.id, p.original)) {
      q.insAnn.run(a.id, 'original_name', p.original, 'photos', ctx.now); changed = true;
    }
    const redate = p.shot_at_local && a.rank > 1 ? 1 : 0;
    if (redate || (!a.camera && p.camera) || (!a.gps && gps)) {
      fill.run(p.camera, gps, p.gps_lat, p.gps_lon, redate, p.shot_at, redate, p.shot_at_local, redate, a.id);
      changed = true;
    }
    if (changed) storage.reindex(db, a.id);
  };
  let added = 0;
  for (const p of records) {
    const rel = under + p.key;
    const gps = p.gps_lat != null ? `${p.gps_lat},${p.gps_lon}` : null;
    const onDisk = seen.has(rel);
    if (!onDisk && !p.inCloud) continue;
    const loc = q.findLoc.get(ctx.portableRoot, rel);
    if (loc?.asset_id != null) {
      if (!onDisk) q.touchLoc.run(ctx.now, 'dematerialised', loc.id);
      enrich(loc.asset_id, p, gps);
      continue;
    }
    if (onDisk) continue;
    const id = putAsset(db, 'photos:' + (p.uuid || libRel + '/' + p.key),
      { ...p, kind: p.kind || KIND(path.extname(p.key).toLowerCase()), gps, size: null,
        dated_by: p.shot_at_local ? 'photos' : null }, ctx.now, true);
    q.insLoc.run(id, ctx.volumeId, ctx.portableRoot, rel, path.basename(p.key), 'dematerialised',
                 null, null, ctx.now, ctx.now);
    tagFromPath(db, id, path.join(ctx.root, fromPortable(rel)), ctx.root, ctx.now);
    if (p.original && !hasName.get(id, p.original)) q.insAnn.run(id, 'original_name', p.original, 'photos', ctx.now);
    storage.reindex(db, id);
    added++;
  }
  return added;
}

function search(db, q, limit = 10) {
  const rows = db.prepare(`
    select a.id, l.filename, l.rel_path, a.duration_s, a.shot_at, a.width, a.height, a.camera
    from search s join asset a on a.id = s.asset_id
    join location l on l.asset_id = a.id
    where search match ? order by rank limit ?`).all(q.normalize('NFC'), limit);
  return rows;
}

module.exports = { walkTree, extract, contentKey, tier1, openDb, inventory, scan, search, storage, normDate,
                   dateFromName, volumeRoots, toPortable, fromPortable, SCAN_CAP, SCAN_DEPTH,
                   VIDEO, AUDIO, MEDIA, KIND, IMAGE: exif.IMAGE, DESIGN: exif.DESIGN };
