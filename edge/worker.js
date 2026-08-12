// Yellide contribution endpoint.
//
// Two routes and a strict allowlist. It exists so a counter on the website can say what the
// tool achieves across everyone who chose to be counted, and nothing else.
//
//   POST /contribute   one install's totals. Requires that the user switched it on.
//   GET  /stats        the aggregate the website renders. Never a single row.
//
// What this deliberately does not do:
//   - store, log or forward an IP address, and it never reads request.headers.get('cf-connecting-ip')
//   - store an operating system, hostname, locale, timezone or machine detail of any kind
//   - store a path, filename, drive label, caption or search term
//   - accept any field not named in FIELDS below. Extra keys are a hard reject, not ignored,
//     so a future client cannot quietly start sending more than this file admits to
//
// The primary key is hash(install_id + PEPPER). The install_id is random, generated on the
// user's machine, and is not stored. Without PEPPER the key cannot be derived from it.

const FIELDS = {
  install_id: 'string',
  version: 'string',
  images: 'number',
  video: 'number',
  audio: 'number',
  files_total: 'number',
  coverage: 'number',
  captions: 'number',
};

const MAX = { images: 5e7, video: 5e7, audio: 5e7, files_total: 5e7, captions: 5e7, coverage: 100 };

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });

async function keyFor(installId, pepper) {
  const bytes = new TextEncoder().encode(installId + ':' + pepper);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function validate(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'not an object';
  for (const k of Object.keys(body)) {
    if (!(k in FIELDS)) return `unexpected field: ${k}`;      // reject, never ignore
  }
  for (const [k, t] of Object.entries(FIELDS)) {
    if (typeof body[k] !== t) return `${k} must be a ${t}`;
    if (t === 'number' && (!Number.isFinite(body[k]) || body[k] < 0 || body[k] > (MAX[k] ?? 5e7)))
      return `${k} out of range`;
  }
  if (!/^\d+\.\d+\.\d+$/.test(body.version)) return 'version must be a plain semver';
  if (body.install_id.length < 8 || body.install_id.length > 64) return 'install_id length';
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = { 'access-control-allow-origin': 'https://yellide.pages.dev' };

    if (request.method === 'OPTIONS')
      return new Response(null, { headers: { ...cors, 'access-control-allow-headers': 'content-type' } });

    // ---- the aggregate the site renders --------------------------------
    if (request.method === 'GET' && url.pathname === '/stats') {
      const row = await env.DB.prepare('select * from totals').first();
      // Below a floor, a counter is a liability rather than proof, and it also stops any
      // single contributor's numbers being readable off the front page.
      const FLOOR = 12;
      const ready = row && row.installs >= FLOOR;
      return json(
        ready ? { ...row, ready: true } : { ready: false, installs: row ? row.installs : 0 },
        200,
        { ...cors, 'cache-control': 'public, max-age=3600' },
      );
    }

    // ---- one install's totals ------------------------------------------
    if (request.method === 'POST' && url.pathname === '/contribute') {
      if (Number(request.headers.get('content-length') || 0) > 2048)
        return json({ error: 'too large' }, 413, cors);

      let body;
      try { body = await request.json(); }
      catch { return json({ error: 'not json' }, 400, cors); }

      const bad = validate(body);
      if (bad) return json({ error: bad }, 400, cors);

      const id = await keyFor(body.install_id, env.PEPPER);
      const month = new Date().toISOString().slice(0, 7);
      const cov = Math.round(body.coverage);

      // One row per install. Later contributions overwrite the totals and move last_month;
      // first_month and coverage_first are written once and never updated, which is what
      // makes "captioning improves" visible without keeping any history.
      await env.DB.prepare(`
        insert into install (id_hash, first_month, last_month, version,
                             images, video, audio, files_total,
                             coverage_first, coverage_latest, captions)
        values (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9)
        on conflict(id_hash) do update set
          last_month = excluded.last_month,
          version = excluded.version,
          images = excluded.images,
          video = excluded.video,
          audio = excluded.audio,
          files_total = excluded.files_total,
          coverage_latest = excluded.coverage_latest,
          captions = excluded.captions
      `).bind(id, month, body.version, body.images, body.video, body.audio,
              body.files_total, cov, body.captions).run();

      // Nothing is returned. There is no acknowledgement worth reading, and a body would
      // invite a client to start treating this as an API.
      return new Response(null, { status: 204, headers: cors });
    }

    // ---- erasure, because DPDP grants it and it should not need an email
    if (request.method === 'POST' && url.pathname === '/forget') {
      let body;
      try { body = await request.json(); } catch { return json({ error: 'not json' }, 400, cors); }
      if (typeof body.install_id !== 'string') return json({ error: 'install_id required' }, 400, cors);
      const id = await keyFor(body.install_id, env.PEPPER);
      await env.DB.prepare('delete from install where id_hash = ?1').bind(id).run();
      return new Response(null, { status: 204, headers: cors });
    }

    return json({ error: 'not found' }, 404, cors);
  },
};
