# Changelog

All notable changes to Yellide. Newest first, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[semantic versioning](https://semver.org/spec/v2.0.0.html).

This file is canonical. `site/changelog.html` is generated from it by
`scripts/build-changelog.py`, so edit here and never there.

A sideloaded `.mcpb` **never auto-updates** and Claude Desktop keeps running the old code
until you uninstall, reinstall and restart. That is why the version is on the website and
why this file exists.

## [0.9.20] 2026-08-12

### Changed

- **The counter no longer asks permission, because there is nothing to consent to.** It sends
  six counts, a version, and a random label that the server hashes on arrival and does not
  store. None of that is personal data under the DPDP Act, so gating it behind a consent
  question was theatre. Yellide tells you about it once, in plain words, and
  `stop the Yellide counter` stops it and deletes your row at any time. Claude cannot turn it
  back on by itself.
- **Nothing is sent before you have been told.** The server stamps that at the moment it
  writes the notice, not when the model relays it, so a model that swallows the message cannot
  cause a silent send.
- `set_contribution` is now only for turning it back on after you stopped it. Its description
  tells the model never to call it on its own initiative.
- **"Makes no network calls" is gone from the README and `/install`.** It stopped being true
  in 0.9.19 and said so in three places for a day.

## [0.9.19] 2026-08-12

### Added

- **The counter is deployed.** A Cloudflare Worker and D1 database now receive it. The Worker
  refuses any field it does not expect rather than ignoring it, so a later client cannot
  quietly start sending more than `/privacy` admits to.

### Fixed

- The test suite would have posted its fixture counts to the live counter. It blanks
  `YELLIDE_COUNTER` before loading `contribute.js`, and endpoint resolution moved from `||` to
  `??` so an explicit empty string switches the counter off rather than falling back.
- The safety audit printed "no network" while `contribute.js` reaches the network by design.
  It prints "network only in contribute.js" now, which is what the check has always enforced.

## [0.9.18] 2026-08-12

### Added

- **You can opt in to the counter, when asked.** After your first index finishes, Claude asks
  once, in plain words, and remembers the answer either way. `stop_contributing` withdraws
  and deletes the row. All network code lives in one file, `server/contribute.js`, and the
  build gate now permits network there and nowhere else, only while that file stays under
  140 lines, still checks consent before sending, still takes its endpoint from the
  environment, and never touches a filename, path or annotation value. Verified by breaking
  each of those four and watching the build refuse.
- `scripts/fresh-start.sh` wipes the index, the drive markers and the installed extension, so
  the website can be followed from the top as a stranger would. It prints what will be lost
  first, including the caption count, and requires typing ERASE.
- ESLint, run by `pack.sh`. Errors block a build; warnings do not.

### Fixed

- **The counter reported 2% coverage where the diagnostics report said 51%**, because it
  counted assets carrying a caption row rather than assets a caption covers. A caption
  propagates across its whole shoot, which is most of the work. Coverage now comes from
  `captionProgress`, the same function the report uses, so the two cannot disagree. Caught by
  writing the test first.
- Dead code ESLint found: `configProblem`, `probeSearch`, `backlogNote`, `remainingShoots`,
  and two aggregate queries in `describeArchive` whose results were never read but which ran
  on every call. 51 lines gone.

## [0.9.17] 2026-08-12

### Changed

- **The no-network claim is enforced, not just stated.** /privacy says Yellide makes no
  network calls three times and invites people to check. The build gate covered filesystem
  writes, shell and eval, but not that, so the strongest claim on the page was the one
  nothing guarded. Any transport, network client or URL literal in `server/` now fails the
  build. Verified by adding a beacon on purpose and watching it refuse.

## [0.9.16] 2026-08-10

### Added

- **The drive marker can be refused.** Settings, Extensions, Yellide, Configure, then
  "Never write anything to my drives". Or `YELLIDE_NO_DRIVE_MARKER=1` in the environment for
  any other MCP client. Indexing and searching are unaffected; the only loss is that a
  renamed drive can no longer be recognised as the same one.

  The switch had existed in `storage.js` since the beginning and nothing set it, so
  /privacy carried a paragraph admitting the gap and promising a fix. A promise on a page is
  the exact thing that page exists to avoid, so it is wired up instead, and the safety test
  now fails the build if `writeMarker:false` ever stops reaching the code that writes.

  Verified against a real mounted disk image, because the first test passed while proving
  nothing: `volumeMarker` only acts at a mount point, and a temp directory is not one, so
  every case came back "did not write" including the one that should have written.

## [0.9.15] 2026-08-10

### Changed

- **No em-dashes in anything a person reads.** Every tool description, every line of output
  Yellide writes into a chat, the whole website, the extension listing, the README and this
  file. 170 of them, replaced by whichever punctuation the sentence actually wanted rather
  than one blanket substitution: a colon where the dash was glossing a name, a full stop
  where it was starting a second clause, a comma everywhere else. Code comments keep theirs,
  since they are for whoever is reading the source.

## [0.9.13], 2026-08-09

### Added

- **`show_pictures` takes labels.** The agent has usually just looked at the frames and is
  holding descriptions that are not saved yet; without them the sheet shows only a
  filename, and `6E098553-3276-4EB6-8E25-2C46C9F977D2.jpeg` tells a person nothing about a
  photograph.

### Fixed

- **`search` never returned asset ids**, so nothing could act on a result. Every other tool, `show_pictures`, `reveal`, `get_asset`, is keyed by id, and the text is all the agent
  actually receives. Asked to show 245 cycling matches, Claude could only display five,
  because it had paths and needed ids. It diagnosed this itself and said so in the reply,
  which is the only reason it surfaced: the search worked, the answer was accurate, and the
  gap was invisible from every log.

  Each hit now reads `1. [id 402] filename, …`, and the result ends with the full id list.

- `search`'s structured data set `filename` to the camera model. Now the filename.

## [0.9.12], 2026-08-09

### Added

- **`show_pictures`, a contact sheet you can actually see.** Ask to see something and
  Yellide now writes a self-contained HTML sheet of the real frames and opens it in your
  browser: captioned, dated, with the folder shown, and every frame clickable to reveal it
  in Finder.

  This exists because of a failure that was invisible from the server side. `look` returns
  MCP image blocks, and those go to the *model*. Claude Desktop feeds them to Claude and
  renders nothing in the chat. So Claude, having genuinely seen twelve photographs, wrote
  "shown above in three sets" and the person saw prose about pictures they could not see.
  For a tool about footage, that is the central interaction failing while every log line
  says success.

- `look`'s description now states plainly that its images are not visible to the user, so
  the model stops claiming otherwise and calls `show_pictures` instead.

## [0.9.11], 2026-08-09

### Changed

- **The extension icon fills its tile.** The glyph was sized at 64% of the tile because
  that is what Android's maskable safe zone requires, but that constraint belongs to the
  web manifest icons, not the bundle, and the two are separate files. It is 86% now, and
  the tile ships square so Claude Desktop's own rounded mask is not applied twice.

## [0.9.10], 2026-08-09

### Fixed

- **The downloaded file now carries its version in the name**, `yellide-0.9.10.mcpb`
  rather than `yellide.mcpb`. A stale bundle sitting in Downloads or on the Desktop is
  otherwise indistinguishable from a fresh one, and since sideloaded extensions never
  auto-update, installing the old file silently reinstalls old code. This cost us an
  evening: an icon fix looked broken for three builds because the file being dragged in
  was four releases behind.
- The bundle is served with `Cache-Control: no-cache`, so a re-download is never the
  browser's cached copy.
- `icon.png` is now 8-bit rather than 16-bit, matching every extension that renders
  correctly.

## [0.9.9], 2026-08-09

### Added

- **Slash commands.** Yellide now exposes MCP prompts, which Claude Desktop lists under
  `/`. MCP has no wake word, the model decides when to call a tool from its description, so this is the nearest thing to a front door, and the only browsable surface a product
  with no interface can have. Five: `find`, `index`, `describe`, `archive`, `diagnose`.

### Fixed

- **The version was hardcoded in two places and stale in both.** The MCP handshake had
  reported `0.1.0` since the beginning, and the diagnostics tool reported `0.9.5` for four
  releases, a report whose entire job is telling you which version you are running when
  something is wrong. Both now read `manifest.json`, and `pack.sh` refuses to build if a
  version literal reappears in `server/`.

## [0.9.8], 2026-08-09

### Added

- **The extension now carries its own icon.** Claude Desktop was generating a generic grey
  "Y" placeholder from the name, because the bundle shipped no icon at all, so the mark was
  invisible in the one place the product is actually seen. `icon.png` is now inside the
  bundle.

### Changed

- **`long_description` rewritten to lead with content search.** It described only inventory
  and location, where files live, which drive to fetch, and never mentioned that Claude
  describes your pictures so you can search by subject. That is the differentiator, and it
  was missing from the text a person reads while deciding whether to install.
- The install page now carries real screenshots of the warning dialog and the installed
  extension, replacing the CSS reproduction of the dialog.

## [0.9.7], 2026-08-09

### Fixed

- **Declared Node floor was wrong by four major versions.** `manifest.json` said
  `>=18.0.0`, but `node:sqlite` only landed in Node 22.5.0, so the server would crash at
  startup on 18 or 20. Claude Desktop bundles its own Node and was never affected; anyone
  wiring Yellide into Codex, Cursor or LM Studio against an older Node would have hit the
  silent no-error failure. Now `>=22.5.0`.
- The bundle served by the website was gitignored by `*.mcpb`, so a fresh clone would
  deploy a site whose download button 404s. `site/yellide.mcpb` is now tracked.

## [0.9.6], 2026-08-09

### Added

- **A diagnostics report you can paste to anyone.** Ask *"run Yellide diagnostics"* and
  you get version, platform, capabilities and counts. It deliberately contains no
  filenames, paths, captions or search terms, so it is safe to share when something is
  wrong.
- Its own identity: the wordmark, and the website.

## [0.9.5], 2026-08-09

The first version that does the whole job.

### Added

- **Finds your media by itself.** No folder pickers and no paths, not knowing where
  everything is *is* the problem it exists to solve.
- **Search by what is in the picture**, not only by what the file is called. Your own AI
  describes a shoot once and the description covers every file in it.
- **Unplugged drives stay searchable.** Yellide remembers what was on a drive and tells
  you which one to go and find.
- Reads dates, cameras, lenses, GPS and duration straight out of the files, including raw
  formats, audio, and cameras that ignore Apple's atom conventions.
- Cloud placeholders are detected and stepped over rather than downloaded.
- Private documents are labelled by type and never by content, and are redacted on export.
- `export` writes the whole index to plain JSON, so nothing here is a one-way door.

[0.9.18]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.18
[0.9.17]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.17
[0.9.16]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.16
[0.9.15]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.15
[0.9.13]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.13
[0.9.12]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.12
[0.9.11]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.11
[0.9.10]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.10
[0.9.9]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.9
[0.9.8]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.8
[0.9.7]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.7
[0.9.6]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.6
[0.9.5]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.5
