// The manifest's tool list is what Claude Desktop shows, and what pack.sh and plan-stats.py
// count. It must be the tools the server actually answers with.
//
// The count used to come from a regex over index.js, which also matched the `what` argument
// of the `find` prompt and reported 18 tools while there were 17.
//
//   node test/manifest.test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0;
const check = (name, fn) => {
  try { fn(); console.log('  pass  ' + name); passed++; }
  catch (e) { console.error('  FAIL  ' + name + '\n        ' + e.message); process.exitCode = 1; }
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'yellide-manifest-'));
const rpc = [
  { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
].map(m => JSON.stringify(m)).join('\n') + '\n';

// A throwaway data dir and a dead counter address, so this touches nothing real.
const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
  input: rpc, timeout: 8000, encoding: 'utf8',
  env: { ...process.env, YELLIDE_HOME: home, YELLIDE_COUNTER: 'http://127.0.0.1:9' },
});
const reply = run.stdout.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } })
  .find(m => m && m.id === 2);
const served = reply ? reply.result.tools.map(t => t.name).sort() : [];
const listed = require('../manifest.json').tools.map(t => t.name).sort();

check('the server answered tools/list', () => {
  assert.ok(served.length, 'no tools/list reply. stderr: ' + (run.stderr || '').slice(-300));
});

check('the manifest lists exactly the tools the server serves', () => {
  assert.deepStrictEqual(listed, served,
    `manifest only: ${listed.filter(n => !served.includes(n))}; ` +
    `server only: ${served.filter(n => !listed.includes(n))}`);
});

fs.rmSync(home, { recursive: true, force: true });
if (!process.exitCode) console.log(`\n  manifest: ${passed} checks pass (${served.length} tools)`);
