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
  for (const root of roots) {
    const t0 = Date.now();
    let r;
    try {
      r = core.scan(db, root, { cap, writeMarker, onProgress: p => {
        progress.run(found + p.indexed, indexed + p.indexed, skipped + p.unchanged + p.placeholders, jobId);
        parentPort?.postMessage({ type: 'progress', root, indexed: indexed + p.indexed });
      }});
    } catch (e) {
      perRoot.push({ root, error: e.code || e.message });
      continue;
    }
    found += r.found; indexed += r.indexed;
    skipped += (r.unchanged || 0) + (r.placeholders || 0);
    perRoot.push({ root, found: r.found, indexed: r.indexed, unchanged: r.unchanged,
                   placeholders: r.placeholders, missing: r.missing, ms: Date.now() - t0 });
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
