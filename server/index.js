#!/usr/bin/env node
// Yellide — MCP server. Runs entirely inside Claude Desktop's own Node runtime: scan → identity → Tier 0 metadata → node:sqlite → FTS5 → search.
// Read-only against your footage. The index goes to a temp file. Nothing is uploaded.
//
// stdout is the MCP protocol. Nothing may ever be written to it except JSON-RPC.
const os = require('os'), path = require('path'), fs = require('fs');
const { Worker } = require('worker_threads');
const log = (...a) => process.stderr.write('[yellide] ' + a.join(' ') + '\n');

// Read from the manifest, never written twice. Hardcoded literals here reported 0.9.5 to
// the diagnostics tool and 0.1.0 to the MCP handshake for four releases running — and the
// diagnostics report exists precisely to tell you which version you are on.
const SERVER_VERSION = (() => {
  try { return require(path.join(__dirname, '..', 'manifest.json')).version; }
  catch { return 'unknown'; }
})();
const PKG_VERSION = SERVER_VERSION;
const STARTED = Date.now();

// Opt out of the one thing Yellide writes to a drive. A boolean user_config arrives as the
// string "true"/"false"; if the client never expanded it, the literal "${...}" arrives
// instead, and an unexpanded template must never be read as consent either way.
const NO_DRIVE_MARKER = (() => {
  const v = String(process.env.YELLIDE_NO_DRIVE_MARKER || '').trim();
  if (!v || /^\$\{.*\}$/.test(v)) return false;          // not set: keep current behaviour
  return /^(1|true|yes|on)$/i.test(v);
})();
let core = null, coreErr = null, storage = null, discover = null, T = null, contribute = null,
    photos = null;
try {
  core = require('./core.js');
  storage = require('./storage.js');
  discover = require('./discover.js');
  T = require('./tools.js');
  photos = require('./photos.js');
  contribute = require('./contribute.js');
} catch (e) { coreErr = String(e.stack || e.message); }

// One long-lived read connection on the main thread. Writes happen only in the worker.
let readDb = null;
const db = () => (readDb ||= storage.open());

// ---- scanning, off the main thread ----
// A 10 TB scan cannot block a tool call. Start a job, return immediately, poll by id.
function startScan(roots, cap) {
  const d = db();
  const now = new Date().toISOString();
  d.prepare(`insert into scan_job(root, state, started_at) values(?,?,?)`)
   .run(roots.join(' | ').slice(0, 500), 'running', now);
  const jobId = d.prepare('select last_insert_rowid() id').get().id;

  const w = new Worker(path.join(__dirname, 'worker.js'),
    { workerData: { jobId, roots, dbPath: storage.catalogPath(),
                    cap: cap || 20000, writeMarker: !NO_DRIVE_MARKER } });
  w.on('message', m => log('scan', jobId, JSON.stringify(m).slice(0, 200)));
  w.on('error', e => {
    try { d.prepare('update scan_job set state=?, error=?, finished_at=? where id=?')
           .run('failed', String(e.message), new Date().toISOString(), jobId); } catch {}
  });
  w.unref();                       // never hold the process open on a scan
  return jobId;
}

// "index everything" and "what still needs a caption" were chores dressed up as commands.
// The tool knows the index is empty; making the user say so is asking them to do its job.
// So: the first question of any kind starts the scan, and rescans happen on their own —
// they cost 4 ms when nothing changed, so there is no reason to make anyone ask.
const AUTO_RESCAN_MS = 60 * 60 * 1000;

function maybeAutoScan() {
  try {
    const d = db();
    const running = d.prepare("select count(*) n from scan_job where state='running'").get().n;
    if (running) return null;
    const assets = d.prepare('select count(*) n from asset').get().n;
    const last = d.prepare("select v from meta where k='last_scan_at'").get()?.v;
    const age = last ? Date.now() - Date.parse(last) : Infinity;

    if (assets === 0) {
      const roots = discover.discoverFast().locations.map(l => l.path);
      if (!roots.length) return null;
      const job = startScan(roots);
      stampScan(d);
      return { started: job, reason: 'first-run', roots: roots.length };
    }
    if (age > AUTO_RESCAN_MS) {
      const roots = discover.discoverFast().locations.map(l => l.path);
      if (!roots.length) return null;
      const job = startScan(roots);
      stampScan(d);
      return { started: job, reason: 'refresh', roots: roots.length };
    }
  } catch (e) { log('auto-scan skipped:', e.message); }
  return null;
}
function stampScan(d) {
  d.prepare("insert into meta(k,v) values('last_scan_at',?) on conflict(k) do update set v=excluded.v")
   .run(new Date().toISOString());
}

function scanStatus(jobId) {
  const j = db().prepare('select * from scan_job where id = ?').get(jobId);
  if (!j) return { error: `no such job ${jobId}` };
  const pct = j.found ? Math.round(100 * (j.indexed + j.skipped) / j.found) : null;
  return {
    job: j.id, state: j.state,
    found: j.found, indexed: j.indexed, skipped_unchanged_or_placeholder: j.skipped,
    percent: pct, started_at: j.started_at, finished_at: j.finished_at, error: j.error,
    hint: j.state === 'running' ? 'Still going. Ask again in a moment. Search already works on what is indexed.' : undefined,
  };
}

function probeRuntime() {
  const out = {
    node_version: process.version,
    exec_path: process.execPath,                      // ← is this Claude Desktop's bundled Node?
    bundled_by_electron: !!process.versions.electron,
    electron: process.versions.electron || null,
    platform: `${process.platform} ${process.arch}`,
    process_uptime_seconds: Math.round((Date.now() - STARTED) / 1000),
    core_module_loaded: !!core, core_load_error: coreErr,
  };
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec("create table t(a); insert into t values ('ok')");
    const round = db.prepare('select a from t').get().a;
    let fts5 = false;
    try {
      db.exec("create virtual table ft using fts5(body, tokenize='unicode61')");
      db.exec("insert into ft(body) values ('backwaters golden hour')");
      fts5 = db.prepare("select count(*) n from ft where ft match 'golden'").get().n === 1;
    } catch (e) { fts5 = 'ERROR: ' + e.message; }
    db.close();
    out.node_sqlite = { available: true, roundtrip: round, fts5_working: fts5 };
  } catch (e) {
    out.node_sqlite = { available: false, error: String(e.message),
      impact: 'Release one would need better-sqlite3 (native, per-platform) instead of one pure-JS bundle.' };
  }
  return out;
}

function probeScan(dir, limit) {
  if (!core) return { error: 'core module failed to load', detail: coreErr };
  // No path given? Find everything and index all of it. Asking "which folder?" makes the
  // user answer the question the tool exists to answer.
  const roots = dir ? [dir] : discover.discoverFast().locations.map(l => l.path);
  if (!roots.length) return { error: 'No media found anywhere.' };
  const jobId = startScan(roots, limit);
  return {
    started: true, job: jobId, locations: roots.length,
    scanning: roots.map(r => r.replace(os.homedir(), '~')),
    note: 'Running in the background. This returned immediately. Ask for status with the job id. Search works on whatever is already indexed.',
  };
}

// Can we find footage WITHOUT the user ever supplying a path? If yes, the folder
// picker becomes optional and users never meet a filesystem path at all.
// v0.0.6 checked a hardcoded list — Movies, Pictures, Desktop, Documents, Downloads —
// and so missed "~/Premire Pro Videos" entirely. Guessing folder NAMES is the same error
// as assuming tidy folders. Enumerate what exists, then rank by how much media is in it.
function probeDiscover(opts = {}) {
  const home = os.homedir();
  const CAP = opts.cap || 600, BUDGET_MS = opts.budget_ms || 20000;
  const t0 = Date.now();
  const SKIP_TOP = /^(Library|Applications|Public|\.Trash|Music|node_modules|go|Developer|AppData|NTUSER\.DAT.*|snap|\.local|\.config)$/i;

  const roots = [];
  const add = (label, p) => { try { if (fs.statSync(p).isDirectory()) roots.push({ label, path: p }); } catch {} };

  // Everything at the top of home — no name guessing.
  try {
    for (const n of fs.readdirSync(home)) {
      if (n.startsWith('.') || SKIP_TOP.test(n)) continue;
      add('home', path.join(home, n));
    }
  } catch (e) { /* home unreadable */ }
  // Every mounted volume.
  // Every mounted volume, on whichever OS this is. The boot volume is the same
  // filesystem as home, so indexing it would double the work — skip by device id.
  let bootDev = null; try { bootDev = fs.statSync(home).dev; } catch {}
  for (const vp of (core ? core.volumeRoots() : [])) {
    try { if (bootDev !== null && fs.statSync(vp).dev === bootDev) continue; } catch {}
    add('volume', vp);
  }
  // Cloud roots live under Library, which we skipped above.
  // Cloud roots differ per OS and sit under folders we skip.
  for (const c of ['Library/Mobile Documents/com~apple~CloudDocs',  // macOS iCloud
                   'OneDrive', 'OneDrive - Personal',               // Windows
                   'Nextcloud', 'ownCloud'])
    add('cloud', path.join(home, c));

  const found = [];
  let truncated = false;
  for (const r of roots) {
    if (Date.now() - t0 > BUDGET_MS) { truncated = true; break; }
    let files = [];
    try { files = core ? core.walkTree(r.path, [], 0, CAP) : []; } catch (e) { found.push({ ...r, error: e.code }); continue; }
    if (!files.length) continue;
    const byExt = {};
    let bytes = 0;
    for (const f of files) { const e = path.extname(f.p).toLowerCase(); byExt[e] = (byExt[e] || 0) + 1; bytes += f.size; }
    found.push({
      label: r.label, path: r.path,
      media_files: files.length,
      capped: files.length >= CAP,          // real count is higher
      gb: +(bytes / 1e9).toFixed(2),
      extensions: Object.fromEntries(Object.entries(byExt).sort((a, b) => b[1] - a[1]).slice(0, 6)),
      sample: files.slice(0, 3).map(f => path.basename(f.p)),
    });
  }
  found.sort((a, b) => (b.media_files || 0) - (a.media_files || 0));

  return {
    verdict: found.length
      ? `CAN DISCOVER WITHOUT A GRANT, found media in ${found.length} location(s) with no path supplied`
      : 'NO MEDIA FOUND, either nothing here, or reads are blocked',
    method: 'enumerated every top-level folder in home plus every mounted volume, then ranked by media density. No folder names are assumed.',
    scan_budget_hit: truncated,
    locations_with_media: found,
    elapsed_ms: Date.now() - t0,
    note: 'Counts marked capped:true are lower bounds, the sampler stopped early. A macOS permission dialog during this run is TCC asking on Claude Desktop\'s behalf; allowing once covers every future scan.',
  };
}

// ---------------- MCP stdio ----------------
// These descriptions are the ONLY signal that routes the model here. Vague ones lose:
// asked "find photos of people walking", Claude reached for a generic filesystem tool and
// never called Yellide at all. So each says WHEN to use it and, just as importantly, what
// it cannot answer — an agent that knows the limits asks a better question instead of
// wandering off.
const TOOLS = [
  { name: 'describe_archive', description:
      'The user\'s own photo, video and audio FILES ON THIS COMPUTER and on their drives. ALWAYS CALL ' +
      'THIS FIRST for anything like "what is in my archive", "what do I have", "find my …", "where is ' +
      'that clip", "what did I shoot in …". Note that "archive", "library" and "collection" here mean ' +
      'their MEDIA FILES, not past conversations, if there is any doubt, call this tool and find out ' +
      'rather than answering from memory. ' +
      'Returns counts, date range, cameras, drives and coverage, and tells you whether the index has been ' +
      'built yet. Do not browse the filesystem for the user\'s media: this index already knows where it all ' +
      'is, including on drives that are currently unplugged.',
    inputSchema: { type: 'object', properties: {} } },

  { name: 'search', description:
      'Search the user\'s indexed media. MATCHES ON: filename, folder and project names, camera model, lens, ' +
      'date, file kind, GPS presence, and any tags the user has added. ' +
      'DOES NOT YET MATCH IMAGE OR AUDIO CONTENT. It cannot find "people walking", "a red car" or "sunset" ' +
      'unless those words appear in a filename, folder or tag. If the user asks about content, say so plainly ' +
      'and offer what this can do instead: narrow by date, camera, location or folder, then look at the ' +
      'results together.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Plain words matched against filenames, folders, camera, tags.' },
      kind: { type: 'string', enum: ['video','audio','image'] },
      camera: { type: 'string' }, after: { type: 'string', description: 'YYYY-MM-DD' },
      before: { type: 'string', description: 'YYYY-MM-DD' },
      has_gps: { type: 'boolean' }, limit: { type: 'number' } }, required: ['query'] } },

  { name: 'get_asset', description:
      'Everything known about one file: technical metadata, every copy of it on every drive, and where each ' +
      'tag came from. Use after search, with an id from those results.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },

  { name: 'reveal', description:
      'Show the user a file: opens it in Finder/Explorer, or returns the path. If it lives on a drive that ' +
      'is not plugged in, this says which drive to fetch. That is a useful answer, not a failure.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' },
      mode: { type: 'string', enum: ['open','copy'] } }, required: ['id'] } },

  { name: 'discover', description:
      'Find WHERE the user\'s media lives, ranked by how much is in each place. Needs no path and asks the ' +
      'user nothing, never ask them which folder, they do not know, that is the problem this solves. ' +
      'Fast by default; deep:true gives exact counts.',
    inputSchema: { type: 'object', properties: { deep: { type: 'boolean' } } } },

  { name: 'scan', description:
      'Build or update the index. Needs no path. It finds everything itself. Returns IMMEDIATELY with a job ' +
      'id and runs in the background, so never wait on it. Call this when describe_archive reports an empty ' +
      'index, or when the user has added new footage. Re-scans are near-instant: unchanged files are skipped.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' } } } },

  { name: 'scan_status', description: 'Progress of a background scan. Search already works on whatever is indexed so far.',
    inputSchema: { type: 'object', properties: { job: { type: 'number' } }, required: ['job'] } },

  { name: 'export', description: 'Write the whole index to plain JSON that needs no software to read.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },

  { name: 'get_work', description:
      'What still needs a human or agent eye: one representative per shoot that has no caption yet, ' +
      'biggest shoots first. Use this to caption efficiently, a caption on a representative can be ' +
      'propagated to its whole shoot, so a dozen looks can label thousands of files.',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['image','video','audio'] }, limit: { type: 'number' } } } },

  { name: 'look', description:
      'Returns the actual images SO THAT YOU CAN SEE THEM. The user cannot, these do not render in their chat. To show THEM, call show_pictures. This is how content questions ' +
      'get answered, "people walking", "a red car", "golden hour". You look, then write what you saw with ' +
      'write_annotations, and it becomes searchable. Pass ids from get_work or search. Pass as many as you like: it fills a size budget and tells you how many did not fit, so send the rest in the next call rather than guessing a batch size.',
    inputSchema: { type: 'object', properties: {
      ids: { type: 'array', items: { type: 'number' } } }, required: ['ids'] } },

  { name: 'write_annotations', description:
      'Save what you saw. One entry per id: {id, caption, tags?, propagate?}. Set propagate:true to give the ' +
      'same caption to every other file from that shoot (same day, same camera). That is how a dozen looks ' +
      'label thousands of files. Captions are searchable the instant they are written. ' +
      'Describe only what is visible; never invent names, places or events.',
    inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'number' }, caption: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      propagate: { type: 'boolean' } }, required: ['id'] } } }, required: ['items'] } },

  { name: 'caption_next', description:
      'THE CAPTIONING LOOP. Returns the next batch of undescribed shoots together with their pictures, in ' +
      'one call. Describe each, call write_annotations with propagate:true, then call this again. Repeat ' +
      'until it reports everything described. This is how a whole archive becomes searchable by content, ' +
      'and each caption covers a whole shoot, so a few dozen batches can describe thousands of files.',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['image','video'] }, limit: { type: 'number' } } } },

  { name: 'show_pictures',
    description:
      'SHOW THE PICTURES TO THE USER. Opens a contact sheet of the actual frames in their browser, '
      + 'captioned, clickable to reveal in Finder. Use this whenever they ask to SEE anything. '
      + 'IMPORTANT: images returned by `look` go to you and are NOT visible to the user. Claude Desktop '
      + 'does not render them in the chat. Never say "shown above" after `look`; call this instead, then '
      + 'tell them you have opened it.',
    inputSchema: { type: 'object', properties: {
      ids: { type: 'array', items: { type: 'integer' }, description: 'Asset ids, up to 250. Pass the whole result set rather than curating it down; the sheet says so when it holds fewer than you sent.' },
      labels: { type: 'array', items: { type: 'string' },
        description: 'One short description per id, in the same order. If you have just looked at '
          + 'these, PASS WHAT YOU SAW, otherwise the sheet shows only a filename, which for a photo '
          + 'named 6E098553-3276.jpeg tells the user nothing.' },
      title: { type: 'string', description: 'Heading for the sheet, e.g. the query they asked.' } },
      required: ['ids'] } },
  { name: 'set_contribution',
    description:
      'Turn the website counter back on for someone who previously stopped it. ONLY call this when '
      + 'the user themselves asks for it. Never call it on your own initiative and never to answer '
      + 'for them. To stop, use stop_contributing, which also deletes their row.',
    inputSchema: { type: 'object', properties: {
      consent: { type: 'boolean', description: 'true only if they asked to turn it back on.' } },
      required: ['consent'] } },
  { name: 'import_photo_albums',
    description:
      'Free labels, no looking required. The macOS Photos app holds album names the user typed '
      + 'themselves, like "Upanayanam" or "Darjeeling, Tiger hill, Batasia loop". This reads them '
      + 'and tags the matching files so they become searchable. Albums named for a date, or for '
      + 'the app the files arrived from, are ignored. Reads the Photos library and never writes '
      + 'to it. Safe to run again; it adds only what is missing. These are tags, NOT descriptions '
      + 'of what is in each frame, so content coverage does not move and you must not say it has.',
    inputSchema: { type: 'object', properties: {} } },

  { name: 'stop_contributing',
    description: 'Stop the website counter and delete their row from it. Call whenever the user '
      + 'asks to stop, opt out, or be forgotten. Nothing further is sent, ever.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'diagnostics', description:
      'A shareable health report for when something is wrong: version, platform, capabilities, counts, ' +
      'scan errors and a plain list of likely problems. Contains NO filenames, paths, captions or search ' +
      'terms, so the user can safely paste it to whoever is helping them. Show it to them in full.',
    inputSchema: { type: 'object', properties: {} } },
];

// Claude Desktop surfaces these in its "/" menu. That menu is the closest thing this
// product has to a front door: there are no menus, no preferences and no empty state,
// so without it nobody can find out what Yellide is willing to do.
const PROMPTS = [
  { name: 'find',
    title: 'Yellide: find something',
    description: 'Search your photos and videos, by what is in them, not just the filename.',
    arguments: [{ name: 'what', description: 'e.g. the cycling event, drone shots from Kerala, March 2020', required: false }],
    build: a => `Use Yellide to find ${a.what ? `"${a.what}"` : 'something in my media'} in my photos and videos on this Mac. `
      + `Search captions and tags as well as filenames, folders, dates, camera and place. `
      + `Show me what you find with enough detail that I can tell the shots apart, and offer to open one.` },

  { name: 'index',
    title: 'Yellide: index my media',
    description: 'Find every photo and video on this Mac and build the searchable index.',
    arguments: [],
    build: () => `Use Yellide to find the media files on this Mac and index them. Do not ask me for a path, `
      + `Yellide finds them itself. Start the scan, then keep checking progress and keep going until it is `
      + `finished. Tell me what you found: how many files, across which places, and the date range.` },

  { name: 'describe',
    title: 'Yellide: describe my pictures',
    description: 'Look at the pictures and write down what is in them, so you can search by subject.',
    arguments: [],
    build: () => `Use Yellide's captioning loop to make my archive searchable by subject. Call caption_next, `
      + `look at the pictures it returns, and save what you see with write_annotations, one description per `
      + `shoot, propagated. Mark anything that looks like an identity document, medical report or legal paper `
      + `as private, by type only and never by content. Keep looping until there is nothing left to describe, `
      + `and report progress as you go. Do not stop after one batch.` },

  { name: 'archive',
    title: 'Yellide: what do I have?',
    description: 'An overview of everything indexed, including drives that are unplugged.',
    arguments: [],
    build: () => `Use Yellide to describe my archive: how many media files, where they live, the date range, `
      + `which cameras, how much has been described so far, and which drives are known but not currently `
      + `plugged in.` },

  { name: 'diagnose',
    title: 'Yellide: something is wrong',
    description: 'A health report with no filenames or search terms in it, safe to share.',
    arguments: [],
    build: () => `Run Yellide diagnostics and show me the report in full, then explain in plain words what `
      + `it means and what I should do next.` },
];

const send = m => process.stdout.write(JSON.stringify(m) + '\n');

// Array-typed user_config expands into ARGV (the pattern Anthropic's own Filesystem
// extension uses). Substituting an array into a string env var does NOT expand — v0.0.3
// received the literal "${user_config.probe_directories}" and silently scanned nothing.
// Accept argv first, fall back to env, and never treat an unexpanded template as a path.
const isTemplate = s => /^\$\{.*\}$/.test(s);
function grantedDirs() {
  const fromArgv = process.argv.slice(2);
  const fromEnv = (process.env.PROBE_DIRS || '').split(/[\n,]/);
  return [...fromArgv, ...fromEnv]
    .map(s => String(s).trim())
    .filter(s => s && !isTemplate(s) && fs.existsSync(s));
}

let buf = '';
process.stdin.on('data', c => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let req; try { req = JSON.parse(line); } catch { continue; }
    try { handle(req); } catch (e) { log('handler error', e.stack); }
  }
});

function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize')
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18',
      capabilities: { tools: {}, prompts: {} },
      serverInfo: { name: 'yellide', version: PKG_VERSION } } });
  // Claude Desktop lists these under "/". It is the only place Yellide is browsable.
  if (method === 'prompts/list')
    return send({ jsonrpc: '2.0', id, result: { prompts: PROMPTS.map(
      ({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args })) } });
  if (method === 'prompts/get') {
    const p = PROMPTS.find(x => x.name === params?.name);
    if (!p) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown prompt: ${params?.name}` } });
    return send({ jsonrpc: '2.0', id, result: { description: p.description,
      messages: [{ role: 'user', content: { type: 'text', text: p.build(params?.arguments || {}) } }] } });
  }
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const a = params?.arguments || {};
    let out;
    // A counter must never make a tool call feel slow, so this is never awaited and every
    // failure is swallowed. No-op unless the user said yes and an endpoint is configured.
    try { contribute?.maybeSend(db(), SERVER_VERSION, storage.installId(db()), log); } catch {}
    try {
      const n = params.name;
      // Text-first: results are relayed to a person, so return prose, not nested JSON.
      const asText = r => (r && typeof r.text === 'string') ? r.text : JSON.stringify(r, null, 2);
      // Every question triggers whatever housekeeping is due, before answering.
      const auto = ['describe_archive', 'search', 'get_work'].includes(n) ? maybeAutoScan() : null;
      const autoNote = auto
        ? (auto.reason === 'first-run'
            ? `\n\nI had not looked at this machine yet, so I have just started indexing ${auto.roots} places in the background. `
              + `Answers will fill in as it runs. Ask again in a moment.`
            : `\n\n(Refreshing the index in the background, new files will appear shortly.)`)
        : '';
      if (n === 'describe_archive') {
        out = asText(T.describeArchive(db())) + autoNote;
        // Asked once, ever, and only when there is a finished index worth counting.
        if (contribute?.shouldNotify(db())) {
          // Stamped here, where the notice is actually written, so nobody is counted before
          // they have been told. A notice, not a question: there is nothing to consent to.
          contribute.markTold(db());
          out += '\n\nTHEN TELL THEM THIS, ONCE. Relay it WORD FOR WORD, do not summarise it '
          + 'or rephrase it. It is a statement, not a question, so do not ask them to decide '
          + 'anything and do not call set_contribution unless they themselves ask to stop: '
          + '"Yellide adds your totals to a counter on its website, showing how much people have '
          + 'indexed and how much of it is searchable by content. That is six numbers: how many '
          + 'images, videos and audio files you have, what percentage is searchable, and how many '
          + 'descriptions exist. Never a filename, a folder, a photograph, a search term, or '
          + 'anything about your machine or where you are. If you would rather it did not, say '
          + '\'stop the Yellide counter\' and it stops."';
        }
      }
      else if (n === 'search') {
        const res = T.search(db(), a.query, a);
        // A content query with nothing to match hands back pictures, not an apology.
        if (res.blocks) return send({ jsonrpc: '2.0', id, result: { content: res.blocks } });
        out = asText(res) + autoNote;
      }
      else if (n === 'get_asset')    out = asText(T.getAsset(db(), a.id));
      else if (n === 'reveal')       out = asText(T.reveal(db(), a.id, a.mode));
      else if (n === 'export')       out = asText(T.exportIndex(db(), a.path));
      // No path is ever required: the user does not know where their media is — that is
      // the question the tool exists to answer.
      else if (n === 'scan')         out = probeScan(a.path, a.limit);
      else if (n === 'scan_status')  out = scanStatus(a.job);
      else if (n === 'discover')     out = a.deep ? discover.discoverDeep() : discover.discoverFast();
      else if (n === 'get_work')     out = asText(T.getWork(db(), a));
      else if (n === 'write_annotations') out = asText(T.writeAnnotations(db(), a.items));
      else if (n === 'caption_next') {
        return send({ jsonrpc: '2.0', id, result: { content: T.captionNext(db(), a).blocks } });
      }
      else if (n === 'look') {
        // Image blocks, not text — the agent has to actually see the picture.
        return send({ jsonrpc: '2.0', id, result: { content: T.look(db(), a.ids).blocks } });
      }
      else if (n === 'show_pictures') out = T.showPictures(db(), a.ids, { title: a.title, labels: a.labels }).text;
      else if (n === 'set_contribution') out = contribute.setConsent(db(), a.consent === true).text;
      else if (n === 'import_photo_albums') out = photos.importAlbums(db()).text;
      else if (n === 'stop_contributing') out = contribute.forget(db(), storage.installId(db()), log).text;
      else if (n === 'diagnostics')  out = T.diagnosticsReport(db(), { ...probeRuntime(), server_version: SERVER_VERSION }).text;
      else out = { error: 'unknown tool ' + n };
    } catch (e) { out = { error: String(e.message), stack: String(e.stack).split('\n').slice(0, 4) }; }
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] } });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
}

process.on('SIGTERM', () => process.exit(0));
log('ready, pid', process.pid, process.version, process.execPath);
