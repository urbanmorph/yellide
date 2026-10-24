// Yellide — persistent storage and schema migrations.
//
// Until now the index lived in a temp file and was deleted after every call, so nothing
// accumulated and nothing could be tested over days. This is the real catalog.
//
// Migrations ship from v1 with zero users, which is the only cheap moment to add them.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

// OS-appropriate application data directory. Never a hardcoded ~/.yellide.
function dataDir() {
  if (process.env.YELLIDE_HOME) return process.env.YELLIDE_HOME;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'yellide');
  if (process.platform === 'win32')  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'yellide');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'yellide');
}
const catalogPath = () => path.join(dataDir(), 'catalog.db');

// Ordered, append-only. Never edit a shipped migration — add another.
const MIGRATIONS = [
  { v: 1, name: 'initial', sql: `
    create table volume(
      id integer primary key,
      marker_id text unique,            -- the .yellide/volume-id we wrote; survives renaming
      label text, kind text,
      first_seen_at text, last_seen_at text);

    create table asset(
      id integer primary key,
      content_key text unique not null,
      kind text,                        -- video | audio | image | design
      container text, brand text,
      duration_s real, width integer, height integer,
      shot_at text,                     -- UTC where known
      shot_at_local text,               -- wall-clock from the camera/EXIF/BWF block
      camera text, lens text,
      gps text, gps_lat real, gps_lon real,
      iso integer, fnumber real, focal_mm real,
      sample_rate integer, channels integer,
      title text, artist text, description text,
      size integer, meta_json text,
      first_seen_at text, last_indexed_at text);

    create table location(
      id integer primary key,
      asset_id integer references asset(id) on delete cascade,
      volume_id integer references volume(id),
      root text not null,
      rel_path text not null,           -- POSIX separators, NFC
      filename text not null,
      state text not null default 'present',   -- present | missing | offline | dematerialised
      size integer, mtime real,         -- so a rescan can skip unchanged files
      first_seen_at text, last_seen_at text,
      unique(root, rel_path));

    create table asset_link(
      a integer references asset(id) on delete cascade,
      b integer references asset(id) on delete cascade,
      relation text not null,           -- proxy_of | export_of | same_content | multitrack_of | segment_of
      confidence real, source text,
      primary key (a, b, relation));

    create table annotation(
      id integer primary key,
      asset_id integer references asset(id) on delete cascade,
      start_s real, end_s real,
      key text not null, value text not null,
      source text not null,             -- probe|folder|filename|compute|model|agent|human
      confidence real,
      created_at text, confirmed_at text);

    create table scan_job(
      id integer primary key,
      root text not null, state text not null,   -- running | done | failed | cancelled
      found integer default 0, indexed integer default 0, skipped integer default 0,
      started_at text, finished_at text, error text);

    create virtual table search using fts5(
      body, asset_id unindexed, tokenize='unicode61');

    create index location_asset on location(asset_id);
    create index location_state on location(state);
    create index asset_shot_at on asset(shot_at);
    create index asset_kind on asset(kind);
    create index annotation_asset on annotation(asset_id, key);
  `},
  { v: 2, name: 'install identity', sql: `
    create table meta(k text primary key, v text);
  `},
  { v: 3, name: 'english-stemmed sibling index', sql: `
    create virtual table search_en using fts5(
      body, asset_id unindexed, tokenize='porter unicode61');
  `},
  // asset_id is an unindexed FTS column, so replacing a row by it scanned the whole table:
  // 5.6 ms a file on a 21,000-file catalog. Key each row by its asset instead. The latest
  // row per asset survives, the way the last write always won.
  { v: 4, name: 'search rows keyed by asset', sql: ['search', 'search_en'].map(t => `
    create temp table keep as select asset_id a, body b from ${t}
      where rowid in (select max(rowid) from ${t} where asset_id is not null group by asset_id);
    delete from ${t};
    insert into ${t}(rowid, body, asset_id) select a, b, a from keep;
    drop table keep;`).join('\n'),
    // Rescans skip unchanged files, so rows older versions left out of search_en, or rebuilt
    // without their captions after a rename, are repaired here or never.
    run: db => { for (const { id } of db.prepare('select id from asset').all()) reindex(db, id); } },
  // A provisional asset is known before its bytes are read: listed by a scan's first pass, an
  // online-only placeholder, or a photo that exists only in iCloud. Its key names where it was
  // seen, not what it is, and it is merged into the real asset once the file is read.
  // dated_by says where a date came from when the file itself had none: photos | filename | file.
  { v: 5, name: 'provisional assets and date sources', sql: `
    alter table asset add column provisional integer not null default 0;
    alter table asset add column dated_by text;
    alter table scan_job add column pid integer;
    create index asset_provisional on asset(provisional) where provisional = 1;` },
];

function open(file = catalogPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  // The scan worker and the tool calls are two writers on one file. Without a timeout a
  // caption written mid-scan failed at once with "database is locked" and was lost.
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma synchronous = normal; ' +
          'pragma busy_timeout = 15000;');
  db.exec('create table if not exists schema_version(v integer primary key, applied_at text)');

  const applied = new Set(db.prepare('select v from schema_version').all().map(r => r.v));
  for (const m of MIGRATIONS) {
    if (applied.has(m.v)) continue;
    db.exec('begin immediate');
    try {
      db.exec(m.sql);
      if (m.run) m.run(db);
      db.prepare('insert into schema_version(v, applied_at) values(?,?)').run(m.v, new Date().toISOString());
      db.exec('commit');
    } catch (e) {
      db.exec('rollback');
      throw new Error(`migration ${m.v} (${m.name}) failed: ${e.message}`);
    }
  }
  return db;
}

const version = db => db.prepare('select max(v) v from schema_version').get().v;

// The one place a search row is built, by scan and by every write of a tag or caption.
// It reads everything known about the asset, so a rescan can never drop a caption, and it
// writes both indexes, so the stemmed one covers files nobody has described yet.
// Every location contributes its words: a renamed file is found by either name, and the
// same footage on two drives by either folder.
const stmts = new WeakMap();
function reindex(db, assetId) {
  let q = stmts.get(db);
  if (!q) stmts.set(db, q = {
    asset: db.prepare('select * from asset where id = ?'),
    locs: db.prepare('select distinct filename, rel_path from location where asset_id = ?'),
    priv: db.prepare("select 1 p from annotation where asset_id = ? and key = 'private'"),
    tags: db.prepare('select value from annotation where asset_id = ?'),
    write: ['search', 'search_en'].map(t => [
      db.prepare(`delete from ${t} where rowid = ?`),
      db.prepare(`insert into ${t}(rowid, body, asset_id) values(?,?,?)`)]),
  });
  const a = q.asset.get(assetId);
  if (!a) return;
  // Anything marked private is indexed by type only, never by its contents.
  const tags = q.priv.get(assetId) ? ['private document'] : q.tags.all(assetId).map(r => r.value);
  const words = q.locs.all(assetId).flatMap(l => [l.filename, l.rel_path.split('/').join(' ')]);
  const body = [...new Set(words), a.camera, a.lens, a.kind, a.brand, a.title, a.artist, a.description,
                (a.shot_at_local || a.shot_at || '').slice(0, 10), ...tags]
               .filter(Boolean).join(' ').normalize('NFC');
  for (const [del, ins] of q.write) { del.run(assetId); ins.run(assetId, body, assetId); }
}

// Where a date came from, best first: the file's own metadata, Photos, the filename, the file's
// timestamp. No date at all ranks last.
const dateRank = t => `(case when coalesce(${t}.shot_at_local, ${t}.shot_at) is null then 9
  else case ${t}.dated_by when 'photos' then 1 when 'filename' then 2 when 'file' then 3 else 0 end end)`;

// The same order in plain JS, for a row already read.
const rankOf = a => !(a.shot_at || a.shot_at_local) ? 9 : ({ photos: 1, filename: 2, file: 3 }[a.dated_by] ?? 0);

// Fold a provisional asset into the real one its file turned out to be. Everything a person or
// the agent wrote moves across, and what Photos knew fills what the file did not say.
// Locations move before the delete, which would otherwise cascade to them.
const adoptStmts = new WeakMap();
function adopt(db, fromId, toId) {
  if (fromId == null || fromId === toId) return;
  let q = adoptStmts.get(db);
  if (!q) {
    const take = `${dateRank('p')} < ${dateRank('asset')}`;
    adoptStmts.set(db, q = [
      db.prepare(`update annotation set asset_id = ? where asset_id = ? and source not in ('folder','filename')
                  and not exists (select 1 from annotation b where b.asset_id = ? and b.key = annotation.key
                                  and b.value = annotation.value)`),
      db.prepare('update location set asset_id = ? where asset_id = ?'),
      db.prepare(`update asset set
          shot_at = case when ${take} then p.shot_at else asset.shot_at end,
          shot_at_local = case when ${take} then p.shot_at_local else asset.shot_at_local end,
          dated_by = case when ${take} then p.dated_by else asset.dated_by end,
          camera = coalesce(asset.camera, p.camera), duration_s = coalesce(asset.duration_s, p.duration_s),
          gps = coalesce(asset.gps, p.gps), gps_lat = coalesce(asset.gps_lat, p.gps_lat),
          gps_lon = coalesce(asset.gps_lon, p.gps_lon)
        from (select * from asset where id = ?) p where asset.id = ?`),
      ...['search', 'search_en'].map(t => db.prepare(`delete from ${t} where rowid = ?`)),
      db.prepare('delete from asset where id = ? and provisional = 1'),
    ]);
  }
  const [anns, locs, fill, delFts, delFtsEn, del] = q;
  anns.run(toId, fromId, toId);
  locs.run(toId, fromId);
  fill.run(fromId, toId);
  delFts.run(fromId); delFtsEn.run(fromId);
  del.run(fromId);
  reindex(db, toId);
}

// A drive is its marker, not its name. Entries are stored under the path the drive is mounted
// at, so when a marker turns up at a path:
//   - another drive's entries already there (two cards both called EOS_DIGITAL) are parked
//     under that path plus "#" and their marker, a path that never exists, so they read as
//     not plugged in rather than gone, and are never overwritten by the second card's files;
//   - this drive's entries under any other path (it was renamed, or was parked) come here.
const PARK = /#[0-9a-f]{8}$/;
const unpark = root => String(root || '').replace(PARK, '');
function claimRoot(db, volumeId, root) {
  const others = db.prepare(`select distinct l.volume_id id, v.marker_id m from location l
                             join volume v on v.id = l.volume_id where l.root = ? and l.volume_id != ?`).all(root, volumeId);
  const park = db.prepare('update location set root = ? where root = ? and volume_id = ?');
  for (const o of others) park.run(`${root}#${String(o.m).replace(/-/g, '').slice(0, 8).toLowerCase()}`, root, o.id);
  // Entries made here before the drive was marked give way to the marked ones they duplicate.
  db.prepare(`delete from location where root = ? and volume_id is null and rel_path in
              (select rel_path from location where volume_id = ? and root != ?)`).run(root, volumeId, root);
  db.prepare('update or ignore location set root = ? where volume_id = ? and root != ?').run(root, volumeId, root);
  db.prepare('delete from location where volume_id = ? and root != ?').run(volumeId, root);
  db.prepare('update volume set label = ? where id = ?').run(path.basename(root), volumeId);
}

// Which roots the last scan could not walk completely: { root: {cap, found, capped, too_deep, at} }.
// A root that scans completely is removed, so the warning lasts only while it is true.
const scanLimits = db => {
  try { return JSON.parse(db.prepare("select v from meta where k = 'scan_limits'").get()?.v || '{}'); }
  catch { return {}; }
};
function noteScanLimits(db, root, limit) {
  const all = scanLimits(db);
  if (limit) all[root] = limit; else if (root in all) delete all[root]; else return;
  db.prepare(`insert into meta(k, v) values('scan_limits', ?)
              on conflict(k) do update set v = excluded.v`).run(JSON.stringify(all));
}

// A random id, generated once, resettable. It identifies an install, never a person,
// and exists only so retention can be told apart from new installs.
function installId(db) {
  const row = db.prepare("select v from meta where k = 'install_id'").get();
  if (row) return row.v;
  const id = crypto.randomUUID();
  db.prepare('insert into meta(k,v) values(?,?)').run('install_id', id);
  return id;
}
function resetInstallId(db) {
  const id = crypto.randomUUID();
  db.prepare('insert into meta(k,v) values(?,?) on conflict(k) do update set v = excluded.v')
    .run('install_id', id);
  return id;
}

// Volume identity: a marker we write, not an OS UUID. Cross-platform, survives renaming.
function isMountPoint(p) {
  try {
    if (process.platform === 'win32') return /^[A-Za-z]:[\\/]?$/.test(p);
    const parent = path.dirname(p);
    if (parent === p) return true;
    return fs.statSync(p).dev !== fs.statSync(parent).dev;
  } catch { return false; }
}

function volumeMarker(root, opts = {}) {
  // Only ever mark an actual volume, and only with permission. Tests stand a folder in for one.
  if (!opts.treatAsVolume && !isMountPoint(root)) return { id: null, skipped: 'not-a-volume' };
  if (opts.consent === false) return { id: null, skipped: 'declined' };
  const dir = path.join(root, '.yellide');
  const file = path.join(dir, 'volume-id');
  try {
    if (fs.existsSync(file)) return { id: fs.readFileSync(file, 'utf8').trim(), created: false };
  } catch {}
  try {
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomUUID();
    fs.writeFileSync(file, id + '\n');
    return { id, created: true };
  } catch (e) {
    // Read-only drive, or the user declined. Fall back to catalog-only tracking.
    return { id: null, created: false, error: e.code };
  }
}

module.exports = { dataDir, catalogPath, open, version, MIGRATIONS, installId, resetInstallId, volumeMarker, isMountPoint,
                   scanLimits, noteScanLimits, reindex, adopt, dateRank, rankOf, claimRoot, unpark };
