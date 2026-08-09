// Yellide — the real tool surface.
//
// Output is TEXT, not JSON. These results are read aloud by an agent to a person, and a
// nested object relays badly. Structured data is returned alongside for anything that
// needs to parse, but the text is the product.
const fs = require('fs'), path = require('path'), os = require('os');
const { execFile } = require('child_process');

const tilde = p => String(p || '').replace(os.homedir(), '~');
const fmtDur = s => {
  if (s == null) return null;
  const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};
const fmtSize = b => b == null ? '' : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB';
const day = s => (s || '').slice(0, 10);

// After a rename the old path lingers as `missing` beside the new `present` one. Both are
// true history, but "where is this?" must answer with somewhere it actually is.
function locationsFor(db, assetId) {
  const rows = db.prepare(`select rel_path, root, filename, state, last_seen_at
                           from location where asset_id = ? order by
                           case state when 'present' then 0 when 'offline' then 1 else 2 end,
                           last_seen_at desc`).all(assetId);
  const live = rows.filter(r => r.state === 'present' || r.state === 'offline');
  return { best: (live[0] || rows[0]) || null, all: rows, live: live.length };
}
const fullPath = loc => loc ? path.join(loc.root, loc.rel_path.split('/').join(path.sep)) : null;

// ---------------------------------------------------------------- describe_archive
function describeArchive(db) {
  const a = db.prepare(`select count(*) files, sum(size) bytes, sum(duration_s) secs from asset`).get();
  // A single corrupt EXIF date must not define the archive's date range. Trim the ends.
  const dated = db.prepare(`select coalesce(shot_at_local, shot_at) d from asset
                            where coalesce(shot_at_local, shot_at) is not null order by d`).all();
  const cut = Math.floor(dated.length * 0.005);
  a.first = dated.length ? dated[cut].d : null;
  a.last  = dated.length ? dated[dated.length - 1 - cut].d : null;
  const outliers = dated.length ? dated.filter(r => r.d < a.first || r.d > a.last).length : 0;
  if (!a.files) return { text: 'Nothing indexed yet.', empty: true };

  const kinds = db.prepare('select kind, count(*) n, sum(size) b from asset group by kind order by n desc').all();
  const cams  = db.prepare(`select camera, count(*) n from asset where camera is not null
                            group by camera order by n desc limit 6`).all();
  const vols  = db.prepare(`select v.label, v.last_seen_at, count(l.id) n
                            from volume v join location l on l.volume_id = v.id
                            group by v.id having n > 0 order by n desc`).all();
  const roots = db.prepare(`select root, count(*) n from location where state='present'
                            group by root order by n desc limit 8`).all();
  const cov = db.prepare(`select
      round(100.0*sum(case when coalesce(shot_at_local,shot_at) is not null then 1 else 0 end)/count(*)) date_pct,
      round(100.0*sum(case when camera is not null then 1 else 0 end)/count(*)) cam_pct,
      round(100.0*sum(case when gps is not null then 1 else 0 end)/count(*)) gps_pct
    from asset`).get();
  const states = db.prepare('select state, count(*) n from location group by state').all();
  const untagged = db.prepare(`select count(*) n from asset a
      where not exists (select 1 from annotation n2 where n2.asset_id=a.id and n2.key='project')`).get().n;
  const humanTags = db.prepare("select count(*) n from annotation where source='human'").get().n;

  const L = [];
  L.push(`${a.files.toLocaleString()} files · ${fmtSize(a.bytes)}${a.secs ? ' · ' + (a.secs >= 3600 ? Math.round(a.secs/3600) + ' hours' : Math.round(a.secs/60) + ' minutes') + ' of media' : ''}`);
  L.push(`Kinds     ${kinds.map(k => `${k.kind} ${k.n.toLocaleString()}`).join(' · ')}`);
  if (a.first) L.push(`Dates     ${day(a.first)} → ${day(a.last)}` +
    (outliers ? `  (${outliers} file${outliers === 1 ? '' : 's'} with implausible dates excluded)` : ''));
  if (cams.length) L.push(`Cameras   ${cams.map(c => `${c.camera} (${c.n})`).join(' · ')}`);
  if (vols.length) L.push(`Drives    ${vols.map(v => `${v.label} (${v.n.toLocaleString()} files, last seen ${day(v.last_seen_at)})`).join(' · ')}`);
  L.push(`Where     ${roots.map(r => `${tilde(r.root)} ${r.n.toLocaleString()}`).join(' · ')}`);
  L.push(`Coverage  date ${cov.date_pct}% · camera ${cov.cam_pct}% · GPS ${cov.gps_pct}%`);
  const missing = states.find(s => s.state === 'missing')?.n || 0;
  const ph = states.find(s => s.state === 'dematerialised')?.n || 0;
  if (missing) L.push(`Missing   ${missing.toLocaleString()} files are indexed but no longer on disk — I still know what they were and where they lived`);
  if (ph) L.push(`Cloud     Separately, ${ph.toLocaleString()} MORE files exist only as iCloud/Dropbox placeholders and ` +
                 `are NOT part of the ${a.files.toLocaleString()} above. They were deliberately never opened, ` +
                 `because reading one downloads it. Everything counted above is a real local file`);
  const shoots = db.prepare(`select count(*) total,
      sum(case when described > 0 then 1 else 0 end) done from (
        select substr(coalesce(a.shot_at_local,a.shot_at),1,10) d, a.camera c,
               sum(case when exists (select 1 from annotation x where x.asset_id=a.id and x.key='caption') then 1 else 0 end) described
        from asset a where a.kind in ('image','video') group by d, c)`).get();
  const captioned = db.prepare(`select count(distinct asset_id) n from annotation
                                where key in ('caption','shoot_caption')`).get().n;
  const pg = captionProgress(db);
  const undone = pg.shoots_left;
  L.push(`Described ${pg.files_described.toLocaleString()} of ${pg.files_total.toLocaleString()} images and ` +
         `videos (${pg.pct}%) can be searched by what is in them. The rest are findable by name, date, ` +
         `camera and folder only.`);
  if (undone > 0 && pg.worth_continuing) L.push(
    `\nEND YOUR REPLY WITH EXACTLY THIS OFFER, in your own words but keeping the numbers: ` +
    `"${pg.pct}% of your photos and videos can be searched by content. I can raise that to about ` +
    `${Math.min(99, pg.pct + Math.round(100 * pg.next_3_batches_cover / pg.files_total))}% in a few minutes ` +
    `— shall I?" If they agree, call caption_next and then write_annotations for EVERY picture you are ` +
    `shown, looping until coverage stops rising meaningfully. Describing a picture without calling ` +
    `write_annotations wastes the work entirely — the description is lost the moment this chat ends. ` +
    `Do not quote shoot counts; ${pg.singletons_left.toLocaleString()} remaining shoots are single files.`);
  else if (undone > 0) L.push(
    `\nNOTE: ${pg.pct}% of images and videos are described, and the remaining ${undone.toLocaleString()} ` +
    `shoots average only ${pg.avg_remaining} files each — the next three batches would cover just ` +
    `${pg.next_3_batches_cover} files. **Tell the user the useful work is done** and that further ` +
    `captioning is low value unless they want a specific folder covered. Do not start another pass ` +
    `unasked.`);
  L.push(`Tagging   ${untagged.toLocaleString()} have no project yet · ${humanTags} tags you have confirmed`);

  return { text: L.join('\n'),
           data: { files: a.files, bytes: a.bytes, kinds, cameras: cams, volumes: vols, coverage: cov } };
}

// ---------------------------------------------------------------- search
function search(db, query, opts = {}) {
  // "Nothing matched" on an empty index is a lie by omission — it reads as "you don't have
  // that", when the truth is "I haven't looked yet".
  if (!db.prepare('select count(*) n from asset').get().n)
    return { text: 'The index has not been built yet, so there is nothing to search. Run a scan first — ' +
                   'it finds your media by itself and takes a few minutes. Search works on whatever is ' +
                   'indexed while it runs.', empty_index: true, data: [] };
  const limit = Math.min(opts.limit || 20, 100);
  const where = [], args = [];
  let sql = `select a.*, bm25(search) rank from search
             join asset a on a.id = search.asset_id where search match ?`;
  args.push(String(query || '').normalize('NFC'));
  if (opts.kind)   { where.push('a.kind = ?');  args.push(opts.kind); }
  if (opts.camera) { where.push('a.camera like ?'); args.push('%' + opts.camera + '%'); }
  if (opts.after)  { where.push('coalesce(a.shot_at_local, a.shot_at) >= ?'); args.push(opts.after); }
  if (opts.before) { where.push('coalesce(a.shot_at_local, a.shot_at) <= ?'); args.push(opts.before); }
  if (opts.has_gps) where.push('a.gps is not null');
  if (where.length) sql += ' and ' + where.join(' and ');
  sql += ' order by rank limit ?'; args.push(limit);

  const runOn = table => {
    const q = sql.replace(/\bsearch\b/g, table);
    try { return db.prepare(q).all(...args); } catch { return null; }
  };
  let exact, stemmed;
  try { exact = runOn('search'); }
  catch (e) { return { text: `That query didn't parse: ${e.message}. Try plain words.`, data: [] }; }
  if (exact === null) return { text: `That query didn't parse. Try plain words.`, data: [] };
  stemmed = runOn('search_en') || [];

  // Reciprocal rank fusion, k=60. Exact matches outrank stemmed ones; stemmed recall
  // catches "garland" → "garlands" without letting the stemmer near Indic text.
  const score = new Map(), keep = new Map();
  const fuse = (list, weight) => list.forEach((r, i) => {
    score.set(r.id, (score.get(r.id) || 0) + weight / (60 + i));
    if (!keep.has(r.id)) keep.set(r.id, r);
  });
  fuse(exact, 1.0); fuse(stemmed, 0.85);

  // Described content outranks accidental filename matches.
  const described = new Set(db.prepare(
    `select distinct asset_id id from annotation where key in ('caption','shoot_caption','tag')
       and source in ('human','agent')`).all().map(r => r.id));
  const humanSet = new Set(db.prepare(
    "select distinct asset_id id from annotation where source='human'").all().map(r => r.id));
  for (const [id, v] of score) {
    let boost = 1;
    if (described.has(id)) boost *= 1.6;     // somebody actually looked at this
    if (humanSet.has(id)) boost *= 1.4;      // and a person confirmed it
    score.set(id, v * boost);
  }
  let rows = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => keep.get(id));

  const total = (() => {
    try {
      const filt = where.length ? ' and ' + where.join(' and ') : '';
      const fargs = args.slice(1, args.length - 1);          // drop the match term and LIMIT
      const q = String(query || '').normalize('NFC');
      const ids = new Set();
      for (const tbl of ['search', 'search_en']) {
        const rows = db.prepare(
          `select ${tbl}.asset_id id from ${tbl} join asset a on a.id = ${tbl}.asset_id
           where ${tbl} match ?${filt}`).all(q, ...fargs);
        for (const r of rows) ids.add(r.id);
      }
      return ids.size;
    } catch { return rows.length; }
  })();

  if (!rows.length) {
    const hint = db.prepare(`select value, count(*) n from annotation where key in ('project','folder')
                             group by value order by n desc limit 6`).all().map(r => r.value);
    const work = getWork(db, { kind: 'image', limit: 6 });
    if (work.data && work.data.length) {
      const shown = look(db, work.data.map(w => w.id));
      const covered = work.data.reduce((n, w) => n + (w.cluster_size || 1), 0);
      return {
        text: `Nothing matched "${query}" — but that is because most of this archive has never been ` +
              `described, so there are no words to match against.`,
        blocks: [
          { type: 'text', text:
            `Nothing matched "${query}".\n\nThat is not a "you don't have it" — it is a "nobody has ever ` +
            `written down what is in these". Here are ${work.data.length} shoots that have never been ` +
            `described, covering about ${covered} files. Look at them, then call write_annotations with a ` +
            `caption for each and propagate:true. Then run the same search again — it will work.` },
          ...shown.blocks,
        ],
        data: [], needs_captions: true };
    }
    return { text: `Nothing matched "${query}".` +
      (hint.length ? `\n\nThings that do exist here: ${hint.join(' · ')}` : ''), data: [] };
  }

  const out = rows.map((r, i) => {
    const { best, live, all } = locationsFor(db, r.id);
    const bits = [day(r.shot_at_local || r.shot_at), fmtDur(r.duration_s),
                  r.width ? `${r.width}×${r.height}` : null, r.camera, fmtSize(r.size)].filter(Boolean);
    const state = best?.state === 'present' ? '' :
                  best?.state === 'missing' ? '  ⚠ not on disk any more' :
                  best?.state === 'dematerialised' ? '  ☁ in the cloud, not downloaded' : '';
    const extra = all.length > live && live > 0 ? `  (+${all.length - live} old path${all.length - live > 1 ? 's' : ''})` : '';
    return `${i + 1}. ${best?.filename || '(unknown)'} — ${bits.join(' · ')}${state}\n` +
           `   ${tilde(fullPath(best))}${extra}`;
  });

  const head = total > rows.length
    ? `${rows.length} of ${total} matches for "${query}" (best first)`
    : `${rows.length} match${rows.length === 1 ? '' : 'es'} for "${query}"`;
  return { text: head + '\n\n' + out.join('\n'), data: rows.map(r => ({ id: r.id, filename: r.camera })),
           truncated: total > rows.length, total };
}

// ---------------------------------------------------------------- get_asset
function getAsset(db, id) {
  const a = db.prepare('select * from asset where id = ?').get(id);
  if (!a) return { text: `No asset ${id}.` };
  const { all } = locationsFor(db, id);
  const anns = db.prepare(`select key, value, source, confirmed_at from annotation
                           where asset_id = ? order by
                           case source when 'human' then 0 when 'agent' then 1 else 2 end`).all(id);
  const L = [];
  L.push(`${all[0]?.filename || '(unknown)'}  ·  ${a.kind}`);
  const tech = [fmtDur(a.duration_s), a.width ? `${a.width}×${a.height}` : null, a.camera, a.lens,
                a.iso ? `ISO ${a.iso}` : null, a.fnumber ? `f/${a.fnumber}` : null,
                a.sample_rate ? `${a.sample_rate} Hz` : null, fmtSize(a.size)].filter(Boolean);
  if (tech.length) L.push(tech.join(' · '));
  if (a.shot_at_local || a.shot_at) L.push(`Shot      ${a.shot_at_local || a.shot_at}${a.shot_at_local && a.shot_at ? `  (UTC ${a.shot_at.slice(0, 19)})` : ''}`);
  if (a.gps) L.push(`Location  ${a.gps}`);
  L.push('');
  L.push('Copies:');
  for (const l of all) L.push(`  ${l.state === 'present' ? '•' : l.state === 'missing' ? '⚠' : '☁'} ${tilde(fullPath(l))}  [${l.state}]`);
  if (anns.length) {
    L.push('');
    L.push('Tags:');
    for (const t of anns) L.push(`  ${t.key} = ${t.value}   (${t.source}${t.confirmed_at ? ', confirmed' : ''})`);
  }
  return { text: L.join('\n'), data: { asset: a, locations: all, annotations: anns } };
}

// ---------------------------------------------------------------- reveal
function reveal(db, id, mode = 'open') {
  const { best } = locationsFor(db, id);
  if (!best) return { text: `No asset ${id}.` };
  const p = fullPath(best);
  if (best.state !== 'present') {
    const vol = db.prepare('select v.label from location l join volume v on v.id=l.volume_id where l.id=?').get(best.id);
    return { text: `Not available right now — it was last seen at ${tilde(p)}` +
      (vol?.label ? ` on the drive "${vol.label}"` : '') +
      `. ${best.state === 'missing' ? 'The file is no longer there.' : 'That drive is not mounted.'}`,
      path: p, state: best.state };
  }
  if (mode === 'copy') return { text: `Path copied:\n${p}`, path: p };
  const cmd = process.platform === 'darwin' ? ['open', ['-R', p]]
            : process.platform === 'win32'  ? ['explorer', ['/select,' + p]]
            : ['xdg-open', [path.dirname(p)]];
  try { execFile(cmd[0], cmd[1], () => {}); } catch {}
  return { text: `Opened in ${process.platform === 'darwin' ? 'Finder' : 'the file manager'}:\n${p}`, path: p };
}

// ---------------------------------------------------------------- export
function exportIndex(db, outPath, opts = {}) {
  const out = outPath || path.join(os.homedir(), 'yellide-index.json');
  const assets = db.prepare('select * from asset').all();
  const locs = db.prepare('select * from location').all();
  let anns = db.prepare('select * from annotation').all();

  // Anything marked private leaves as a bare type. Keeping "PET-CT scan findings" or
  // "Aadhaar card" in a file you might send someone discloses health status, identity
  // documents and property holdings — the labels are useful locally and unsafe to share.
  const privateIds = new Set(anns.filter(a => a.key === 'private').map(a => a.asset_id));
  let redacted = 0;
  if (opts.includePrivate !== true) {
    anns = anns.filter(a => {
      if (!privateIds.has(a.asset_id)) return true;
      if (a.key === 'private') return true;
      return false;                       // drop captions and tags on private items
    });
    for (const id of privateIds) { anns.push({ asset_id: id, key: 'caption', value: 'private document', source: 'redacted' }); redacted++; }
  }
  const byAsset = new Map();
  for (const a of assets) byAsset.set(a.id, { ...a, locations: [], tags: [] });
  for (const l of locs) byAsset.get(l.asset_id)?.locations.push({ root: l.root, rel_path: l.rel_path, state: l.state });
  for (const t of anns) byAsset.get(t.asset_id)?.tags.push({ key: t.key, value: t.value, source: t.source });
  const doc = { format: 'yellide-index', version: 1, exported_at: new Date().toISOString(),
                count: assets.length, assets: [...byAsset.values()] };
  doc.redacted_private = redacted;
  fs.writeFileSync(out, JSON.stringify(doc, null, 1));
  return { text: `Exported ${assets.length.toLocaleString()} assets to ${tilde(out)}\n` +
    `Plain JSON — no part of it needs Yellide to read. This is your escape hatch.` +
    (redacted ? `\n${redacted} item${redacted === 1 ? '' : 's'} marked private were reduced to ` +
                `"private document" — their descriptions stay on this machine only.` : ''), path: out };
}

module.exports = { describeArchive, search, getAsset, reveal, exportIndex, locationsFor, fullPath };

// Peers = same shoot. Dated files share a day+camera; undated ones share a folder.
// Never both, and never the null-metadata bucket, which is not a shoot at all.
function shootPeers(db, id) {
  const me = db.prepare(`select a.id, a.camera, a.shot_at_local, a.shot_at, l.root, l.rel_path
                         from asset a join location l on l.asset_id=a.id and l.state='present'
                         where a.id = ? limit 1`).get(id);
  if (!me) return [];
  const k = shootKey(me);
  if (k.startsWith('x:')) return [];
  const rows = db.prepare(`select a.id, a.camera, a.shot_at_local, a.shot_at, l.root, l.rel_path
                           from asset a join location l on l.asset_id=a.id and l.state='present'
                           where a.kind in ('image','video') and a.id != ?`).all(id);
  return rows.filter(r => shootKey(r) === k).map(r => ({ id: r.id }));
}

function remainingShoots(db) {
  try { return allShoots(db).filter(g => !g.done).length; } catch { return 0; }
}

// Progress that tells the truth: how many FILES are still undescribed, how much the next
// few batches would actually cover, and whether continuing is still worth the money.
function captionProgress(db) {
  const g = allShoots(db);
  const done = g.filter(x => x.done), left = g.filter(x => !x.done).sort((a, b) => b.size - a.size);
  const total = g.reduce((a, x) => a + x.size, 0);
  const covered = done.reduce((a, x) => a + x.size, 0);
  const next3 = left.slice(0, 18).reduce((a, x) => a + x.size, 0);   // 3 batches of 6
  const singles = left.filter(x => x.size === 1).length;
  return {
    files_total: total, files_described: covered,
    pct: total ? Math.round(100 * covered / total) : 0,
    shoots_left: left.length, files_left: total - covered,
    next_3_batches_cover: next3,
    singletons_left: singles,
    avg_remaining: left.length ? +(((total - covered) / left.length)).toFixed(1) : 0,
    worth_continuing: next3 >= 150,      // below this, each batch buys very little
  };
}

// A whole archive gets described a batch at a time. This returns the next unlabelled
// shoots AND their pictures in one call, so the agent can loop: caption_next → write →
// caption_next, without a round trip in between.
function captionNext(db, opts = {}) {
  const n = Math.min(opts.limit || 6, 10);
  const work = getWork(db, { kind: opts.kind, limit: n });
  if (!work.data || !work.data.length) {
    return { blocks: [{ type: 'text', text: 'Everything has been described. Nothing left to look at.' }] };
  }
  const shown = look(db, work.data.map(w => w.id));
  const covered = work.data.reduce((a, w) => a + (w.cluster_size || 1), 0);
  const pg = captionProgress(db);
  return { blocks: [
    { type: 'text', text:
      `Here are ${work.data.length} shoots nobody has looked at, covering about ${covered} files.\n\n` +
      `For EACH picture: describe it, then call write_annotations with {id, caption, tags, propagate:true}. ` +
      `**A description you only write in your reply is thrown away** — nothing is saved unless ` +
      `write_annotations is called. The caption then covers that whole shoot. Then call caption_next again.\n` +
      `Progress: ${pg.files_described.toLocaleString()} of ${pg.files_total.toLocaleString()} files ` +
      `(${pg.pct}%) are described. Report percentages, never shoot counts — most remaining shoots are ` +
      `single files, so a shoot count wildly overstates what is left.` },
    ...shown.blocks,
  ], remaining_files: pg.files_left };
}

// ============================================================ looking at pictures
// The agent is the interviewer, not the indexer: it should look at a handful of
// representatives, not 9,000 files. get_work picks them; look shows them; the captions
// come back through write_annotations and become searchable immediately.
const vision = require('./vision.js');

// One representative per shoot (same day + camera), unlabelled ones first. Labelling a
// representative is worth ~N files, because the label propagates to its cluster.
// A "shoot" is a set of files that genuinely belong together, because a caption written
// for one gets propagated to all of them.
//   dated files   → same calendar day + same camera
//   undated files → same folder
// Grouping undated files by (null day, null camera) put 3,194 unrelated files — 36% of a
// real archive — into ONE cluster. Propagating into that would have described thousands of
// files wrongly, which is worse than not describing them at all.
function shootKey(row) {
  const t = row.shot_at_local || row.shot_at;
  if (t) return 'd:' + String(t).slice(0, 10) + '|' + (row.camera || '');
  const i = row.rel_path.lastIndexOf('/');
  return i > 0 ? 'f:' + row.root + '/' + row.rel_path.slice(0, i) : 'x:' + row.id;  // loose file = its own shoot
}

function allShoots(db, kind) {
  const rows = db.prepare(`select a.id, a.kind, a.camera, a.shot_at_local, a.shot_at,
                                  a.width, a.height, l.filename, l.root, l.rel_path,
                                  exists(select 1 from annotation n where n.asset_id=a.id and n.key='caption') done
                           from asset a join location l on l.asset_id = a.id and l.state='present'
                           where a.kind in ('image','video')` +
                          (kind ? ' and a.kind = ?' : '')).all(...(kind ? [kind] : []));
  const map = new Map();
  for (const r of rows) {
    const k = shootKey(r);
    let g = map.get(k);
    if (!g) map.set(k, g = { key: k, rep: r, size: 0, done: 0, is_shot: r.camera ? 1 : 0 });
    g.size++; if (r.done) g.done++;
    if (r.camera) g.is_shot = 1;
  }
  return [...map.values()];
}

function getWork(db, opts = {}) {
  const limit = Math.min(opts.limit || 12, 40);
  const shoots = allShoots(db, opts.kind)
    .filter(g => !g.done)
    .sort((a, b) => b.is_shot - a.is_shot || b.size - a.size)
    .slice(0, limit);
  if (!shoots.length) return { text: 'Nothing left to look at — every shoot already has a description.', data: [] };
  const rows = shoots.map(g => ({ ...g.rep, cluster_size: g.size,
                                  day: (g.rep.shot_at_local || g.rep.shot_at || '').slice(0, 10) }));
  const lines = rows.map(r =>
    `id ${r.id}  ${r.filename}  ·  ${r.day || 'undated'}  ·  ${r.camera || 'no camera'}  ·  ` +
    `represents ${r.cluster_size} file${r.cluster_size === 1 ? '' : 's'}`);
  return { text: `${rows.length} shoots with no description yet.\n\n` + lines.join('\n'), data: rows };
}

// Returns real image content blocks, so the agent actually sees the pictures.
function look(db, ids) {
  const cap = vision.capability();
  if (!cap.ok) return { blocks: [{ type: 'text', text: cap.reason }] };
  const list = (Array.isArray(ids) ? ids : [ids]).slice(0, 12);
  const blocks = [];
  let shown = 0, skipped = 0;
  for (const id of list) {
    const a = db.prepare('select id, kind from asset where id = ?').get(id);
    if (!a) { skipped++; continue; }
    if (a.kind !== 'image' && a.kind !== 'video') { blocks.push({ type: 'text', text: `id ${id}: ${a.kind} has no picture to show.` }); skipped++; continue; }
    const { best } = locationsFor(db, id);
    if (!best || best.state !== 'present') { blocks.push({ type: 'text', text: `id ${id}: not on disk right now.` }); skipped++; continue; }
    const b64 = a.kind === 'video' ? vision.videoFrame(fullPath(best)) : vision.thumbnail(fullPath(best));
    if (!b64) { skipped++; continue; }
    blocks.push({ type: 'text', text: `id ${id} — ${best.filename}` });
    blocks.push({ type: 'image', data: b64, mimeType: 'image/jpeg' });
    shown++;
  }
  blocks.push({ type: 'text', text: `${shown} shown${skipped ? `, ${skipped} skipped` : ''}. ` +
    `Describe what you actually see — subjects, action, setting, light. Then call write_annotations ` +
    `with one caption per id. Say only what is visible; do not guess names, places or events.\n\n` +
    `PRIVACY — this matters, personal archives contain more than photographs. If an image is a ` +
    `document, ID card, bank record, cheque, contract, prescription or screenshot of private data: ` +
    `describe only its TYPE (e.g. "scanned bank document", "identity card") and set private:true. ` +
    `Never transcribe account numbers, addresses, phone numbers, names from documents, or any ` +
    `identifying detail — the index is searchable and exportable, and anything written here can leave ` +
    `the machine with it.` });
  return { blocks };
}

// Captions and tags land here. They must become searchable immediately, or a caption is
// written and then cannot be found — which is the whole point.
function writeAnnotations(db, items) {
  const list = Array.isArray(items) ? items : [items];
  const now = new Date().toISOString();
  const ins = db.prepare('insert into annotation(asset_id,key,value,source,confidence,created_at) values(?,?,?,?,?,?)');
  const del = db.prepare('delete from annotation where asset_id = ? and key = ? and source = ?');
  let n = 0, propagated = 0;
  db.exec('begin');
  try {
    for (const it of list) {
      const id = it.id ?? it.asset_id;
      const a = db.prepare('select id, camera, substr(coalesce(shot_at_local,shot_at),1,10) day from asset where id = ?').get(id);
      if (!a) continue;
      if (it.private) {
        // Every copy of the same bytes, and every near-copy by filename, inherits privacy.
        const me = db.prepare('select content_key from asset where id = ?').get(id);
        const same = me ? db.prepare('select id from asset where content_key = ?').all(me.content_key) : [{ id }];
        for (const a2 of same) {
          del.run(a2.id, 'private', 'agent');
          ins.run(a2.id, 'private', 'true', 'agent', null, now);
          // strip anything descriptive that may already have spread to this copy
          db.prepare("delete from annotation where asset_id = ? and key in ('caption','shoot_caption','tag') and source = 'agent' and asset_id != ?").run(a2.id, id);
          reindex(db, a2.id);
        }
        n++;
      }
      const pairs = it.caption ? [['caption', it.caption], ...(it.tags || []).map(t => ['tag', t])]
                              : Object.entries(it).filter(([k]) => !['id','asset_id','propagate'].includes(k));
      for (const k of new Set(pairs.map(([k]) => k))) del.run(id, k, 'agent');
      for (const [k, v] of pairs) {
        if (v == null || v === '') continue;
        ins.run(id, k, String(v), 'agent', it.confidence ?? null, now);
        n++;
      }
      reindex(db, id);

      // A private item describes only itself. Propagating "identity card (Aadhaar)" to its
      // shoot would put that description on files never marked private, defeating redaction.
      if (it.propagate && it.private) { /* never spread a private description */ }
      else if (it.propagate) {
        const peers = shootPeers(db, id);
        for (const p of peers) {
          for (const k of new Set(pairs.map(([k]) => k === 'caption' ? 'shoot_caption' : k))) del.run(p.id, k, 'agent');
          for (const [k, v] of pairs) {
            if (k !== 'caption' && k !== 'tag') continue;
            ins.run(p.id, k === 'caption' ? 'shoot_caption' : k, String(v), 'agent', 0.6, now);
          }
          reindex(db, p.id); propagated++;
        }
      }
    }
    db.exec('commit');
  } catch (e) { db.exec('rollback'); return { text: 'Nothing written: ' + e.message }; }
  const pg = captionProgress(db);
  return { text: `Wrote ${n} annotation${n === 1 ? '' : 's'}` +
    (propagated ? `, and propagated them to ${propagated} more files from the same shoots` : '') +
    `. These are searchable now.` +
    (pg.files_left
      ? `\n\n${pg.files_described.toLocaleString()} of ${pg.files_total.toLocaleString()} files ` +
        `(${pg.pct}%) are now described. Call caption_next for the next batch and keep going — do not stop ` +
        `to ask between batches, and do not summarise each one. Report percentages, never shoot counts.`
      : `\n\nThat was the last one — everything is described.`) };
}

// Rebuild one FTS row so a new caption is findable the moment it is written.
function reindex(db, assetId) {
  const a = db.prepare('select * from asset where id = ?').get(assetId);
  if (!a) return;
  const loc = db.prepare('select filename, rel_path from location where asset_id = ? limit 1').get(assetId);
  // Anything marked private is indexed by type only — never by its contents.
  const isPrivate = db.prepare("select 1 p from annotation where asset_id = ? and key = 'private'").get(assetId);
  const tags = isPrivate ? ['private document']
    : db.prepare('select value from annotation where asset_id = ?').all(assetId).map(r => r.value);
  const body = [loc?.filename, loc?.rel_path?.split('/').join(' '), a.camera, a.lens, a.kind, a.brand,
                a.title, a.artist, a.description,
                (a.shot_at_local || a.shot_at || '').slice(0, 10), ...tags]
               .filter(Boolean).join(' ').normalize('NFC');
  db.prepare('delete from search where asset_id = ?').run(assetId);
  db.prepare('insert into search(body, asset_id) values(?,?)').run(body, assetId);
  try {
    db.prepare('delete from search_en where asset_id = ?').run(assetId);
    db.prepare('insert into search_en(body, asset_id) values(?,?)').run(body, assetId);
  } catch {}
}

module.exports.getWork = getWork;
module.exports.captionNext = captionNext;
module.exports.captionProgress = captionProgress;
module.exports.look = look;
module.exports.writeAnnotations = writeAnnotations;
module.exports.reindex = reindex;
module.exports.visionCapability = vision.capability;


// ============================================================ diagnostics
// A remote user with no telemetry is a user we cannot help. This produces a report they
// can READ before sending — counts, timings, errors, capabilities. No paths, no filenames,
// no captions, no queries. Consent-based by construction: it is text they choose to paste.
function diagnosticsReport(db, runtime) {
  const q = (sql, d = 0) => { try { return db.prepare(sql).get().n; } catch { return d; } };
  const pg = (() => { try { return captionProgress(db); } catch { return {}; } })();
  const cap = vision.capability();
  const L = [];
  const add = (k, v) => L.push(k.padEnd(22) + v);

  L.push('YELLIDE DIAGNOSTIC REPORT');
  L.push('Contains no filenames, paths, captions or search terms. Safe to share.');
  L.push('');
  add('version', (runtime && runtime.server_version) || 'unknown');
  add('node', (runtime && runtime.node_version) || process.version);
  add('platform', (runtime && runtime.platform) || (process.platform + ' ' + process.arch));
  add('bundled runtime', runtime && runtime.bundled_by_electron ? 'yes (host app)' : 'no (system node)');
  add('schema version', q('select max(v) n from schema_version'));
  add('can view pictures', cap.ok ? 'yes — ' + cap.via : 'NO — ' + (cap.reason || '').slice(0, 60));
  add('can view video', cap.video || 'no');
  L.push('');
  add('assets indexed', q('select count(*) n from asset').toLocaleString());
  add('  video/audio/image', ['video','audio','image'].map(k =>
        q("select count(*) n from asset where kind='" + k + "'")).join(' / '));
  add('locations', q('select count(*) n from location').toLocaleString());
  add('  missing', q("select count(*) n from location where state='missing'"));
  add('  cloud placeholders', q("select count(*) n from location where state='dematerialised'"));
  add('annotations', q('select count(*) n from annotation').toLocaleString());
  add('  captions', q("select count(*) n from annotation where key='caption'"));
  add('  private items', q("select count(*) n from annotation where key='private'"));
  add('content coverage', (pg.pct != null ? pg.pct + '%' : 'unknown') +
      ' (' + (pg.files_described || 0) + ' of ' + (pg.files_total || 0) + ')');
  L.push('');

  const jobs = (() => { try {
    return db.prepare('select state, count(*) n, max(finished_at) last from scan_job group by state').all();
  } catch { return []; } })();
  add('scans', jobs.length ? jobs.map(j => j.state + '=' + j.n).join(' ') : 'none recorded');
  const failed = (() => { try {
    return db.prepare("select error from scan_job where error is not null order by id desc limit 3").all();
  } catch { return []; } })();
  if (failed.length) { L.push(''); L.push('recent scan errors:'); failed.forEach(f => L.push('  ' + String(f.error).slice(0, 120))); }

  let dbBytes = 0;
  try { const fsx = require('fs'), st = require('./storage.js');
        for (const x of ['', '-wal']) { try { dbBytes += fsx.statSync(st.catalogPath() + x).size; } catch {} } } catch {}
  L.push('');
  add('index size', (dbBytes / 1e6).toFixed(1) + ' MB');

  // The most useful single signal: is anything obviously wrong?
  const problems = [];
  if (!q('select count(*) n from asset')) problems.push('Nothing indexed — the scan has not run or found nothing.');
  if (!cap.ok) problems.push('Cannot view pictures on this platform, so content descriptions are unavailable.');
  if (q("select count(*) n from scan_job where state='failed'")) problems.push('At least one scan failed — see errors above.');
  L.push('');
  L.push(problems.length ? 'LIKELY PROBLEMS:\n  - ' + problems.join('\n  - ')
                         : 'No obvious problems detected.');
  return { text: L.join('\n') };
}
module.exports.diagnosticsReport = diagnosticsReport;

// ---------------------------------------------------------------------------
// showPictures — put the actual frames in front of the PERSON.
//
// `look` returns MCP image blocks, which go to the model and never reach the
// human: Claude Desktop feeds them to the model and renders nothing in the
// chat. The model then says "shown above" and the user sees prose about
// photographs they cannot see. For a tool about footage that is the whole
// interaction failing, so we write a contact sheet and open it.
//
// Self-contained HTML with the thumbnails inlined as data URIs — no server, no
// network, nothing to clean up but one file.
function showPictures(db, ids, opts = {}) {
  const cap = vision.capability();
  if (!cap.ok) return { text: cap.reason };

  const list = (Array.isArray(ids) ? ids : [ids]).slice(0, 60);
  const cards = [];
  let missing = 0;
  for (const id of list) {
    const a = db.prepare('select id, kind, shot_at from asset where id = ?').get(id);
    if (!a || (a.kind !== 'image' && a.kind !== 'video')) { missing++; continue; }
    const { best } = locationsFor(db, id);
    if (!best || best.state !== 'present') { missing++; continue; }
    const p = fullPath(best);
    const b64 = a.kind === 'video' ? vision.videoFrame(p) : vision.thumbnail(p);
    if (!b64) { missing++; continue; }
    const cap2 = db.prepare(
      "select value from annotation where asset_id=? and key='caption' order by rowid desc limit 1").get(id);
    cards.push({ id, file: best.filename, dir: tilde(path.dirname(p)), path: p,
                 kind: a.kind, when: a.shot_at ? String(a.shot_at).slice(0, 10) : null,
                 caption: cap2 ? cap2.value : null, b64 });
  }
  if (!cards.length) return { text: 'Nothing to show — none of those are on disk right now.' };

  const esc = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const title = esc(opts.title || 'Yellide');
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
:root{color-scheme:dark light}
body{margin:0;background:#141413;color:#eeece7;
     font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:28px 22px 60px}
h1{font:600 17px/1.3 ui-sans-serif,system-ui,sans-serif;margin:0 0 4px;letter-spacing:.01em}
.sub{color:#9a968e;font-size:13px;margin:0 0 22px}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
figure{margin:0;background:#1c1c1a;border:1px solid #2c2a27;border-radius:8px;overflow:hidden}
img{display:block;width:100%;height:190px;object-fit:cover;background:#000}
figcaption{padding:9px 11px 11px}
.cap{font-size:13.5px;line-height:1.45}
.meta{color:#8a867e;font-size:11.5px;margin-top:5px;word-break:break-all;font-family:ui-monospace,Menlo,monospace}
.vid::after{content:"video";position:relative;top:-26px;left:9px;background:#0d9488;color:#fff;
            font-size:10px;padding:2px 6px;border-radius:3px}
a{color:inherit;text-decoration:none}
a:hover figure{border-color:#2dd4bf}
</style>
<h1>${title}</h1>
<p class="sub">${cards.length} of ${list.length} shown${missing ? ` &middot; ${missing} not on disk` : ''}
&middot; click any frame to reveal it in Finder</p>
<div class="grid">
${cards.map(c => `<a href="file://${encodeURI(c.path)}"><figure>
<img src="data:image/jpeg;base64,${c.b64}" alt="${esc(c.caption || c.file)}"${c.kind === 'video' ? ' class="vid"' : ''}>
<figcaption>${c.caption ? `<div class="cap">${esc(c.caption)}</div>` : ''}
<div class="meta">${esc(c.file)}${c.when ? ' &middot; ' + c.when : ''}<br>${esc(c.dir)}</div>
</figcaption></figure></a>`).join('\n')}
</div>`;

  const out = path.join(require('./storage.js').dataDir(), 'sheets');
  try { fs.mkdirSync(out, { recursive: true }); } catch {}
  const file = path.join(out, 'pictures.html');
  fs.writeFileSync(file, html);
  const cmd = process.platform === 'darwin' ? ['open', [file]]
            : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
            : ['xdg-open', [file]];
  let opened = true;
  try { execFile(cmd[0], cmd[1], () => {}); } catch { opened = false; }

  return {
    text: `Opened a contact sheet with ${cards.length} picture${cards.length === 1 ? '' : 's'}`
        + (missing ? ` (${missing} not on disk right now)` : '') + '.'
        + (opened ? ' It should be in your browser now — click any frame to reveal it in Finder.'
                  : ` Open this file yourself: ${file}`)
        + `\n\nTell the user you have OPENED it, not that it is shown in this chat — pictures`
        + ` returned to you are not visible to them.`,
    file, shown: cards.length, missing,
  };
}
module.exports.showPictures = showPictures;
