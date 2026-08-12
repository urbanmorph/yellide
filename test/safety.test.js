// Yellide promises it never modifies, moves, renames or deletes your files.
//
// A promise on a website is worth nothing. This turns it into a build gate: every
// destructive filesystem call and every external command in server/ must appear in the
// allowlist below, with a target and a reason. Add one that is not listed and the build
// fails, and pack.sh will not produce a bundle.
//
// It exists because people have lost years of work to automated tools, and "trust us" is
// not an answer anyone should accept.
//
//   node test/safety.test.js

const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..', 'server');
const files = fs.readdirSync(SERVER).filter(f => f.endsWith('.js'));

// Anything here writes, deletes or renames. If it is not in ALLOWED, the build stops.
const DESTRUCTIVE = [
  'unlinkSync', 'unlink', 'rmSync', 'rmdirSync', 'rmdir',
  'renameSync', 'rename', 'truncateSync', 'ftruncateSync',
  'writeFileSync', 'writeFile', 'appendFileSync', 'appendFile',
  'copyFileSync', 'copyFile', 'createWriteStream',
  'chmodSync', 'chownSync', 'utimesSync', 'mkdirSync', 'mkdtempSync',
];

// Every one of these was read, understood and justified. Keep it that way.
const ALLOWED = [
  { file: 'vision.js',  call: 'unlinkSync',    what: 'a temp JPEG this process just created in os.tmpdir(), named with its own pid' },
  { file: 'vision.js',  call: 'rmSync',        what: 'a temp directory this process just created in os.tmpdir(), named with its own pid' },
  { file: 'vision.js',  call: 'mkdirSync',     what: 'that same temp directory' },
  { file: 'storage.js', call: 'mkdirSync',     what: "the app's own data directory, and the .yellide folder on an indexed volume" },
  { file: 'storage.js', call: 'writeFileSync', what: '.yellide/volume-id, one random identifier, so a renamed drive is still recognised' },
  { file: 'tools.js',   call: 'writeFileSync', what: 'the export JSON the user asked for, and the contact sheet in the app data directory' },
  { file: 'tools.js',   call: 'mkdirSync',     what: 'the contact-sheet directory inside the app data directory' },
];

const fail = [];
const seen = new Set();

for (const f of files) {
  const src = fs.readFileSync(path.join(SERVER, f), 'utf8');
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');          // ignore comments
    for (const call of DESTRUCTIVE) {
      // only a real call: fs.x( or destructured x(
      if (!new RegExp('(?:\\bfs\\.|\\b)' + call + '\\s*\\(').test(code)) continue;
      if (/^\s*(\*|\/\/)/.test(line)) continue;
      const ok = ALLOWED.find(a => a.file === f && a.call === call);
      if (ok) seen.add(f + ':' + call);
      else fail.push(`${f}:${i + 1}  ${call}()  is not in the allowlist\n      ${line.trim()}`);
    }
  });
}

// Nothing phones home. /privacy states this three times and invites people to check it,
// so it is checked here rather than asserted there. No transport, no client, no URL.
const NETWORK = [
  "require('http')", 'require("http")', "require('https')", 'require("https")',
  "require('node:http')", "require('node:https')", "require('net')", "require('node:net')",
  "require('dgram')", "require('node:dgram')", "require('dns')", "require('node:dns')",
  "require('tls')", "require('node:tls')", "require('http2')", "require('node:http2')",
];
// Exactly one file may talk to the network: contribute.js, which sends the counter totals
// and only after the user has said yes. Confining it means "what can this send, and when"
// has one place to look. Everything else stays hard-blocked, which is the point.
const NETWORK_ALLOWED = 'contribute.js';

for (const f of files) {
  if (f === NETWORK_ALLOWED) continue;
  const src = fs.readFileSync(path.join(SERVER, f), 'utf8');
  src.split('\n').forEach((line, i) => {
    const t = line.trimStart();
    if (t.startsWith('//') || t.startsWith('*')) return;      // a URL in a comment is fine
    const code = line.replace(/\/\/.*$/, '');
    for (const n of NETWORK)
      if (code.includes(n)) fail.push(`${f}:${i + 1}  ${n} . Only contribute.js may reach the network`);
    if (/\bfetch\s*\(/.test(code)) fail.push(`${f}:${i + 1}  fetch() . Only contribute.js may reach the network`);
    if (/\b(XMLHttpRequest|WebSocket|EventSource)\b/.test(code))
      fail.push(`${f}:${i + 1}  a network client . Only contribute.js may reach the network`);
    if (/['"`]https?:\/\//.test(code))
      fail.push(`${f}:${i + 1}  a URL in code . Only contribute.js may reach the network`);
  });
}

// No shell. execFile with an argv array cannot be tricked by a filename containing ";rm -rf".
for (const f of files) {
  const src = fs.readFileSync(path.join(SERVER, f), 'utf8');
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/shell\s*:\s*true/.test(code)) fail.push(`${f}:${i + 1}  spawns a shell`);
    if (/\bexecSync\s*\(/.test(code)) fail.push(`${f}:${i + 1}  execSync. Use execFile with an argv array`);
    // child_process exec() takes a shell string; db.exec() is SQLite and is fine
    if (/(?<!db\.)(?<!\.)\bexec\s*\(\s*['"`]/.test(code) && !/db\.exec/.test(code))
      fail.push(`${f}:${i + 1}  exec() with a string. Use execFile with an argv array`);
    if (/\beval\s*\(|new\s+Function\s*\(/.test(code)) fail.push(`${f}:${i + 1}  evaluates a string as code`);
  });
}

// The permitted file earns its exemption only while it stays reviewable and keeps its guard.
{
  const src = fs.readFileSync(path.join(SERVER, NETWORK_ALLOWED), 'utf8');
  const lines = src.split('\n').length;
  if (lines > 140) fail.push(`${NETWORK_ALLOWED} is ${lines} lines. The one file allowed to `
    + 'reach the network must stay short enough that someone will actually read it.');
  // The counter sends no personal data, so it is not gated on consent. It is gated on two
  // things that must both survive any refactor: the user has been told, and the user has not
  // opted out. Lose either and Yellide is counting people who were never told, or people who
  // asked it to stop. Both are on /privacy as promises.
  if (!/const optedOut = db => consent\(db\) === 'no'/.test(src))
    fail.push(`${NETWORK_ALLOWED} no longer honours opting out.`);
  if (!/const wouldSend = db => !optedOut\(db\) && !!get\(db, 'contribute_told_at'\)/.test(src))
    fail.push(`${NETWORK_ALLOWED} no longer requires the user to have been told first.`);
  if (!/if \(!ENDPOINT \|\| !wouldSend\(db\)\) return false;/.test(src))
    fail.push(`${NETWORK_ALLOWED} sends without checking wouldSend().`);
  if (!/ENDPOINT = \(process\.env\.YELLIDE_COUNTER/.test(src))
    fail.push(`${NETWORK_ALLOWED} no longer takes its endpoint from the environment, so it `
      + 'could reach somewhere the user never configured.');
  // Counting captions is the payload. Reading their values, or any path, is not.
  for (const banned of ['filename', 'rel_path', '.root', 'select value', 'value from annotation'])
    if (src.includes(banned)) fail.push(`${NETWORK_ALLOWED} reads ${banned}. The payload is counts `
      + 'only and must never touch content or paths.');
}

// The repository is public. A secret in a tracked file is a rotation and an apology, so
// the build refuses rather than letting one through. .env.local and .dev.vars are ignored;
// this catches the case where that stops being true, or a value is pasted somewhere else.
{
  const { execSync } = require('child_process');
  let tracked = [];
  try {
    tracked = execSync('git ls-files', { cwd: path.join(SERVER, '..'), encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch {}
  const SECRET = [
    [/CLOUDFLARE_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}/, 'a Cloudflare token'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
    [/\bsk-[A-Za-z0-9]{20,}/, 'an API key'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS key'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
    [/\bPEPPER\s*[=:]\s*["']?[A-Za-z0-9_+/-]{16,}/, 'the counter pepper'],
  ];
  const root = path.join(SERVER, '..');
  for (const f of tracked) {
    if (/\.(png|jpg|jpeg|webp|woff2|ico|mcpb|svg)$/.test(f)) continue;
    let src = '';
    try { src = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
    for (const [re, what] of SECRET)
      if (re.test(src)) fail.push(`${f} contains ${what}. This repository is public: remove it, `
        + 'then rotate the credential, because it may already be pushed.');
  }
  for (const f of ['.env.local', '.dev.vars', '.env'])
    if (tracked.includes(f)) fail.push(`${f} is tracked by git. It must be ignored.`);
}

// An allowlist entry that no longer matches anything is rot. Say so.
for (const a of ALLOWED) {
  if (!seen.has(a.file + ':' + a.call))
    fail.push(`allowlist entry no longer used: ${a.file} ${a.call}(), remove it`);
}

// The one thing Yellide writes to a user's drive must be refusable, and the refusal must
// actually reach the code that writes it. Verified on a real mounted volume by hand; this
// keeps the wiring from rotting without needing one.
{
  const storage = require('../server/storage.js');
  const core = require('../server/core.js');
  const os = require('os');
  const real = storage.volumeMarker;
  let called = false;
  storage.volumeMarker = (...a) => { called = true; return real(...a); };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yl-consent-'));
  fs.writeFileSync(path.join(dir, 'x.jpg'), Buffer.alloc(1024));
  const dbp = path.join(os.tmpdir(), 'yl-consent-' + process.pid + '.db');
  try {
    const db = storage.open(dbp);
    core.scan(db, dir, { cap: 5, writeMarker: false });
    db.close();
  } catch (e) { fail.push('consent check could not run: ' + e.message); }
  for (const sfx of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbp + sfx); } catch {} }
  fs.rmSync(dir, { recursive: true, force: true });
  storage.volumeMarker = real;

  if (called) fail.push('writeMarker:false still reached storage.volumeMarker(). '
    + 'The opt-out on /privacy and in the extension settings would be a lie.');
}

if (fail.length) {
  console.error('\nSAFETY CHECK FAILED\n');
  fail.forEach(m => console.error('  ' + m));
  console.error('\nYellide tells people it never modifies, moves, renames or deletes their');
  console.error('files. Either that is still true and this belongs in the allowlist with a');
  console.error('reason, or it is no longer true and the website must stop saying it.\n');
  process.exit(1);
}

console.log(`safety: ${files.length} files, ${seen.size} justified writes, no shell, no eval,`
  + ` drive marker refusable, network only in contribute.js, no tracked secrets`);
for (const a of ALLOWED) console.log(`  ${a.file.padEnd(12)} ${(a.call + '()').padEnd(16)} ${a.what}`);
