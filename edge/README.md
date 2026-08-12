# The counter

**Nothing here is deployed and the client does not send anything.** This is written down so
it can be read before it is switched on, which is the only order that makes sense for
something that changes what Yellide promises.

## What it is for

A figure on the front page saying what the tool achieves across the people using it: files
indexed, split by kind, and how far content coverage has risen since each install's first
contribution. Confidence, from real archives rather than copy.

## What it is not for

Knowing who anyone is, where they are, what they shot, or what they searched for. Cloudflare
already reports visits and countries for the website and Search Console reports queries.
Neither can see what happens after an install, and that gap is the only reason this exists.

## The whole payload

```json
{ "install_id": "<random, generated on the user's machine>",
  "version": "0.9.17",
  "images": 20108, "video": 870, "audio": 102, "files_total": 22182,
  "coverage": 51, "captions": 396 }
```

The Worker rejects any field not on that list rather than ignoring it, so a later client
cannot quietly begin sending more than this file admits to.

## What is stored

`schema.sql` is the complete answer. One row per install:

`id_hash · first_month · last_month · version · images · video · audio · files_total ·
coverage_first · coverage_latest · captions`

**`install_id` is not stored.** The key is `SHA-256(install_id + PEPPER)`, where `PEPPER` is
a Worker secret that never leaves Cloudflare. The hash cannot be recomputed from an
`install_id` without it, so the stored key cannot be walked back to a machine.

There is no column for an IP address, hostname, operating system, locale, timezone, path,
filename, drive label, caption or search term. The Worker never reads `cf-connecting-ip`.

Dates are months. A month says "still in use" and cannot place anyone at a moment.

## Consent

Off unless switched on. After the first successful index, Claude asks once, and the answer
is remembered so it is never asked twice. `/privacy` names the exception and says exactly
what is sent.

Withdrawal is `POST /forget` with the `install_id`, which deletes the row. It needs no
account and no email, because a right to erasure that requires identifying yourself first is
not much of one.

## Before this goes live

1. **A DPDP review.** The stored fields are not personal data. The `id_hash` is a
   pseudonymous per-install key and is the one element that deserves a qualified opinion
   rather than mine.
2. **`/privacy` rewritten first**, then the build gate in `test/safety.test.js` amended in
   its own commit with the reason recorded, then the client wired. Never the other way
   round, or the code ships while the page is still saying something untrue.
3. **A Cloudflare token with D1 scope.** The Pages token cannot reach D1.
4. **A floor.** `/stats` returns `ready: false` below twelve installs. A counter reading
   "1 install" is worse than no counter, and a floor also stops a single contributor's
   totals being legible on the front page.

## Deploying, when that is all done

Credentials come from `.env.local`, read by `scripts/with-cf.sh`, which never prints them.
There is no second secrets file: `wrangler secret put` reads stdin. If you ever run the
Worker locally with `wrangler dev`, create `.dev.vars` with `PEPPER=...` at that point. It
is already gitignored.

```sh
npx wrangler d1 create yellide-counter
npx wrangler d1 execute yellide-counter --file=edge/schema.sql --remote
npx wrangler secret put PEPPER            # long, random, never rotated casually:
                                          # rotating it orphans every existing row
npx wrangler deploy edge/worker.js
```
