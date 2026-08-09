// Yellide core — the entire release-one loop, as one dependency-free module.
// scan → identity → Tier 0 container metadata → SQLite → FTS5 → query.
// Used by both the CLI test and the MCP server, so what runs here runs there.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const exif = require('./exif.js');
const audio = require('./audio.js');
const storage = require('./storage.js');

// A "video index" would miss a terabyte of podcast recordings entirely. Media, not video.
const VIDEO = new Set(['.mp4','.mov','.m4v','.mxf','.avi','.mkv','.mts','.m2ts','.braw','.r3d','.ari','.insv','.lrv','.webm']);
const AUDIO = new Set(['.wav','.aif','.aiff','.mp3','.m4a','.flac','.aac','.ogg','.opus','.caf','.wma']);
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

function walkTree(dir, out, depth = 0, cap = 5000, maxDepth = 8) {
  if (depth > maxDepth || out.length >= cap) return out;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  // Never skip the root the user pointed at — only subtrees discovered on the way down.
  if (depth > 0 && ents.some(e => e.isFile() && PROJECT_MARKER.has(e.name))) return out;
  for (const e of ents) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP.test(e.name) || PKG_DIR.test(e.name)) continue;
      if (MEDIA_LIBRARY.test(e.name)) { walkLibrary(p, out, cap); continue; }
      walkTree(p, out, depth + 1, cap, maxDepth);
    }
    else if (MEDIA.has(path.extname(e.name).toLowerCase())) {
      try { const st = fs.statSync(p); out.push({ p, size: st.size, mtime: st.mtimeMs, blocks: st.blocks }); } catch {}
    }
  }
  return out;
}

// Inside a Photos/iMovie/FCP library: find the originals, ignore everything else.
function walkLibrary(lib, out, cap) {
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
  for (const r of roots) walkTree(r, out, 0, cap, 6);
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
  if (kind === 'audio' && ext !== '.m4a' && ext !== '.aac' && ext !== '.caf') {
    const r = audio.extractAudio(file, kind);
    return { ...r, content_key: r.dematerialised ? null : contentKey(file) };
  }
  if (kind === 'image' || kind === 'design') {
    const r = kind === 'image' ? exif.extractImage(file) : exif.extractDesign(file);
    // Never hash a placeholder either — hashing reads the first and last megabyte.
    return { ...r, content_key: r.dematerialised ? null : contentKey(file) };
  }
  return extractIsoBmff(file, kind);
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

function extractIsoBmff(file, kind) {
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
    const MB = 1 << 20, h = crypto.createHash('sha256');
    const a = Buffer.alloc(Math.min(MB, st.size)); fs.readSync(fd, a, 0, a.length, 0); h.update(a);
    if (st.size > MB) { const b2 = Buffer.alloc(MB); fs.readSync(fd, b2, 0, MB, st.size - MB); h.update(b2); }
    h.update(String(st.size));
    r.camera = pickCamera(r.camera_parts);
    delete r.camera_parts;
    r.content_key = h.digest('hex');
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

// Camera blocks use colons in the date part. Normalise so ordering and display both work.
function normDate(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` + (m[4] ? ` ${m[4]}:${m[5]}:${m[6]}` : '') : null;
}

// ---- storage ----
const openDb = storage.open;                 // persistent catalog + migrations

// Incremental by design: a file whose size and mtime are unchanged is never re-opened,
// never re-hashed, never re-parsed. The first full scan of a real machine took 1h42m;
// the second must take seconds or nobody will ever rescan.
function scan(db, root, opts = {}) {
  const cap = opts.cap || 20000;
  const now = new Date().toISOString();
  const files = walkTree(root, [], 0, cap);
  const portableRoot = toPortable(root);

  const marker = opts.writeMarker === false ? { id: null }
                 : storage.volumeMarker(root, { consent: opts.consent });
  let volumeId = null;
  if (marker.id) {
    db.prepare(`insert into volume(marker_id,label,first_seen_at,last_seen_at) values(?,?,?,?)
                on conflict(marker_id) do update set last_seen_at = excluded.last_seen_at`)
      .run(marker.id, path.basename(root), now, now);
    volumeId = db.prepare('select id from volume where marker_id = ?').get(marker.id).id;
  }

  const findLoc = db.prepare('select id, asset_id, size, mtime, state from location where root = ? and rel_path = ?');
  const touchLoc = db.prepare('update location set last_seen_at = ?, state = ? where id = ?');
  const insAsset = db.prepare(`insert into asset(content_key,kind,container,brand,duration_s,width,height,
      shot_at,shot_at_local,camera,lens,gps,gps_lat,gps_lon,iso,fnumber,focal_mm,
      sample_rate,channels,title,artist,description,size,first_seen_at,last_indexed_at)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(content_key) do update set last_indexed_at = excluded.last_indexed_at`);
  const getAsset = db.prepare('select id from asset where content_key = ?');
  const insLoc = db.prepare(`insert into location(asset_id,volume_id,root,rel_path,filename,state,size,mtime,first_seen_at,last_seen_at)
      values(?,?,?,?,?,?,?,?,?,?)
      on conflict(root,rel_path) do update set asset_id=excluded.asset_id, state=excluded.state,
        size=excluded.size, mtime=excluded.mtime, last_seen_at=excluded.last_seen_at`);
  const delAnn = db.prepare("delete from annotation where asset_id = ? and source in ('folder','filename')");
  const insAnn = db.prepare('insert into annotation(asset_id,key,value,source,created_at) values(?,?,?,?,?)');
  const delFts = db.prepare('delete from search where asset_id = ?');
  const insFts = db.prepare('insert into search(body, asset_id) values(?,?)');

  const r = { found: files.length, indexed: 0, unchanged: 0, placeholders: 0, failed: 0, meta_bytes: 0 };
  const tick = opts.onProgress, every = opts.progressEvery || 200;
  let sinceTick = 0;
  db.exec('begin');
  try {
    for (const f of files) {
      const rel = toPortable(path.relative(root, f.p));
      const prev = findLoc.get(portableRoot, rel);
      if (prev && prev.size === f.size && Math.abs((prev.mtime || 0) - f.mtime) < 1000 && prev.state === 'present') {
        touchLoc.run(now, 'present', prev.id); r.unchanged++; continue;      // untouched: skip entirely
      }

      let x; try { x = extract(f.p); } catch { r.failed++; continue; }
      x.shot_at_local = normDate(x.shot_at_local);
      if (x.dematerialised) {
        // Indexed at Tier 1 only, never read, never hashed.
        insLoc.run(null, volumeId, portableRoot, rel, path.basename(f.p), 'dematerialised', f.size, f.mtime, now, now);
        r.placeholders++; continue;
      }
      r.meta_bytes += x.meta_bytes || 0;

      insAsset.run(x.content_key, x.kind || null, x.container || null, x.brand || null,
        x.duration_s ?? null, x.width ?? null, x.height ?? null, x.shot_at ?? null, x.shot_at_local ?? null,
        x.camera ?? null, x.lens ?? null, x.gps ?? null, x.gps_lat ?? null, x.gps_lon ?? null,
        x.iso ?? null, x.fnumber ?? null, x.focal_mm ?? null, x.sample_rate ?? null, x.channels ?? null,
        x.title ?? null, x.artist ?? null, x.description ?? null, x.size ?? null, now, now);
      const id = getAsset.get(x.content_key).id;
      insLoc.run(id, volumeId, portableRoot, rel, path.basename(f.p), 'present', f.size, f.mtime, now, now);

      // Machine-derived tags are rebuilt each time; human ones are never touched.
      delAnn.run(id);
      const tags = tier1(f.p, root);
      for (const t of tags) insAnn.run(id, t.key, t.value, t.source, now);

      delFts.run(id);
      insFts.run([path.basename(f.p), rel.split('/').join(' '), x.camera, x.lens, x.kind, x.brand,
                  x.title, x.artist, x.description,
                  (x.shot_at_local || x.shot_at || '').slice(0, 10), ...tags.map(t => t.value)]
                 .filter(Boolean).join(' ').normalize('NFC'), id);
      r.indexed++;
      // Commit periodically so progress is visible and a crash loses seconds, not hours.
      if (tick && ++sinceTick >= every) {
        sinceTick = 0;
        db.exec('commit'); tick(r); db.exec('begin');
      }
    }

    // The index never forgets: vanished files are marked, never deleted.
    r.missing = db.prepare(`update location set state = 'missing'
                            where root = ? and last_seen_at < ? and state != 'missing'`)
                  .run(portableRoot, now).changes;
    db.exec('commit');
  } catch (e) { db.exec('rollback'); throw e; }
  return r;
}

function search(db, q, limit = 10) {
  const rows = db.prepare(`
    select a.id, l.filename, l.rel_path, a.duration_s, a.shot_at, a.width, a.height, a.camera
    from search s join asset a on a.id = s.asset_id
    join location l on l.asset_id = a.id
    where search match ? order by rank limit ?`).all(q.normalize('NFC'), limit);
  return rows;
}

module.exports = { walkTree, extract, contentKey, tier1, openDb, scan, search, storage, normDate, volumeRoots, toPortable, fromPortable, VIDEO, AUDIO, MEDIA, KIND, IMAGE: exif.IMAGE, DESIGN: exif.DESIGN };
