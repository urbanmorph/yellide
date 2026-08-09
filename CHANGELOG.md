# Changelog

All notable changes to Yellide. Newest first, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[semantic versioning](https://semver.org/spec/v2.0.0.html).

This file is canonical. `site/changelog.html` is generated from it by
`scripts/build-changelog.py`, so edit here and never there.

A sideloaded `.mcpb` **never auto-updates** and Claude Desktop keeps running the old code
until you uninstall, reinstall and restart. That is why the version is on the website and
why this file exists.

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

[0.9.7]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.7
[0.9.6]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.6
[0.9.5]: https://github.com/urbanmorph/yellide/releases/tag/v0.9.5
