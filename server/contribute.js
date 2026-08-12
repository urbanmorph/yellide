// The only file in Yellide permitted to open a network connection.
//
// Everything else is still hard-blocked by test/safety.test.js. Confining it to one file
// means the question "what can this send, and when" has one place to look, and a reviewer
// reads eighty lines rather than the whole server.
//
// It sends nothing unless BOTH are true:
//   1. the user said yes when asked, once, after their first index finished
//   2. YELLIDE_COUNTER names an endpoint
//
// With no endpoint configured this file is inert. That is the shipped default.

// Where the counter lives. Empty means this file is inert, which is the shipped default
// until the Worker in edge/ is deployed. It is a constant rather than user configuration
// so that consent is the only thing a user has to think about, and a URL cannot be pointed
// somewhere it was never meant to go.
const DEFAULT_ENDPOINT = '';
const ENDPOINT = (process.env.YELLIDE_COUNTER || DEFAULT_ENDPOINT).trim().replace(/\/$/, '');
const { captionProgress } = require('./tools.js');
const DAY = 24 * 60 * 60 * 1000;

const get = (db, k) => { try { return db.prepare('select v from meta where k = ?').get(k)?.v ?? null; } catch { return null; } };
const put = (db, k, v) => db.prepare(
  'insert into meta(k,v) values(?,?) on conflict(k) do update set v = excluded.v').run(k, String(v));

/** 'yes' | 'no' | null when never asked. */
const consent = db => get(db, 'contribute');

/**
 * Recorded when the question has actually been put into a tool result. Yellide has no screen,
 * so the question reaches the user through Claude, which makes set_contribution a tool a model
 * can call unprompted. This is the one thing the server can check for itself.
 */
const markAsked = db => put(db, 'contribute_asked_at', Date.now());

function setConsent(db, yes) {
  // A yes nobody was asked for is not consent. A no never needs proving.
  if (yes && !get(db, 'contribute_asked_at')) {
    return { text: 'Yellide has not put that question to you yet, so nothing has been turned on. '
      + 'It will ask once, by itself, after your first index finishes.' };
  }
  put(db, 'contribute', yes ? 'yes' : 'no');
  return { text: yes
    ? 'Thank you. Your totals will be added to the counter on yellide.pages.dev, and nothing else. '
      + 'You can stop at any time by saying so, and the row is deleted.'
    : 'Nothing will be sent. Yellide will not ask again.' };
}

/** Ask once, and only when there is something worth contributing. */
function shouldAsk(db) {
  if (consent(db) !== null) return false;
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
  if (consent(db) !== 'yes' || !ENDPOINT) return false;
  if (Date.now() - Number(get(db, 'contributed_at') || 0) < DAY) return false;
  put(db, 'contributed_at', Date.now());
  post('/contribute', payload(db, version, installId), log);
  return true;
}

/** Withdraw. Deletes the row, then stops sending. */
function forget(db, installId, log = () => {}) {
  put(db, 'contribute', 'no');
  if (!ENDPOINT) return { text: 'Nothing was being sent. Yellide will not ask again.' };
  post('/forget', { install_id: installId }, log);
  return { text: 'Your row has been deleted and nothing further will be sent.' };
}

module.exports = { consent, setConsent, markAsked, shouldAsk, payload, maybeSend, forget, ENDPOINT };
