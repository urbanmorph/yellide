// Yellide — EXIF / TIFF-IFD extractor. Pure JS, zero dependencies.
//
// One parser covers most of a creative archive's stills:
//   JPEG            → APP1 segment holds a TIFF block
//   NEF ARW CR2 DNG → the file *is* a TIFF
//   HEIC            → ISO-BMFF, but the EXIF payload is still a TIFF block
// So: find the TIFF block, walk its IFDs, done.
const fs = require('fs');

const IMAGE = new Set(['.jpg','.jpeg','.jpe','.png','.heic','.heif','.tif','.tiff','.webp','.gif','.bmp',
                       '.dng','.nef','.arw','.cr2','.cr3','.orf','.raf','.rw2','.pef','.srw']);
// Deliberately empty. Yellide indexes what you SHOT — images, video, audio — not what you
// wrote. PDFs and design documents swept up invoices, papers and repo documentation:
// 1,794 "design" files in one code repo alone, which is noise, not an archive.
const DESIGN = new Set([]);

const TAG = {
  MAKE: 0x010f, MODEL: 0x0110, ORIENTATION: 0x0112, DATETIME: 0x0132,
  EXIF_IFD: 0x8769, GPS_IFD: 0x8825,
  DATETIME_ORIGINAL: 0x9003, DATETIME_DIGITIZED: 0x9004,
  EXPOSURE: 0x829a, FNUMBER: 0x829d, ISO: 0x8827, FOCAL: 0x920a,
  PIXEL_X: 0xa002, PIXEL_Y: 0xa003, LENS_MODEL: 0xa434,
};
const GPS = { LAT_REF: 1, LAT: 2, LON_REF: 3, LON: 4, ALT_REF: 5, ALT: 6 };
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

class Reader {
  constructor(buf, base, le) { this.b = buf; this.base = base; this.le = le; }
  u16(o) { return this.le ? this.b.readUInt16LE(o) : this.b.readUInt16BE(o); }
  u32(o) { return this.le ? this.b.readUInt32LE(o) : this.b.readUInt32BE(o); }
  i32(o) { return this.le ? this.b.readInt32LE(o) : this.b.readInt32BE(o); }
}

function readValue(r, type, count, valueOff) {
  const size = TYPE_SIZE[type] || 1, total = size * count;
  // Values of 4 bytes or fewer live inline; larger ones are at an offset from the TIFF base.
  const at = total <= 4 ? valueOff : r.base + r.u32(valueOff);
  if (at < 0 || at + total > r.b.length) return null;
  switch (type) {
    case 2: { // ASCII
      let s = r.b.toString('latin1', at, at + total);
      const z = s.indexOf('\0'); if (z >= 0) s = s.slice(0, z);
      return s.trim() || null;
    }
    case 1: case 7: return count === 1 ? r.b[at] : null;
    case 3: return r.u16(at);
    case 4: return r.u32(at);
    case 9: return r.i32(at);
    case 5: case 10: { // RATIONAL / SRATIONAL
      const out = [];
      for (let i = 0; i < count; i++) {
        const n = type === 5 ? r.u32(at + i * 8) : r.i32(at + i * 8);
        const d = type === 5 ? r.u32(at + i * 8 + 4) : r.i32(at + i * 8 + 4);
        out.push(d ? n / d : 0);
      }
      return count === 1 ? out[0] : out;
    }
    default: return null;
  }
}

function walkIfd(r, ifdOff, want) {
  const out = {};
  if (ifdOff < 0 || ifdOff + 2 > r.b.length) return out;
  const n = r.u16(ifdOff);
  if (n > 512) return out;                       // corrupt or misparsed
  for (let i = 0; i < n; i++) {
    const e = ifdOff + 2 + i * 12;
    if (e + 12 > r.b.length) break;
    const tag = r.u16(e), type = r.u16(e + 2), count = r.u32(e + 4);
    if (!want.has(tag)) continue;
    const v = readValue(r, type, count, e + 8);
    if (v !== null) out[tag] = v;
  }
  return out;
}

const dmsToDecimal = (dms, ref) => {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const dec = dms[0] + dms[1] / 60 + dms[2] / 3600;
  return (ref === 'S' || ref === 'W') ? -dec : dec;
};

// Locate the TIFF block: JPEG APP1, a bare TIFF header, or an Exif payload inside HEIC.
function findTiff(buf) {
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) {
    const le = buf[0] === 0x49;
    const magic = le ? buf.readUInt16LE(2) : buf.readUInt16BE(2);
    if (magic === 42 || magic === 0x4f52 || magic === 0x5352) return 0;   // TIFF / ORF variants
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {                                // JPEG
    let o = 2;
    while (o + 4 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1], len = buf.readUInt16BE(o + 2);
      if (marker === 0xe1 && buf.toString('latin1', o + 4, o + 8) === 'Exif') return o + 10;
      if (marker === 0xda) break;                                          // start of scan
      o += 2 + len;
    }
  }
  const i = buf.indexOf('Exif\0\0', 0, 'latin1');                          // HEIC and friends
  return i >= 0 ? i + 6 : -1;
}

// Dimensions without EXIF, straight from the container.
function rawDimensions(buf) {
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG')
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const m = buf[o + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      if (m === 0xda) break;
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    if (buf.toString('latin1', 12, 16) === 'VP8X')
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return {};
}

// A local file ALWAYS allocates at least one block; a cloud placeholder allocates none.
// `blocks === 0 && size > 0` is the unambiguous signal.
//
// An earlier version used `size > 1MB && blocks*512 < size/8`. On a real Desktop that
// missed 22 of 24 placeholders — every screenshot under 1MB got read, and each read
// forced an iCloud download. The scan appeared to hang. There is no safe size floor.
//
// Deliberately NOT using a ratio test: APFS transparent compression legitimately
// reports fewer blocks than bytes, so a ratio would false-positive on local files.
// `blocks` is POSIX-only. On Windows it is 0 or undefined, which would make EVERY file
// look like a cloud placeholder — nothing would be indexed, silently, with no error.
// So probe once at startup against a file we know is local, and disable the heuristic
// where it cannot work rather than assuming the platform.
const BLOCKS_MEANINGFUL = (() => {
  try { const st = fs.statSync(__filename); return typeof st.blocks === 'number' && st.blocks > 0; }
  catch { return false; }
})();

function isDataless(st) {
  if (!BLOCKS_MEANINGFUL) return false;   // fail OPEN: index it rather than skip everything
  return st.size > 0 && st.blocks === 0;
}
module.exports_blocksMeaningful = BLOCKS_MEANINGFUL;

function extractImage(file, windowBytes = 512 * 1024) {
  const st = fs.statSync(file);
  if (isDataless(st))
    return { size: st.size, kind: 'image', dematerialised: true, container: null,
             width: null, height: null, shot_at: null, shot_at_local: null,
             camera: null, lens: null, gps: null, meta_bytes: 0 };
  const fd = fs.openSync(file, 'r');
  const r = { size: st.size, kind: 'image', container: null, width: null, height: null,
              shot_at: null, shot_at_local: null, camera: null, lens: null,
              gps: null, gps_lat: null, gps_lon: null, iso: null, fnumber: null,
              focal_mm: null, meta_bytes: 0,
              dematerialised: false };
  try {
    const n = Math.min(st.size, windowBytes);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, 0);
    r.meta_bytes = n;
    Object.assign(r, rawDimensions(buf));

    const base = findTiff(buf);
    if (base < 0 || base + 8 > buf.length) return r;
    r.container = 'TIFF/EXIF';
    const le = buf[base] === 0x49;
    const rd = new Reader(buf, base, le);
    const ifd0Off = base + rd.u32(base + 4);

    const want0 = new Set([TAG.MAKE, TAG.MODEL, TAG.DATETIME, TAG.EXIF_IFD, TAG.GPS_IFD]);
    const ifd0 = walkIfd(rd, ifd0Off, want0);

    const make = ifd0[TAG.MAKE], model = ifd0[TAG.MODEL];
    if (make || model) {
      const norm = s => String(s).replace(/\s+corporation|\s+imaging|\s+inc\.?/ig, '').trim();
      r.camera = (model && make && norm(model).toLowerCase().includes(norm(make).toLowerCase()))
        ? norm(model) : [make && norm(make), model && norm(model)].filter(Boolean).join(' ');
    }
    if (ifd0[TAG.DATETIME]) r.shot_at_local = ifd0[TAG.DATETIME];

    if (ifd0[TAG.EXIF_IFD]) {
      const wantE = new Set([TAG.DATETIME_ORIGINAL, TAG.DATETIME_DIGITIZED, TAG.ISO,
                             TAG.FNUMBER, TAG.FOCAL, TAG.PIXEL_X, TAG.PIXEL_Y, TAG.LENS_MODEL]);
      const ex = walkIfd(rd, base + ifd0[TAG.EXIF_IFD], wantE);
      r.shot_at_local = ex[TAG.DATETIME_ORIGINAL] || ex[TAG.DATETIME_DIGITIZED] || r.shot_at_local;
      r.iso = ex[TAG.ISO] ?? null;
      r.fnumber = ex[TAG.FNUMBER] ?? null;
      r.focal_mm = ex[TAG.FOCAL] ?? null;
      r.lens = ex[TAG.LENS_MODEL] || null;
      if (!r.width && ex[TAG.PIXEL_X]) { r.width = ex[TAG.PIXEL_X]; r.height = ex[TAG.PIXEL_Y]; }
    }

    if (ifd0[TAG.GPS_IFD]) {
      const g = walkIfd(rd, base + ifd0[TAG.GPS_IFD],
                        new Set([GPS.LAT_REF, GPS.LAT, GPS.LON_REF, GPS.LON]));
      const lat = dmsToDecimal(g[GPS.LAT], g[GPS.LAT_REF]);
      const lon = dmsToDecimal(g[GPS.LON], g[GPS.LON_REF]);
      if (lat !== null && lon !== null) {
        r.gps_lat = +lat.toFixed(6); r.gps_lon = +lon.toFixed(6);
        r.gps = `${r.gps_lat},${r.gps_lon}`;
      }
    }
    // EXIF dates are local wall-clock with no zone. Keep them as-is and mirror to shot_at
    // so sorting works, rather than inventing a timezone we don't know.
    if (r.shot_at_local && !r.shot_at) {
      const m = String(r.shot_at_local).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
      if (m) r.shot_at = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
    }
  } catch { /* degrade to whatever we already have */ }
  finally { fs.closeSync(fd); }
  return r;
}

// Design files carry no metadata worth parsing — but they are part of the archive, and
// Tier 1 (folder, filename, date) still makes them findable.
function extractDesign(file) {
  const st = fs.statSync(file);
  return { size: st.size, kind: 'design', dematerialised: isDataless(st), container: null, width: null, height: null,
           shot_at: null, shot_at_local: null, camera: null, gps: null, meta_bytes: 0 };
}

module.exports = { IMAGE, DESIGN, extractImage, extractDesign, findTiff, rawDimensions, isDataless, BLOCKS_MEANINGFUL };
