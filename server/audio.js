// Yellide — audio metadata. Pure JS, zero dependencies.
//
// The ISO-BMFF walker handles .m4a, but MP3, WAV and FLAC are not ISO-BMFF and were
// coming back completely blank — 1,070 of 1,753 files on a real machine. For an archive
// of podcast recordings that is the entire library, so these are not a nicety.
const fs = require('fs');
const { isDataless } = require('./exif.js');

const MPEG_RATE = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];
const MPEG_BITRATE_V1L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
const MPEG_BITRATE_V2L3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];

const ID3_FRAMES = { TIT2: 'title', TPE1: 'artist', TALB: 'album', TDRC: 'date',
                     TYER: 'date', TDAT: 'date', TCON: 'genre', COMM: 'comment',
                     TSSE: 'encoder', TENC: 'encoder' };

function syncsafe(b, o) { return (b[o] << 21) | (b[o+1] << 14) | (b[o+2] << 7) | b[o+3]; }

function readId3(buf) {
  const out = {};
  if (buf.toString('latin1', 0, 3) !== 'ID3') return { out, end: 0 };
  const major = buf[3];
  const size = syncsafe(buf, 6);
  let o = 10;
  const end = Math.min(10 + size, buf.length);
  while (o + 10 <= end) {
    const id = buf.toString('latin1', o, o + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsz = major >= 4 ? syncsafe(buf, o + 4) : buf.readUInt32BE(o + 4);
    if (fsz <= 0 || o + 10 + fsz > end) break;
    const key = ID3_FRAMES[id];
    if (key) {
      const enc = buf[o + 10];
      let raw = buf.slice(o + 11, o + 10 + fsz);
      let txt;
      if (enc === 1 || enc === 2) txt = raw.toString('utf16le').replace(/^﻿/, '');
      else txt = raw.toString(enc === 3 ? 'utf8' : 'latin1');
      txt = txt.replace(/\0+$/, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ').trim();
      if (txt && !out[key]) out[key] = txt.slice(0, 200);
    }
    o += 10 + fsz;
  }
  return { out, end: 10 + size };
}

// Duration from the first MPEG frame header, refined by a Xing/Info VBR header if present.
function mp3Duration(buf, startAt, fileSize) {
  for (let o = startAt; o < Math.min(buf.length - 4, startAt + 200000); o++) {
    if (buf[o] !== 0xff || (buf[o + 1] & 0xe0) !== 0xe0) continue;
    const verBits = (buf[o + 1] >> 3) & 3, layer = (buf[o + 1] >> 1) & 3;
    if (verBits === 1 || layer === 0) continue;
    const v1 = verBits === 3;
    const brIdx = (buf[o + 2] >> 4) & 15, srIdx = (buf[o + 2] >> 2) & 3;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
    const sampleRate = MPEG_RATE[v1 ? 0 : (verBits === 2 ? 1 : 2)][srIdx];
    const bitrate = (v1 ? MPEG_BITRATE_V1L3 : MPEG_BITRATE_V2L3)[brIdx] * 1000;
    if (!sampleRate || !bitrate) continue;
    const channels = ((buf[o + 3] >> 6) & 3) === 3 ? 1 : 2;
    // Xing/Info sits at a fixed offset inside the first frame and carries the frame count.
    const xingOff = o + 4 + (v1 ? (channels === 1 ? 17 : 32) : (channels === 1 ? 9 : 17));
    if (xingOff + 12 < buf.length) {
      const tag = buf.toString('latin1', xingOff, xingOff + 4);
      if (tag === 'Xing' || tag === 'Info') {
        const flags = buf.readUInt32BE(xingOff + 4);
        if (flags & 1) {
          const frames = buf.readUInt32BE(xingOff + 8);
          const spf = v1 ? 1152 : 576;
          return { duration_s: +(frames * spf / sampleRate).toFixed(2), sampleRate, channels, bitrate, vbr: true };
        }
      }
    }
    return { duration_s: +((fileSize - startAt) * 8 / bitrate).toFixed(2), sampleRate, channels, bitrate, vbr: false };
  }
  return {};
}

// RIFF/WAVE, including the BWF `bext` chunk that recorders write — origination date and
// time is exactly "when was this recorded", which is the primary sort for an archive.
function readWav(buf, fileSize) {
  const r = {};
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return r;
  let o = 12, byteRate = 0, dataSize = 0;
  while (o + 8 <= buf.length) {
    const id = buf.toString('latin1', o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (size < 0) break;
    if (id === 'fmt ' && o + 24 <= buf.length) {
      r.channels = buf.readUInt16LE(o + 10);
      r.sampleRate = buf.readUInt32LE(o + 12);
      byteRate = buf.readUInt32LE(o + 16);
      r.bits = buf.readUInt16LE(o + 22);
    } else if (id === 'bext' && o + 8 + 348 <= buf.length) {
      const s = p => buf.toString('latin1', o + 8 + p[0], o + 8 + p[1]).replace(/\0.*$/, '').trim();
      const desc = s([0, 256]), orig = s([256, 288]), date = s([320, 330]), time = s([330, 338]);
      if (desc) r.description = desc.slice(0, 200);
      if (orig) r.originator = orig;
      if (/^\d{4}[-:]\d{2}[-:]\d{2}$/.test(date))
        r.shot_at_local = date.replace(/:/g, '-') + (/^\d{2}:\d{2}:\d{2}$/.test(time) ? ' ' + time : '');
    } else if (id === 'data') {
      dataSize = size === 0xffffffff || o + 8 + size > fileSize ? fileSize - (o + 8) : size;
    } else if (id === 'LIST' && buf.toString('latin1', o + 8, o + 12) === 'INFO') {
      const inner = buf.slice(o + 12, Math.min(o + 8 + size, buf.length)).toString('latin1');
      const m = inner.match(/INAM.{4}([\x20-\x7e]{2,})/);
      if (m && !r.description) r.description = m[1].trim().slice(0, 200);
    }
    o += 8 + size + (size % 2);
    if (dataSize && r.sampleRate) break;
  }
  if (byteRate && dataSize) r.duration_s = +(dataSize / byteRate).toFixed(2);
  return r;
}

function readFlac(buf) {
  const r = {};
  if (buf.toString('latin1', 0, 4) !== 'fLaC') return r;
  // STREAMINFO is always the first metadata block.
  const b = buf.slice(8, 42);
  if (b.length < 18) return r;
  r.sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
  r.channels = ((b[12] >> 1) & 7) + 1;
  const totalSamples = ((b[13] & 0x0f) * 2 ** 32) + b.readUInt32BE(14);
  if (r.sampleRate && totalSamples) r.duration_s = +(totalSamples / r.sampleRate).toFixed(2);
  return r;
}

function extractAudio(file, kind) {
  const st = fs.statSync(file);
  const base = { size: st.size, kind: 'audio', container: null, duration_s: null,
                 shot_at: null, shot_at_local: null, camera: null, gps: null,
                 title: null, artist: null, description: null,
                 sample_rate: null, channels: null, meta_bytes: 0, dematerialised: false };
  if (isDataless(st)) return { ...base, dematerialised: true };

  const fd = fs.openSync(file, 'r');
  try {
    const n = Math.min(st.size, 256 * 1024);
    const buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, 0);
    base.meta_bytes = n;
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();

    if (ext === '.wav' || ext === '.aif' || ext === '.aiff') {
      Object.assign(base, readWav(buf, st.size)); base.container = 'RIFF/WAVE';
    } else if (ext === '.flac') {
      Object.assign(base, readFlac(buf)); base.container = 'FLAC';
    } else {
      const { out, end } = readId3(buf);
      base.container = 'MPEG';
      base.title = out.title || null; base.artist = out.artist || null;
      if (out.date) base.shot_at_local = out.date;
      Object.assign(base, mp3Duration(buf, end, st.size));
    }
    if (base.sampleRate) { base.sample_rate = base.sampleRate; delete base.sampleRate; }
    if (base.shot_at_local && !base.shot_at) {
      const m = String(base.shot_at_local).match(/^(\d{4})[-:](\d{2})[-:](\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
      if (m) base.shot_at = `${m[1]}-${m[2]}-${m[3]}` + (m[4] ? `T${m[4]}:${m[5]}:${m[6]}` : '');
    }
  } catch { /* degrade */ }
  finally { fs.closeSync(fd); }
  return base;
}

module.exports = { extractAudio, readId3, readWav, readFlac, mp3Duration };
