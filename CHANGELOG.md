# Changelog

All notable changes to Yellide. Newest first, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[semantic versioning](https://semver.org/spec/v2.0.0.html).

This file is canonical. `site/changelog.html` is generated from it by
`scripts/build-changelog.py`, so edit here and never there.

A sideloaded `.mcpb` **never auto-updates** and Claude Desktop keeps running the old code
until you uninstall, reinstall and restart. That is why the version is on the website and
why this file exists.

## [0.9.12] — 2026-08-09

### Added

- **`show_pictures` — a contact sheet you can actually see.** Ask to see something and
  Yellide now writes a self-contained HTML sheet of the real frames and opens it in your
  browser: captioned, dated, with the folder shown, and every frame clickable to reveal it
  in Finder.

  This exists because of a failure that was invisible from the server side. `look` returns
  MCP image blocks, and those go to the *model* — Claude Desktop feeds them to Claude and
  renders nothing in the chat. So Claude, having genuinely seen twelve photographs, wrote
  "shown above in three sets" and the person saw prose about pictures they could not see.
  For a tool about footage, that is the central interaction failing while every log line
  says success.

- `look`'s description now states plainly that its images are not visible to the user, so
  the model stops claiming otherwise and calls `show_pictures` instead.

## [0.9.11] — 2026-08-09

### Changed

- **The extension icon fills its tile.** The glyph was sized at 64% of the tile because
  that is what Android's maskable safe zone requires — but that constraint belongs to the
  web manifest icons, not the bundle, and the two are separate files. It is 86% now, and
  the tile ships square so Claude Desktop's own rounded mask is not applied twice.

## [0.9.10] — 2026-08-09

### Fixed

- **The downloaded file now carries its version in the name** — `yellide-0.9.10.mcpb`
  rather than `yellide.mcpb`. A stale bundle sitting in Downloads or on the Desktop is
  otherwise indistinguishable from a fresh one, and since sideloaded extensions never
  auto-update, installing the old file silently reinstalls old code. This cost us an
  evening: an icon fix looked broken for three builds because the file being dragged in
  was four releases behind.
- The bundle is served with `Cache-Control: no-cache`, so a re-download is never the
  browser's cached copy.
- `icon.png` is now 8-bit rather than 16-bit, matching every extension that renders
  correctly.

## [0.9.9] — 2026-08-09

### Added

- **Slash commands.** Yellide now exposes MCP prompts, which Claude Desktop lists under
  `/`. MCP has no wake word — the model decides when to call a tool from its description —
  so this is the nearest thing to a front door, and the only browsable surface a product
  with no interface can have. Five: `find`, `index`, `describe`, `archive`, `diagnose`.

### Fixed

- **The version was hardcoded in two places and stale in both.** The MCP handshake had
  reported `0.1.0` since the beginning, and the diagnostics tool reported `0.9.5` for four
  releases — a report whose entire job is telling you which version you are running when
  something is wrong. Both now read `manifest.json`, and `pack.sh` refuses to build if a
  version literal reappears in `server/`.

## [0.9.8] — 2026-08-09

### Added

- **The extension now carries its own icon.** Claude Desktop was generating a generic grey
  "Y" placeholder from the name, because the bundle shipped no icon at all — so the mark was
  invisible in the one place the product is actually seen. `icon.png` is now inside the
  bundle.

### Changed

- **`long_description` rewritten to lead with content search.** It described only inventory
  and location — where files live, which drive to fetch — and never mentioned that Claude
  describes your pictures so you can search by subject. That is the differentiator, and it
  was missing from the text a person reads while deciding whether to install.
- The install page now carries real screenshots of the warning dialog and the installed
  extension, replacing the CSS reproduction of the dialog.

## [0.9.7] — 2026-08-09

### Fixed

- **Declared Node floor was wrong by four major versions.** `manifest.json` said
  `>=18.0.0`, but `node:sqlite` only landed in Node 22.5.0, so the server would crash at
  startup on 18 or 20. Claude Desktop bundles its own Node and was never affected; anyone
  wiring Yellide into Codex, Cursor or LM Studio against an older Node would have hit the
  silent no-error failure. Now `>=22.5.0`.
- The bundle served by the website was gitignored by `*.mcpb`, so a fresh clone would
  deploy a site whose download button 404s. `site/yellide.mcpb` is now tracked.

## [0.9.6] — 2026-08-09

### Added

- **A diagnostics report you can paste to anyone.** Ask *"run Yellide diagnostics"* and
  you get version, platform, capabilities and counts. It deliberately contains no
  filenames, paths, captions or search terms, so it is safe to share when something is
  wrong.
- Its own identity: the wordmark, and the website.

## [0.9.5] — 2026-08-09

The first version that does the whole job.

### Added

- **Finds your media by itself.** No folder pickers and no paths — not knowing where
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

[0.9.12]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.12
[0.9.11]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.11
[0.9.10]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.10
[0.9.9]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.9
[0.9.8]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.8
[0.9.7]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.7
[0.9.6]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.6
[0.9.5]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.5
