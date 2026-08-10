// Yellide promises it never modifies, moves, renames or deletes your files.
//
// A promise on a website is worth nothing. This turns it into a build gate: every
// destructive filesystem call and every external command in server/ must appear in the
// allowlist below, with a target and a reason. Add one that is not listed and the build
// fails — pack.sh will not produce a bundle.
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
  { file: 'storage.js', call: 'writeFileSync', what: '.yellide/volume-id — one random identifier, so a renamed drive is still recognised' },
  { file: 'index.js',   call: 'unlinkSync',    what: 'a scratch database in os.tmpdir() named with this process id' },
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
      else fail.push(`${f}:${i + 1}  ${call}()  — not in the allowlist\n      ${line.trim()}`);
    }
  });
}

// No shell. execFile with an argv array cannot be tricked by a filename containing ";rm -rf".
for (const f of files) {
  const src = fs.readFileSync(path.join(SERVER, f), 'utf8');
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (/shell\s*:\s*true/.test(code)) fail.push(`${f}:${i + 1}  spawns a shell`);
    if (/\bexecSync\s*\(/.test(code)) fail.push(`${f}:${i + 1}  execSync — use execFile with an argv array`);
    // child_process exec() takes a shell string; db.exec() is SQLite and is fine
    if (/(?<!db\.)(?<!\.)\bexec\s*\(\s*['"`]/.test(code) && !/db\.exec/.test(code))
      fail.push(`${f}:${i + 1}  exec() with a string — use execFile with an argv array`);
    if (/\beval\s*\(|new\s+Function\s*\(/.test(code)) fail.push(`${f}:${i + 1}  evaluates a string as code`);
  });
}

// An allowlist entry that no longer matches anything is rot. Say so.
for (const a of ALLOWED) {
  if (!seen.has(a.file + ':' + a.call))
    fail.push(`allowlist entry no longer used: ${a.file} ${a.call}() — remove it`);
}

if (fail.length) {
  console.error('\nSAFETY CHECK FAILED\n');
  fail.forEach(m => console.error('  ' + m));
  console.error('\nYellide tells people it never modifies, moves, renames or deletes their');
  console.error('files. Either that is still true and this belongs in the allowlist with a');
  console.error('reason, or it is no longer true and the website must stop saying it.\n');
  process.exit(1);
}

console.log(`safety: ${files.length} files, ${seen.size} justified writes, no shell, no eval`);
for (const a of ALLOWED) console.log(`  ${a.file.padEnd(12)} ${(a.call + '()').padEnd(16)} ${a.what}`);
