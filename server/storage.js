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
];

function open(file = catalogPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma synchronous = normal;');
  db.exec('create table if not exists schema_version(v integer primary key, applied_at text)');

  const applied = new Set(db.prepare('select v from schema_version').all().map(r => r.v));
  for (const m of MIGRATIONS) {
    if (applied.has(m.v)) continue;
    db.exec('begin');
    try {
      db.exec(m.sql);
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
  // Only ever mark an actual volume, and only with permission.
  if (!isMountPoint(root)) return { id: null, skipped: 'not-a-volume' };
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

module.exports = { dataDir, catalogPath, open, version, MIGRATIONS, installId, resetInstallId, volumeMarker, isMountPoint };
