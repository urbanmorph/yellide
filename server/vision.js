// Yellide — showing pictures to the agent.
//
// The whole point of Option B: "find people walking" needs someone to LOOK. We don't run a
// model, the user's own agent does — so our job is just to get a small enough picture in
// front of it.
//
// Why this needs work at all: 613 of 639 stills on a real machine are over 10 MB (a D610
// shoots 6016×4016), and the EXIF preview embedded in them is a 7 KB thumbnail — far too
// small to caption. So the image has to be decoded and shrunk.
//
// macOS ships `sips`, which does 10 MB → 84 KB at 512×768 in 0.27 s at zero bundle cost.
// Windows and Linux have no equivalent guaranteed binary; they get this when ffmpeg lands
// (build step three), and until then say so plainly rather than failing oddly.
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');

const SIPS = process.platform === 'darwin' && (() => {
  try { return fs.existsSync('/usr/bin/sips'); } catch { return false; }
})();
// Video was supposed to wait for ffmpeg. macOS ships QuickLook, which renders a poster
// frame from any format the OS can play — 0.7 s, no dependency. For b-roll that is usually
// enough, because a b-roll clip is one continuous shot: the poster frame characterises it.
const QLMANAGE = process.platform === 'darwin' && (() => {
  try { return fs.existsSync('/usr/bin/qlmanage'); } catch { return false; }
})();

function capability() {
  if (SIPS) return { ok: true, via: 'sips (built into macOS)', video: QLMANAGE ? 'qlmanage poster frame' : null };
  return { ok: false, via: null,
    reason: `Looking at pictures needs an image resizer, and ${process.platform} has no guaranteed one. ` +
            `macOS uses the built-in sips. Elsewhere this arrives with ffmpeg. ` +
            `Everything else, search, dates, cameras, drives, works normally.` };
}

// Returns a small JPEG as base64, or null. Never throws: a picture that will not open is
// a skipped picture, not a failed conversation.
function thumbnail(file, size = 768, quality = 60) {
  if (!SIPS) return null;
  const out = path.join(os.tmpdir(), `yl-${process.pid}-${Math.abs(hash(file))}.jpg`);
  try {
    execFileSync('/usr/bin/sips', ['-Z', String(size), '-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(quality), file, '--out', out],
      { stdio: 'ignore', timeout: 20000 });
    const b = fs.readFileSync(out);
    return b.toString('base64');
  } catch { return null; }
  finally { try { fs.unlinkSync(out); } catch {} }
}

// One frame from a video, via QuickLook, then shrunk through the same path as a still.
function videoFrame(file, size = 768, quality = 60) {
  if (!QLMANAGE || !SIPS) return null;
  const dir = path.join(os.tmpdir(), `yl-ql-${process.pid}-${Math.abs(hash(file))}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('/usr/bin/qlmanage', ['-t', '-s', String(size * 2), '-o', dir, file],
      { stdio: 'ignore', timeout: 30000 });
    const made = fs.readdirSync(dir).filter(f => f.endsWith('.png'))[0];
    if (!made) return null;
    const png = path.join(dir, made), jpg = png.replace(/\.png$/, '.jpg');
    execFileSync('/usr/bin/sips', ['-Z', String(size), '-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(quality), png, '--out', jpg], { stdio: 'ignore', timeout: 20000 });
    return fs.readFileSync(jpg).toString('base64');
  } catch { return null; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

module.exports = { thumbnail, videoFrame, capability, available: SIPS, video: QLMANAGE };
