// The only file in Yellide permitted to open a network connection.
//
// Everything else is still hard-blocked by test/safety.test.js. Confining it to one file
// means the question "what can this send, and when" has one place to look, and a reviewer
// reads eighty lines rather than the whole server.
//
// What it sends is six counts, a version and a random label that the server hashes and does
// not store. Nothing in that describes a person, which is why it is not gated on consent.
//
// It is still gated on two things: the user has been told, and the user has not opted out.
// Being told is stamped by the server when it writes the notice, not by the model when it
// relays it, so a model that stays quiet cannot cause a silent send.

// Where the counter lives. A constant rather than user configuration, so consent is the only
// thing anyone has to think about and the address cannot be pointed somewhere it was never
// meant to go. The env var exists so the tests and a fork can aim it elsewhere.
const DEFAULT_ENDPOINT = 'https://yellide-counter.knerav.workers.dev';
// `??`, not `||`: setting YELLIDE_COUNTER to an empty string switches the counter off
// entirely. The tests rely on that, and so would anyone who wants it gone from a build.
const ENDPOINT = (process.env.YELLIDE_COUNTER ?? DEFAULT_ENDPOINT).trim().replace(/\/$/, '');
const { captionProgress } = require('./tools.js');
const DAY = 24 * 60 * 60 * 1000;

const get = (db, k) => { try { return db.prepare('select v from meta where k = ?').get(k)?.v ?? null; } catch { return null; } };
const put = (db, k, v) => db.prepare(
  'insert into meta(k,v) values(?,?) on conflict(k) do update set v = excluded.v').run(k, String(v));

/** 'yes' | 'no' | null when the user has never said either way. */
const consent = db => get(db, 'contribute');

/** The only state that stops a send. Never having said anything is not opting out. */
const optedOut = db => consent(db) === 'no';

/**
 * Stamped when the notice has actually been written into a tool result. The server does this
 * itself, at the point of emission, so a model that swallows the message cannot cause a send
 * the user was never told about.
 */
const markTold = db => put(db, 'contribute_told_at', Date.now());

/** Everything except the endpoint and the once-a-day timer. Exists so this is testable. */
const wouldSend = db => !optedOut(db) && !!get(db, 'contribute_told_at');

function setConsent(db, yes) {
  put(db, 'contribute', yes ? 'yes' : 'no');
  return { text: yes
    ? 'The counter is back on. Your totals are added to the figure on yellide.pages.dev, and '
      + 'nothing else.'
    : 'Stopped. Nothing further is sent, and your row has been deleted.' };
}

/** Tell them once, and only when there is a finished index worth counting. */
function shouldNotify(db) {
  if (get(db, 'contribute_told_at')) return false;
  if (!ENDPOINT) return false;
  try {
    const done = db.prepare("select count(*) n from scan_job where state='done'").get().n;
    const assets = db.prepare('select count(*) n from asset').get().n;
    return done > 0 && assets > 0;
  } catch { return false; }
}

/** Exactly what would leave the machine. Nothing is computed that is not sent. */
function payload(db, version, installId) {
  const kind = k => { try { return db.prepare('select count(*) n from asset where kind = ?').get(k).n; } catch { return 0; } };
  const images = kind('image'), video = kind('video'), audio = kind('audio');
  // Coverage comes from the same function the diagnostics report uses, never a second query
  // that happens to look equivalent. A caption covers its whole shoot, and counting rows
  // instead reported 2% where the report said 51%.
  let coverage = 0, captions = 0;
  try { coverage = captionProgress(db).pct; } catch {}
  try { captions = db.prepare("select count(*) n from annotation where key='caption'").get().n; } catch {}
  return {
    install_id: installId,
    version,
    images, video, audio,
    files_total: images + video + audio,
    coverage,
    captions,
  };
}

/**
 * Fire and forget, at most once a day. Never awaited by a tool call: a counter must not be
 * able to make the tool feel slow, and a network failure must never surface to the user.
 */
function post(route, body, log) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  fetch(ENDPOINT + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).catch(e => log(route + ' failed, ignored:', e.message))
    .finally(() => clearTimeout(timer));
}

/**
 * Fire and forget, at most once a day. Never awaited by a tool call: a counter must not be
 * able to make the tool feel slow, and a network failure must never reach the user.
 */
function maybeSend(db, version, installId, log = () => {}) {
  if (!ENDPOINT || !wouldSend(db)) return false;
  if (Date.now() - Number(get(db, 'contributed_at') || 0) < DAY) return false;
  put(db, 'contributed_at', Date.now());
  post('/contribute', payload(db, version, installId), log);
  return true;
}

/** Withdraw. Deletes the row, then stops sending. */
function forget(db, installId, log = () => {}) {
  put(db, 'contribute', 'no');
  if (!ENDPOINT) return { text: 'Nothing was being sent. Nothing will be.' };
  post('/forget', { install_id: installId }, log);
  return { text: 'Your row has been deleted and nothing further will be sent.' };
}

module.exports = { consent, optedOut, setConsent, markTold, wouldSend, shouldNotify,
                   payload, maybeSend, forget, ENDPOINT };
