// Yellide — the video containers that are not ISO-BMFF.
//
// Every video used to go through the MP4/MOV parser, which reads nothing from an AVI, an MKV
// or a camcorder's MPEG stream. They were found and hashed, and then had no date, no length
// and no size. Old point-and-shoots wrote AVI, SD camcorders MPEG-2, AVCHD cameras MPEG-TS.
//
// Each parser reads a small head (and sometimes a tail) of the file, never the whole thing,
// and returns only what it found. Anything unreadable degrades to {}.
const fs = require('fs');

const read = (fd, pos, len) => {
  const b = Buffer.alloc(Math.max(0, len));
  return b.subarray(0, fs.readSync(fd, b, 0, b.length, pos));
};
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, '0');

// ---- Matroska / WebM: EBML, variable-length ids and sizes ----
const MKV_MASTER = new Set([0x18538067, 0x1549a966, 0x1654ae6b, 0xae, 0xe0]);   // Segment Info Tracks TrackEntry Video
const MKV_CLUSTER = 0x1f43b675;

function vint(b, o, keepMarker) {
  const first = b[o];
  if (!first) return null;
  const len = Math.clz32(first) - 23;                   // leading zeros within the byte, plus one
  if (len > 8 || o + len > b.length) return null;
  let v = keepMarker ? first : first & (0xff >> len), allOnes = v === (0xff >> len);
  for (let i = 1; i < len; i++) { v = v * 256 + b[o + i]; if (b[o + i] !== 0xff) allOnes = false; }
  return { v, len, unknown: !keepMarker && allOnes };
}

function matroska(fd, size) {
  const b = read(fd, 0, Math.min(size, 1 << 20)), r = {};
  if (b.readUInt32BE(0) !== 0x1a45dfa3) return r;
  let scale = 1e6, duration = null;
  const walk = (start, end) => {
    let o = start;
    while (o < end) {
      const id = vint(b, o, true); if (!id) return;
      const sz = vint(b, o + id.len, false); if (!sz) return;
      const s = o + id.len + sz.len, e = sz.unknown ? end : Math.min(end, s + sz.v);
      if (id.v === MKV_CLUSTER) return false;          // media data from here on
      if (MKV_MASTER.has(id.v)) { if (walk(s, e) === false) return false; }
      else {
        // One malformed field costs only itself, never the fields after it.
        const n = e - s;
        const u = () => n >= 1 && n <= 6 ? b.readUIntBE(s, n) : null;
        try {
          if (id.v === 0x2ad7b1) scale = u() || scale;
          else if (id.v === 0x4489) duration = n === 4 ? b.readFloatBE(s) : n === 8 ? b.readDoubleBE(s) : null;
          else if (id.v === 0x4461 && n === 8)
            r.shot_at = new Date(Date.UTC(2001, 0, 1) + Number(b.readBigInt64BE(s) / 1000000n)).toISOString();
          else if (id.v === 0xb0 && !r.width) r.width = u() || undefined;
          else if (id.v === 0xba && !r.height) r.height = u() || undefined;
          else if (id.v === 0x7ba9) r.title = b.toString('utf8', s, e).replace(/\0+$/, '') || undefined;
        } catch {}
      }
      o = e;
    }
  };
  try { walk(0, b.length); } catch {}
  if (duration) r.duration_s = +(duration * scale / 1e9).toFixed(2);
  r.container = 'Matroska';
  return r;
}

// ---- AVI: RIFF chunks, little-endian ----
function avi(fd, size) {
  const b = read(fd, 0, Math.min(size, 256 << 10)), r = {};
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'AVI ') return r;
  r.container = 'AVI';
  const walk = (start, end) => {
    let o = start;
    while (o + 8 <= end) {
      const id = b.toString('latin1', o, o + 4), n = b.readUInt32LE(o + 4), s = o + 8, e = Math.min(end, s + n);
      if (id === 'LIST') {
        const type = b.toString('latin1', s, s + 4);
        if (type === 'movi') return;                     // media data from here on
        walk(s + 4, e);
      } else if (id === 'avih' && e - s >= 40) {
        const us = b.readUInt32LE(s), frames = b.readUInt32LE(s + 16);
        if (us && frames) r.duration_s = +(us * frames / 1e6).toFixed(2);
        r.width = b.readUInt32LE(s + 32) || undefined; r.height = b.readUInt32LE(s + 36) || undefined;
      } else if (id === 'IDIT' || id === 'ICRD') {
        r.shot_at_local = r.shot_at_local || aviDate(b.toString('latin1', s, e).replace(/[\0\n\r]+/g, ' ').trim());
      }
      o = s + n + (n % 2);
    }
  };
  try { walk(12, b.length); } catch {}
  return r;
}

// "Sat Mar 14 15:30:12 2009" from most cameras, "2009:03:14 15:30:12" from a few.
function aviDate(t) {
  let m = t.match(/([a-z]{3})\w*\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})/i);
  if (m && MONTHS[m[1].toLowerCase()]) return `${m[6]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])} ${m[3]}:${m[4]}:${m[5]}`;
  m = t.match(/(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` + (m[4] ? ` ${m[4]}:${m[5]}:${m[6]}` : '') : null;
}

// ---- MPEG programme stream (.mpg .vob .mod): the 90 kHz clock in the first and last pack ----
function scr(b, o) {
  const x = b[o + 4];
  if ((x & 0xc0) === 0x40)                                // MPEG-2
    return ((x >> 3) & 7) * 2 ** 30 + (x & 3) * 2 ** 28 + b[o + 5] * 2 ** 20 + ((b[o + 6] >> 3) & 0x1f) * 2 ** 15
         + (b[o + 6] & 3) * 2 ** 13 + b[o + 7] * 2 ** 5 + (b[o + 8] >> 3);
  if ((x & 0xf0) === 0x20)                                // MPEG-1
    return ((x >> 1) & 7) * 2 ** 30 + b[o + 5] * 2 ** 22 + (b[o + 6] >> 1) * 2 ** 15 + b[o + 7] * 2 ** 7 + (b[o + 8] >> 1);
  return null;
}
const isPack = (b, o) => b[o] === 0 && b[o + 1] === 0 && b[o + 2] === 1 && b[o + 3] === 0xba;

function mpegPs(fd, size) {
  const W = 256 << 10, head = read(fd, 0, Math.min(size, W)), tail = read(fd, Math.max(0, size - W), Math.min(size, W));
  let first = null, last = null;
  for (let o = 0; o + 10 <= head.length && first === null; o++) if (isPack(head, o)) first = scr(head, o);
  for (let o = tail.length - 10; o >= 0 && last === null; o--) if (isPack(tail, o)) last = scr(tail, o);
  if (first === null) return {};
  return { container: 'MPEG-PS', ...span(first, last) };
}

// ---- MPEG transport stream (.mts .m2ts .tod): the PCR of one programme, first and last ----
function pcr(b, o) {
  if (b[o] !== 0x47 || !((b[o + 3] >> 5) & 1) || b[o + 4] < 7 || !(b[o + 5] & 0x10)) return null;
  return { pid: ((b[o + 1] & 0x1f) << 8) | b[o + 2],
           t: b[o + 6] * 2 ** 25 + b[o + 7] * 2 ** 17 + b[o + 8] * 2 ** 9 + b[o + 9] * 2 + (b[o + 10] >> 7) };
}
function mpegTs(fd, size) {
  const W = 512 << 10, head = read(fd, 0, Math.min(size, W)), tail = read(fd, Math.max(0, size - W), Math.min(size, W));
  // 188-byte packets, or 192 with the 4-byte timecode AVCHD puts in front of each.
  const step = head[0] === 0x47 && head[188] === 0x47 ? 188 : head[4] === 0x47 && head[196] === 0x47 ? 192 : 0;
  if (!step) return {};
  const lead = step - 188;
  let first = null, last = null;
  for (let o = lead; o + 188 <= head.length && !first; o += step) first = pcr(head, o);
  if (!first) return { container: 'MPEG-TS' };
  let align = -1;
  for (let i = 0; i < step && align < 0; i++) if (tail[i + lead] === 0x47 && tail[i + lead + step] === 0x47) align = i + lead;
  if (align >= 0) {
    const offs = [];
    for (let o = align; o + 188 <= tail.length; o += step) offs.push(o);
    for (let i = offs.length - 1; i >= 0 && !last; i--) { const p = pcr(tail, offs[i]); if (p && p.pid === first.pid) last = p; }
  }
  return { container: 'MPEG-TS', ...span(first.t, last && last.t) };
}

// 90 kHz ticks. A clock that wraps or resets mid-file gives no length rather than a wrong one.
const span = (a, b) => (b != null && b > a && (b - a) / 90000 < 86400) ? { duration_s: +((b - a) / 90000).toFixed(2) } : {};

const BY_EXT = {
  '.mkv': matroska, '.webm': matroska,
  '.avi': avi,
  '.mpg': mpegPs, '.mpeg': mpegPs, '.vob': mpegPs, '.mod': mpegPs, '.m2v': mpegPs,
  '.mts': mpegTs, '.m2ts': mpegTs, '.m2t': mpegTs, '.tod': mpegTs,
};

module.exports = { BY_EXT, matroska, avi, mpegPs, mpegTs, aviDate };
