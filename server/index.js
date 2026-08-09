#!/usr/bin/env node
// Yellide — MCP server. Runs entirely inside Claude Desktop's own Node runtime: scan → identity → Tier 0 metadata → node:sqlite → FTS5 → search.
// Read-only against your footage. The index goes to a temp file. Nothing is uploaded.
//
// stdout is the MCP protocol. Nothing may ever be written to it except JSON-RPC.
const os = require('os'), path = require('path'), fs = require('fs');
const { Worker } = require('worker_threads');
const log = (...a) => process.stderr.write('[yellide] ' + a.join(' ') + '\n');

const SERVER_VERSION = '0.9.5';
const STARTED = Date.now();
let core = null, coreErr = null, storage = null, discover = null, T = null;
try {
  core = require('./core.js');
  storage = require('./storage.js');
  discover = require('./discover.js');
  T = require('./tools.js');
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
    { workerData: { jobId, roots, dbPath: storage.catalogPath(), cap: cap || 20000 } });
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

// The caption backlog is housekeeping. Surface it as an offer in the answer, so the user
// never has to know the phrase "get_work".
function backlogNote(d) {
  try {
    const n = d.prepare(`select count(*) n from (
      select 1 from asset a join location l on l.asset_id=a.id and l.state='present'
      where a.kind='image' and not exists (select 1 from annotation x where x.asset_id=a.id and x.key='caption')
      group by substr(coalesce(a.shot_at_local,a.shot_at),1,10), a.camera)`).get().n;
    if (!n) return '';
    return `\n\n${n} shoot${n === 1 ? '' : 's'} have no description yet, so searching by what is *in* a ` +
           `picture will not find them. Offer to look through them — call get_work, then look, then ` +
           `write_annotations with propagate:true. A dozen looks can describe thousands of files.`;
  } catch { return ''; }
}

function scanStatus(jobId) {
  const j = db().prepare('select * from scan_job where id = ?').get(jobId);
  if (!j) return { error: `no such job ${jobId}` };
  const pct = j.found ? Math.round(100 * (j.indexed + j.skipped) / j.found) : null;
  return {
    job: j.id, state: j.state,
    found: j.found, indexed: j.indexed, skipped_unchanged_or_placeholder: j.skipped,
    percent: pct, started_at: j.started_at, finished_at: j.finished_at, error: j.error,
    hint: j.state === 'running' ? 'Still going — ask again in a moment. Search already works on what is indexed.' : undefined,
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
    note: 'Running in the background — this returned immediately. Ask for status with the job id. Search works on whatever is already indexed.',
  };
}

function probeSearch(dir, query) {
  if (!core) return { error: 'core module failed to load' };
  const allRoots = dir ? [dir] : (probeDiscover({ cap: 400, budget_ms: 25000 }).locations_with_media || []).map(l => l.path);
  const dbPath = path.join(os.tmpdir(), `yellide-probe-q-${process.pid}.db`);
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
  const db = core.openDb(dbPath);
  for (const rt of allRoots) { try { core.scan(db, rt, 2000); } catch {} }
  const hits = core.search(db, query, 10);
  db.close();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + s); } catch {} }
  return { query, hit_count: hits.length, hits };
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
      ? `CAN DISCOVER WITHOUT A GRANT — found media in ${found.length} location(s) with no path supplied`
      : 'NO MEDIA FOUND — either nothing here, or reads are blocked',
    method: 'enumerated every top-level folder in home plus every mounted volume, then ranked by media density. No folder names are assumed.',
    scan_budget_hit: truncated,
    locations_with_media: found,
    elapsed_ms: Date.now() - t0,
    note: 'Counts marked capped:true are lower bounds — the sampler stopped early. A macOS permission dialog during this run is TCC asking on Claude Desktop\'s behalf; allowing once covers every future scan.',
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
      'their MEDIA FILES, not past conversations — if there is any doubt, call this tool and find out ' +
      'rather than answering from memory. ' +
      'Returns counts, date range, cameras, drives and coverage, and tells you whether the index has been ' +
      'built yet. Do not browse the filesystem for the user\'s media: this index already knows where it all ' +
      'is, including on drives that are currently unplugged.',
    inputSchema: { type: 'object', properties: {} } },

  { name: 'search', description:
      'Search the user\'s indexed media. MATCHES ON: filename, folder and project names, camera model, lens, ' +
      'date, file kind, GPS presence, and any tags the user has added. ' +
      'DOES NOT YET MATCH IMAGE OR AUDIO CONTENT — it cannot find "people walking", "a red car" or "sunset" ' +
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
      'is not plugged in, this says which drive to fetch — that is a useful answer, not a failure.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' },
      mode: { type: 'string', enum: ['open','copy'] } }, required: ['id'] } },

  { name: 'discover', description:
      'Find WHERE the user\'s media lives, ranked by how much is in each place. Needs no path and asks the ' +
      'user nothing — never ask them which folder, they do not know, that is the problem this solves. ' +
      'Fast by default; deep:true gives exact counts.',
    inputSchema: { type: 'object', properties: { deep: { type: 'boolean' } } } },

  { name: 'scan', description:
      'Build or update the index. Needs no path — it finds everything itself. Returns IMMEDIATELY with a job ' +
      'id and runs in the background, so never wait on it. Call this when describe_archive reports an empty ' +
      'index, or when the user has added new footage. Re-scans are near-instant: unchanged files are skipped.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, limit: { type: 'number' } } } },

  { name: 'scan_status', description: 'Progress of a background scan. Search already works on whatever is indexed so far.',
    inputSchema: { type: 'object', properties: { job: { type: 'number' } }, required: ['job'] } },

  { name: 'export', description: 'Write the whole index to plain JSON that needs no software to read.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },

  { name: 'get_work', description:
      'What still needs a human or agent eye: one representative per shoot that has no caption yet, ' +
      'biggest shoots first. Use this to caption efficiently — a caption on a representative can be ' +
      'propagated to its whole shoot, so a dozen looks can label thousands of files.',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['image','video','audio'] }, limit: { type: 'number' } } } },

  { name: 'look', description:
      'SHOW ME THE PICTURES. Returns the actual images so you can see them. This is how content questions ' +
      'get answered — "people walking", "a red car", "golden hour" — you look, then write what you saw with ' +
      'write_annotations, and it becomes searchable. Pass ids from get_work or search. Max 12 at a time.',
    inputSchema: { type: 'object', properties: {
      ids: { type: 'array', items: { type: 'number' } } }, required: ['ids'] } },

  { name: 'write_annotations', description:
      'Save what you saw. One entry per id: {id, caption, tags?, propagate?}. Set propagate:true to give the ' +
      'same caption to every other file from that shoot (same day, same camera) — that is how a dozen looks ' +
      'label thousands of files. Captions are searchable the instant they are written. ' +
      'Describe only what is visible; never invent names, places or events.',
    inputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'number' }, caption: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      propagate: { type: 'boolean' } }, required: ['id'] } } }, required: ['items'] } },

  { name: 'caption_next', description:
      'THE CAPTIONING LOOP. Returns the next batch of undescribed shoots together with their pictures, in ' +
      'one call. Describe each, call write_annotations with propagate:true, then call this again. Repeat ' +
      'until it reports everything described. This is how a whole archive becomes searchable by content — ' +
      'and each caption covers a whole shoot, so a few dozen batches can describe thousands of files.',
    inputSchema: { type: 'object', properties: {
      kind: { type: 'string', enum: ['image','video'] }, limit: { type: 'number' } } } },

  { name: 'diagnostics', description:
      'A shareable health report for when something is wrong: version, platform, capabilities, counts, ' +
      'scan errors and a plain list of likely problems. Contains NO filenames, paths, captions or search ' +
      'terms, so the user can safely paste it to whoever is helping them. Show it to them in full.',
    inputSchema: { type: 'object', properties: {} } },
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
function configProblem() {
  const raw = [...process.argv.slice(2), process.env.PROBE_DIRS || ''].filter(Boolean);
  if (raw.some(isTemplate))
    return { error: 'No folder is configured yet.',
             detail: 'Claude Desktop passed the placeholder through unexpanded, which means nothing was picked.',
             fix: 'Settings → Extensions → Yellide Probe → Configure → Browse, and choose a footage folder.',
             workaround: 'Or call this tool with an explicit path, e.g. probe_scan with path "/Users/you/Movies".',
             raw_value_received: raw };
  return { error: 'No folder is configured yet.',
           fix: 'Settings → Extensions → Yellide Probe → Configure → Browse.',
           workaround: 'Or pass an explicit path to this tool.' };
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
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'yellide', version: '0.1.0' } } });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'tools/call') {
    const a = params?.arguments || {}, dir = a.path || grantedDirs()[0];
    let out;
    try {
      const n = params.name;
      // Text-first: results are relayed to a person, so return prose, not nested JSON.
      const asText = r => (r && typeof r.text === 'string') ? r.text : JSON.stringify(r, null, 2);
      // Every question triggers whatever housekeeping is due, before answering.
      const auto = ['describe_archive', 'search', 'get_work'].includes(n) ? maybeAutoScan() : null;
      const autoNote = auto
        ? (auto.reason === 'first-run'
            ? `\n\nI had not looked at this machine yet, so I have just started indexing ${auto.roots} places in the background. `
              + `Answers will fill in as it runs — ask again in a moment.`
            : `\n\n(Refreshing the index in the background — new files will appear shortly.)`)
        : '';
      if (n === 'describe_archive') out = asText(T.describeArchive(db())) + autoNote;
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
      else if (n === 'diagnostics')  out = T.diagnosticsReport(db(), { ...probeRuntime(), server_version: SERVER_VERSION }).text;
      else out = { error: 'unknown tool ' + n };
    } catch (e) { out = { error: String(e.message), stack: String(e.stack).split('\n').slice(0, 4) }; }
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] } });
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
}

process.on('SIGTERM', () => process.exit(0));
log('ready, pid', process.pid, process.version, process.execPath);
