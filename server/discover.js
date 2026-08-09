// Yellide — finding where someone's media actually is.
//
// Two rules learned the hard way:
//   1. Never guess folder NAMES. A hardcoded list of Movies/Pictures/Desktop/Documents
//      missed "~/Premire Pro Videos" — 249 files, 74 GB, and misspelled, so no keyword
//      list would ever have caught it. Enumerate what exists, rank by media density.
//   2. Never ask the user for a path. They do not know where their media is; that is
//      the problem the tool exists to solve.
//
// And be fast: a full-depth sweep took 38 s, which is far too slow for the first thing
// anyone sees. A shallow pass answers "where is it" in ~2 s and a deep pass refines.
const fs = require('fs'), path = require('path'), os = require('os');
const core = require('./core.js');
const exif = require('./exif.js');

const SKIP_TOP = /^(Library|Applications|Public|\.Trash|Music|node_modules|go|Developer|AppData|snap|\.local|\.config)$/i;
const CLOUD_SUBPATHS = ['Library/Mobile Documents/com~apple~CloudDocs', 'OneDrive',
                        'OneDrive - Personal', 'Nextcloud', 'ownCloud'];

function candidateRoots() {
  const home = os.homedir(), roots = [];
  const add = (label, p) => { try { if (fs.statSync(p).isDirectory()) roots.push({ label, path: p }); } catch {} };
  try {
    for (const n of fs.readdirSync(home)) {
      if (n.startsWith('.') || SKIP_TOP.test(n)) continue;
      add('home', path.join(home, n));
    }
  } catch {}
  let bootDev = null; try { bootDev = fs.statSync(home).dev; } catch {}
  for (const vp of core.volumeRoots()) {
    // The boot volume is the same filesystem as home; indexing it doubles everything.
    try { if (bootDev !== null && fs.statSync(vp).dev === bootDev) continue; } catch {}
    add('volume', vp);
  }
  for (const c of CLOUD_SUBPATHS) add('cloud', path.join(home, c));
  return roots;
}

function summarise(root, files) {
  const byExt = {}, byKind = {};
  let bytes = 0, placeholders = 0;
  for (const f of files) {
    const e = path.extname(f.p).toLowerCase();
    byExt[e] = (byExt[e] || 0) + 1;
    const k = core.KIND(e) || 'other';
    byKind[k] = (byKind[k] || 0) + 1;
    bytes += f.size;
    if (exif.isDataless(f)) placeholders++;
  }
  return {
    path: root.path, label: root.label,
    media_files: files.length,
    gb: +(bytes / 1e9).toFixed(2),
    kinds: byKind,
    cloud_placeholders: placeholders,
    extensions: Object.fromEntries(Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 6)),
  };
}

// Shallow and quick: enough to say "your media is HERE", not how much of it there is.
function discoverFast(opts = {}) {
  const t0 = Date.now();
  const maxDepth = opts.depth ?? 3, cap = opts.cap ?? 120, budget = opts.budget_ms ?? 6000;
  const out = [];
  let truncated = false;
  for (const root of candidateRoots()) {
    if (Date.now() - t0 > budget) { truncated = true; break; }
    let files = [];
    try { files = core.walkTree(root.path, [], 0, cap, maxDepth); } catch { continue; }
    if (!files.length) continue;
    const s = summarise(root, files);
    s.at_least = files.length >= cap;      // a floor, not a count
    out.push(s);
  }
  out.sort((a, b) => b.media_files - a.media_files);
  return { mode: 'fast', depth: maxDepth, elapsed_ms: Date.now() - t0, budget_hit: truncated,
           locations: out,
           note: 'Shallow sweep. Counts marked at_least:true are floors — the deep pass refines them.' };
}

// Full depth, for when the real numbers matter.
function discoverDeep(opts = {}) {
  const t0 = Date.now();
  const cap = opts.cap ?? 20000, maxDepth = opts.depth ?? 10;
  const out = [];
  for (const root of candidateRoots()) {
    let files = [];
    try { files = core.walkTree(root.path, [], 0, cap, maxDepth); } catch { continue; }
    if (!files.length) continue;
    out.push(summarise(root, files));
  }
  out.sort((a, b) => b.media_files - a.media_files);
  const totals = out.reduce((a, l) => ({
    files: a.files + l.media_files, gb: +(a.gb + l.gb).toFixed(2),
    placeholders: a.placeholders + l.cloud_placeholders }), { files: 0, gb: 0, placeholders: 0 });
  return { mode: 'deep', elapsed_ms: Date.now() - t0, locations: out, totals };
}

module.exports = { discoverFast, discoverDeep, candidateRoots };
