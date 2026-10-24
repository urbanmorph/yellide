// Album names from the macOS Photos library.
//
// Photos already holds words the user typed. On the machine this was written for, 21 albums
// carry real names: "Upanayanam", "Darjeeling 26th Tiger hill, Batasia loop, Rock garden",
// "world bicycle day". They cost nothing to read and they are what someone actually types
// into a search box. Nothing else in Photos is worth taking: of 696 caption rows, 8 held any
// text and all 8 were written by software, not by a person.
//
// These are TAGS, never captions. An album name says the occasion, not what is in the frame,
// so it must not move the caption coverage figure. A percentage that rises because of work
// nobody did is worse than one that stays honest and low.
//
// Read-only, always. Nothing is ever written back to the Photos library.

const fs = require('fs');
const os = require('os');
const path = require('path');
// The same name EXIF gives the camera, so a photo in iCloud joins the shoot of one on disk.
const { cameraName } = require('./exif.js');

/** The Photos database, if there is one. Libraries can be renamed, so look for the suffix. */
function findLibrary() {
  const pics = path.join(os.homedir(), 'Pictures');
  let names = [];
  try { names = fs.readdirSync(pics).filter(n => n.endsWith('.photoslibrary')); } catch { return null; }
  // The default name first, so a stray second library never wins over the real one.
  names.sort((a, b) => (b === 'Photos Library.photoslibrary') - (a === 'Photos Library.photoslibrary'));
  for (const n of names) {
    const p = path.join(pics, n, 'database', 'Photos.sqlite');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Albums named for the day they were made, in every dress Photos and its importers use.
const DATEY = [
  /\b(19|20)\d{2}\b/,                                   // any four-digit year, anywhere
  /^\d{1,2}[-_/ ](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i,
  /^\d{1,2}[-_/]\d{1,2}([-_/]\d{1,4})?$/,
];

// Albums named for where the files came from. A source is not a subject: 1,621 files sat
// under "WhatsApp", which says nothing about any of them.
const SOURCES = new Set(['whatsapp', 'instagram', 'facebook', 'telegram', 'signal', 'messenger',
  'screenshots', 'screenshot', 'pictures', 'photos', 'photos & videos', 'videos', 'images',
  'camera roll', 'camera uploads', 'downloads', 'imports', 'untitled album', 'new album',
  'insta360', 'gopro', 'dropbox', 'google photos', 'icloud', 'airdrop', 'favourites',
  'favorites', 'misc', 'miscellaneous', 'other', 'stuff', 'temp', 'test',
  // Editing and sharing apps name their own export albums. Seen on a real library: these put
  // 90 files under tags that say which app touched them and nothing about what they show.
  'originals', 'original', 'twitter', 'x', 'moldiv', 'retrica', 'boomerang', 'endomondo',
  'layout', 'snapseed', 'vsco', 'lightroom', 'adobe scan exports', 'shared', 'recents',
  'recently deleted', 'hidden', 'bursts', 'panoramas', 'slo-mo', 'time-lapse', 'live photos']);

/** Is this album name worth carrying into the index? */
function isDescriptive(name) {
  const t = String(name || '').trim();
  if (t.length < 3 || t.length > 120) return false;
  // Photos appends " (2)" when a name repeats. The counter must not rescue a name the filter
  // would otherwise throw away: "Pictures (1)" tagged 15 files with nothing.
  const bare = t.replace(/\s*\(\d+\)\s*$/, '').toLowerCase();
  if (SOURCES.has(bare)) return false;
  if (DATEY.some(re => re.test(t))) return false;
  if (!/[a-z]{3}/i.test(t)) return false;              // needs actual letters to be a word
  return true;
}

/**
 * The album-to-asset join table is numbered per schema version: Z_33ASSETS on one Mac,
 * Z_28ASSETS on another. Hardcoding it works once and then silently returns nothing, which
 * looks exactly like "you have no albums". Find it by shape instead.
 */
function joinTable(p) {
  const rows = p.prepare(
    "select name from sqlite_master where type='table' and name like 'Z\\_%ASSETS' escape '\\'").all();
  for (const { name } of rows) {
    const cols = p.prepare(`select name from pragma_table_info('${name}')`).all().map(c => c.name);
    const album = cols.find(c => /ALBUMS$/.test(c));
    const asset = cols.find(c => /ASSETS$/.test(c) && !/^Z_FOK/.test(c));
    if (album && asset) return { name, album, asset };
  }
  return null;
}

function openPhotos(photosDb) {
  const { DatabaseSync } = require('node:sqlite');
  // `immutable` matters: Photos keeps a write-ahead log, and a plain read-only open of a
  // library the Photos app currently has running fails while trying to recover it.
  try { return new DatabaseSync(`file:${photosDb}?immutable=1`, { readOnly: true, allowExtension: false }); }
  catch { return new DatabaseSync(photosDb, { readOnly: true }); }
}

const APPLE_EPOCH = 978307200;                    // 2001-01-01, which Photos counts from
const pad = n => String(n).padStart(2, '0');

/**
 * Every photo and video Photos lists and has not trashed, as "dir/file" under originals/ with
 * what Photos knows about it. Half of a real library, 12,000 photos, had never been on the
 * Mac at all, so no scan could see them, yet Photos holds their date, place, camera and
 * original name. Columns are read only where they exist; a library without the four that
 * say where a file is and whether it is safe gives nothing, so nothing is claimed on a guess.
 */
function libraryRecords(libraryDir) {
  const photosDb = path.join(libraryDir, 'database', 'Photos.sqlite');
  if (!fs.existsSync(photosDb)) return [];
  let p;
  try {
    p = openPhotos(photosDb);
    const colsOf = t => new Set(p.prepare(`select name from pragma_table_info('${t}')`).all().map(c => c.name));
    const a = colsOf('ZASSET'), x = colsOf('ZADDITIONALASSETATTRIBUTES'), e = colsOf('ZEXTENDEDATTRIBUTES');
    if (!['ZDIRECTORY', 'ZFILENAME', 'ZTRASHEDSTATE', 'ZCLOUDLOCALSTATE'].every(c => a.has(c))) return [];
    const col = (set, t, c) => set.has(c) ? `${t}.${c}` : 'null';
    const joinX = x.has('ZASSET') ? 'left join ZADDITIONALASSETATTRIBUTES x on x.ZASSET = a.Z_PK' : '';
    const joinE = e.has('ZASSET') ? 'left join ZEXTENDEDATTRIBUTES e on e.ZASSET = a.Z_PK' : '';
    const X = joinX ? x : new Set(), E = joinE ? e : new Set();
    const rows = p.prepare(`select a.ZDIRECTORY dir, a.ZFILENAME file, a.ZCLOUDLOCALSTATE cloud,
        ${col(a, 'a', 'ZUUID')} uuid, ${col(a, 'a', 'ZKIND')} kind, ${col(a, 'a', 'ZDATECREATED')} created,
        ${col(a, 'a', 'ZLATITUDE')} lat, ${col(a, 'a', 'ZLONGITUDE')} lon, ${col(a, 'a', 'ZDURATION')} duration,
        ${col(a, 'a', 'ZWIDTH')} width, ${col(a, 'a', 'ZHEIGHT')} height,
        ${col(X, 'x', 'ZORIGINALFILENAME')} original, ${col(X, 'x', 'ZTIMEZONEOFFSET')} tz,
        ${col(E, 'e', 'ZCAMERAMAKE')} make, ${col(E, 'e', 'ZCAMERAMODEL')} model
      from ZASSET a ${joinX} ${joinE}
      where a.ZTRASHEDSTATE = 0 and a.ZDIRECTORY is not null and a.ZFILENAME is not null`).all();
    return rows.map(r => {
      const out = { key: r.dir + '/' + r.file, uuid: r.uuid, inCloud: r.cloud === 1,
                    kind: r.kind === 1 ? 'video' : r.kind === 0 ? 'image' : null,
                    original: r.original || null, width: r.width || null, height: r.height || null,
                    duration_s: r.kind === 1 && r.duration > 0 ? +r.duration.toFixed(2) : null,
                    camera: cameraName(r.make, r.model), shot_at: null, shot_at_local: null,
                    gps_lat: null, gps_lon: null };
      if (r.created != null) {
        const t = (r.created + APPLE_EPOCH) * 1000;
        out.shot_at = new Date(t).toISOString();
        // Wall-clock where it was taken, which is what EXIF records and what shoots group by.
        const l = new Date(t + (r.tz || 0) * 1000);
        out.shot_at_local = `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())} ` +
                            `${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}:${pad(l.getUTCSeconds())}`;
      }
      // Photos writes -180 for "no location".
      if (r.lat != null && r.lon != null && r.lat >= -90 && r.lat <= 90 && r.lon > -180 && r.lon <= 180
          && !(r.lat === 0 && r.lon === 0)) {
        out.gps_lat = +r.lat.toFixed(6); out.gps_lon = +r.lon.toFixed(6);
      }
      return out;
    });
  } catch { return []; }
  finally { try { p?.close(); } catch {} }
}

/** [{ filename, album }] for every descriptive album, read-only. */
function readAlbums(photosDb) {
  const p = openPhotos(photosDb);
  try {
    const j = joinTable(p);
    if (!j) return [];
    const rows = p.prepare(`
      select a.ZFILENAME filename, g.ZTITLE album
      from ZGENERICALBUM g
      join ${j.name} z on z.${j.album} = g.Z_PK
      join ZASSET a on a.Z_PK = z.${j.asset}
      where g.ZKIND = 2 and trim(coalesce(g.ZTITLE,'')) != ''`).all();
    return rows.filter(r => r.filename && isDescriptive(r.album))
               .map(r => ({ filename: r.filename, album: String(r.album).trim() }));
  } finally { try { p.close(); } catch {} }
}

/** Write them as tags against whatever is actually on this machine. */
function importAlbums(db, opts = {}) {
  const photosDb = opts.photosDb || findLibrary();
  if (!photosDb || !fs.existsSync(photosDb)) {
    return { text: 'No Photos library found, so there are no album names to read. This only '
      + 'applies to the macOS Photos app.' };
  }
  let rows;
  try { rows = readAlbums(photosDb); }
  catch (e) { return { text: `Could not read the Photos library: ${e.message}` }; }
  if (!rows.length) {
    return { text: 'Your Photos albums are all named for dates or for the app the files came '
      + 'from, so there is nothing in them worth adding.' };
  }

  const find = db.prepare(`select asset_id from location where filename = ? and asset_id is not null
                           and state in ('present', 'dematerialised')`);
  const has = db.prepare('select 1 from annotation where asset_id = ? and key = ? and value = ?');
  const put = db.prepare(`insert into annotation(asset_id, key, value, source, created_at)
                          values(?,'tag',?,'photos-album',?)`);
  const now = new Date().toISOString();
  const touched = new Set(), albums = new Set(), absent = new Set();
  let written = 0;
  for (const r of rows) {
    const hit = find.get(r.filename);
    if (!hit) { absent.add(r.filename); continue; }
    if (!has.get(hit.asset_id, 'tag', r.album)) { put.run(hit.asset_id, r.album, now); written++; }
    touched.add(hit.asset_id);
    albums.add(r.album);
  }

  // Writing the row is not enough: search reads a full-text table that reindex rebuilds, and
  // reindex is also what keeps anything marked private out of it.
  const { reindex } = require('./storage.js');
  for (const id of touched) { try { reindex(db, id); } catch {} }

  const names = [...albums].sort().slice(0, 8).join(', ');
  return {
    text: `Tagged ${touched.size.toLocaleString()} file${touched.size === 1 ? '' : 's'} from `
      + `${albums.size} Photos album${albums.size === 1 ? '' : 's'}`
      + (written ? ` (${written.toLocaleString()} new tag${written === 1 ? '' : 's'})` : ', all of which were already there')
      + `. ${names}${albums.size > 8 ? ', and more' : ''}.`
      + (absent.size ? `\n\n${absent.size.toLocaleString()} more files sit in those albums but are `
          + `not on this Mac, only in iCloud, so they could not be tagged. Yellide never downloads `
          + `them.` : '')
      + `\n\nThese are album names, not descriptions of what is in each picture, so they are `
      + `searchable but the content coverage figure has deliberately not moved.`,
    data: { files: touched.size, albums: albums.size, written, not_on_disk: absent.size },
  };
}

module.exports = { findLibrary, isDescriptive, readAlbums, importAlbums, libraryRecords };
