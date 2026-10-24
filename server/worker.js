// Yellide — the scan worker.
//
// Node is single-threaded. Scanning hashes 2 MB per file, parses containers and writes
// SQLite; on the main thread every one of those blocks the MCP stdio loop, so the agent
// appears to hang mid-conversation — the worst possible failure, because it reads as the
// model's fault rather than ours.
//
// Main thread  : stdio loop only, never heavy I/O
// This worker  : walk, hash, parse, write
// Shared state : SQLite, not postMessage — which also makes a scan crash-resumable,
//                because its progress was never held in memory.
const { parentPort, workerData } = require('worker_threads');
const core = require('./core.js');
const storage = require('./storage.js');

const { jobId, roots, dbPath, cap, writeMarker } = workerData;
const db = storage.open(dbPath);

const setJob = db.prepare(`update scan_job set state=?, found=?, indexed=?, skipped=?,
                           finished_at=?, error=? where id=?`);
const progress = db.prepare('update scan_job set found=?, indexed=?, skipped=? where id=?');

let found = 0, indexed = 0, skipped = 0;
const perRoot = [];

try {
  // List every root before reading any, so the whole archive is searchable by name within
  // minutes, not after the last file of the last drive has been hashed.
  const listed = new Map();
  for (const root of roots) {
    try {
      const l = core.inventory(db, root, { cap, writeMarker });
      listed.set(root, l);
      found += l.files.length;
      progress.run(found, indexed, skipped, jobId);
      parentPort?.postMessage({ type: 'listed', root, files: l.files.length, new: l.listed });
    } catch (e) { perRoot.push({ root, error: e.code || e.message }); }
  }
  // Everything is searchable by name now; a question waiting on the scan can be answered.
  parentPort?.postMessage({ type: 'listed-all', files: found });
  for (const root of roots) {
    if (!listed.has(root)) continue;
    const t0 = Date.now();
    let r;
    try {
      r = core.scan(db, root, { cap, writeMarker, listed: listed.get(root), onProgress: p => {
        progress.run(found, indexed + p.indexed, skipped + p.unchanged + p.placeholders, jobId);
        parentPort?.postMessage({ type: 'progress', root, indexed: indexed + p.indexed });
      }});
    } catch (e) {
      perRoot.push({ root, error: e.code || e.message });
      continue;
    }
    indexed += r.indexed;
    skipped += (r.unchanged || 0) + (r.placeholders || 0);
    perRoot.push({ root, found: r.found, listed: r.listed, indexed: r.indexed, unchanged: r.unchanged,
                   placeholders: r.placeholders, photos_only_in_icloud: r.photos, missing: r.missing,
                   ms: Date.now() - t0 });
    listed.delete(root);                       // its file list is no longer needed
    progress.run(found, indexed, skipped, jobId);
    // Let the parent narrate progress without it having to poll the database.
    parentPort?.postMessage({ type: 'progress', root, found, indexed, skipped });
  }
  setJob.run('done', found, indexed, skipped, new Date().toISOString(), null, jobId);
  parentPort?.postMessage({ type: 'done', found, indexed, skipped, perRoot });
} catch (e) {
  setJob.run('failed', found, indexed, skipped, new Date().toISOString(), String(e.message), jobId);
  parentPort?.postMessage({ type: 'failed', error: String(e.message) });
} finally {
  db.close();
}
