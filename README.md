<div align="center">
  <img src="site/lockup.svg#gh-light-mode-only" alt="Yellide" height="64">
  <img src="site/lockup-dark.svg#gh-dark-mode-only" alt="Yellide" height="64">
  <p><strong>ಎಲ್ಲಿದೆ</strong> — Kannada for <em>“where is it?”</em></p>
  <p>
    <a href="https://yellide.pages.dev/">Website</a> ·
    <a href="https://yellide.pages.dev/install">Install</a> ·
    <a href="https://yellide.pages.dev/say">What to say</a> ·
    <a href="https://yellide.pages.dev/privacy">Privacy</a> ·
    <a href="CHANGELOG.md">Changelog</a>
  </p>
</div>

---

You have shot it. You know you have shot it. But where have you kept it?

Yellide indexes the photos, videos and audio scattered across your folders and drives, and
makes them searchable by **what is in them** — not only by what the files are called. It
runs entirely on your machine as an MCP server, so you search by talking to Claude.

It makes **no network calls**, has no account, and never modifies your files.

```
"What media files do I have on this Mac?"     → 8,910 files across sixteen places
"Find the cycling event"                       → by what is in the frame, not the filename
"Where is that clip?"                          → on KERALA_2023, and that drive is unplugged
```

**Status:** working, v0.9.7. Used daily against a ~9,000-file archive. Not yet 1.0 because
transcripts, Windows testing and the export viewer are unbuilt.

## Install

Most people should use [the website](https://yellide.pages.dev/install) — download the
bundle, drag it onto Claude Desktop, click through the unsigned-extension warning, restart.
Two minutes, no terminal.

Any MCP client that speaks stdio works too:

```
command: node
args:    /path/to/yellide/server/index.js
```

> **Watch for a leading space** when pasting that path into a settings field. The server
> simply never starts and nothing reports an error. It cost us an hour.

## Requirements

- **Node 22.5.0 or newer.** `node:sqlite` landed in 22.5; older versions crash at startup.
  Claude Desktop bundles its own Node, so this only matters for other clients.
- **macOS** for thumbnails and video frames, which use the built-in `sips` and `qlmanage`.
  Indexing and search work everywhere; only the describing pass needs macOS today.

There is nothing to `npm install`. Yellide has **zero dependencies** — no native modules,
no build step, no lockfile.

## Layout

```
server/           the whole product, ~2,200 lines, no dependencies
  index.js        MCP server: tool definitions, auto-scan, stdio transport
  core.js         walking, identity, ISO-BMFF parsing, shoot clustering, incremental scan
  storage.js      data dir, migrations, volume markers
  exif.js         TIFF/IFD parser — JPEG and every raw format
  audio.js        ID3, RIFF/WAVE including BWF origination date, FLAC
  vision.js       stills via sips, video frames via qlmanage
  discover.js     density-ranked media discovery; needs no path
  tools.js        the thirteen tools' implementations
  worker.js       scanning off the stdio thread
test/             node test/exif.test.js
scripts/pack.sh   build the .mcpb; refuses to build without a version bump
site/             the website, hand-written static HTML on Cloudflare Pages
```

## Development

```sh
node --check server/index.js          # syntax
node test/exif.test.js                # tests
bash scripts/pack.sh                  # build the bundle
```

`pack.sh` refuses to build if the version in `manifest.json` is unchanged, because a
sideloaded bundle never auto-updates and Claude Desktop keeps running the old code — you
will otherwise spend an afternoon debugging a bug you already fixed. It also copies the
bundle into `site/`, stamps the version into every page, and regenerates the changelog.

**A sideloaded extension does not reload.** To test a change: uninstall, install the new
bundle, quit Claude Desktop with Cmd-Q, reopen.

## Design decisions that are expensive to reverse

- **Identity is content-based**, `sha256(first 1MiB ‖ last 1MiB ‖ size)`, so renaming or
  moving a file does not lose its captions, and the same footage on two drives is one
  asset with two locations.
- **Cloud placeholders are detected before any read**, by `blocks === 0 && size > 0`. A
  size threshold misses most of them and turns a 7 ms file into a 20-second download.
  `stat.blocks` is POSIX-only, so the check probes at runtime and fails open on Windows.
- **Privacy propagates by content key, not by path.** The same ID card in six folders is
  marked once.
- **Captions propagate across a shoot**, which is what makes describing an archive
  affordable — one look can cover hundreds of files.
- **Undated files are never grouped into one shoot.** They cluster by folder instead;
  grouping them by `(null day, null camera)` produced a single 3,194-file shoot that
  poisoned the index.

## Repo discipline

**Markdown does not live in this repo**, with three exceptions: this file, `CLAUDE.md` and
`CHANGELOG.md`. Design documents, plans and research go in `supporting-docs/`, which is
gitignored, and are mirrored to a shared doc. This keeps exploratory writing out of the
diff.

`CHANGELOG.md` is canonical; `site/changelog.html` is generated from it by
`scripts/build-changelog.py`. Edit the markdown, never the HTML.

> ⚠️ **`CLAUDE.md` is currently stale.** It describes an earlier hosted, multiplayer design
> that was abandoned, and states that nothing is built. Treat it as history until it is
> rewritten.

## Contributing

Issues and pull requests are welcome. Two things to know:

1. Bump `version` in `manifest.json` with any change to `server/`, and add a
   `CHANGELOG.md` entry.
2. **Check the artifact, not the report.** Most of the real bugs in this codebase looked
   like clean output: a 56% parse rate that read as success, a camera-tag coverage of "0%"
   when the data was there, "1 match" when there were hundreds. If a number looks fine,
   open the thing it describes.

## Licence

[MIT](LICENSE). Free forever, and the licence is the only real proof of the privacy claims.
