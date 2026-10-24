<div align="center">
  <img src="site/lockup.svg#gh-light-mode-only" alt="Yellide" height="64">
  <img src="site/lockup-dark.svg#gh-dark-mode-only" alt="Yellide" height="64">
  <p><strong>ಎಲ್ಲಿದೆ</strong>: Kannada for <em>“where is it?”</em></p>
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
makes them searchable by **what is in them**, not only by what the files are called. It
runs entirely on your machine as an MCP server, so you search by talking to Claude.

It has no account, never modifies your files, and sends nothing about you: the one thing it sends is six counts for a figure on the website, which you can stop by asking.

```
"What media files do I have on this Mac?"     → 8,910 files across sixteen places
"Find the cycling event"                       → by what is in the frame, not the filename
"Where is that clip?"                          → on KERALA_2023, and that drive is unplugged
```

**Status:** working, v0.9.33. Built against a real ~21,000-file archive. Not yet 1.0 because
audio is indexed but not yet transcribed, describing pictures needs macOS, Windows and Linux
are untested, and the export viewer is unbuilt.

## Install

Most people should use [the website](https://yellide.pages.dev/install), download the
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

There is nothing to `npm install`. Yellide has **zero dependencies**, no native modules,
no build step, no lockfile.

## Layout

```
server/           the whole product, no dependencies
  index.js        MCP server: tool definitions, auto-scan, stdio transport
  core.js         walking, identity, ISO-BMFF parsing, the two-pass incremental scan
  storage.js      data dir, migrations, volume markers
  exif.js         TIFF/IFD parser. JPEG and every raw format
  video.js        AVI, Matroska/WebM, MPEG programme and transport streams
  audio.js        ID3, RIFF/WAVE including BWF origination date, FLAC
  vision.js       stills via sips, video frames via qlmanage
  discover.js     density-ranked media discovery; needs no path
  tools.js        the tools' implementations
  worker.js       scanning off the stdio thread
  photos.js       the macOS Photos library's own records and album names, read-only
  contribute.js   the six aggregate counts, and the only network call
test/             node test/exif.test.js
scripts/
  pack.sh         build the .mcpb; refuses to build without a version bump
site/             hand-written static pages on Cloudflare Pages
edge/             the Cloudflare Worker that receives those counts
CHANGELOG.md      version history
```

## Development

```sh
node --check server/index.js          # syntax
node test/exif.test.js                # tests
bash scripts/pack.sh                  # build the bundle
```

`pack.sh` refuses to build if the version in `manifest.json` is unchanged, because a
sideloaded bundle never auto-updates and Claude Desktop keeps running the old code. You
will otherwise spend an afternoon debugging a bug you already fixed. It also copies the
bundle into `site/` and stamps the version into every page.

**A sideloaded extension does not reload.** To test a change: uninstall, install the new
bundle, quit Claude Desktop with Cmd-Q, reopen.

## Design decisions that are expensive to reverse

- **Identity is content-based**, `sha256(first 1MiB ‖ last 1MiB ‖ size)`, so renaming or
  moving a file does not lose its captions, and the same footage on two drives is one
  asset with two locations.
- **Cloud placeholders are detected before any read**, by `blocks === 0 && size > 0`. A
  size threshold misses most of them and turns a 7 ms file into a 20-second download.
  `stat.blocks` is POSIX-only, so the check probes at runtime and fails open on Windows.
- **A scan lists before it reads.** The first pass records every file by name, folder and
  date, as a provisional asset, so the whole archive is searchable in seconds. The second
  reads each file and folds what was known into its content-keyed asset. Online-only files
  and photos that exist only in iCloud stay provisional, findable and never downloaded.
- **A drive is its marker, not its name.** Entries are stored under the path a drive is
  mounted at, and `storage.claimRoot` moves them when its marker turns up elsewhere: a
  renamed drive keeps its entries, and a second card called `EOS_DIGITAL` parks the first
  card's entries instead of overwriting them.
- **Privacy propagates by content key, not by path.** The same ID card in six folders is
  marked once.
- **Captions propagate across a shoot**, which is what makes describing an archive
  affordable, one look can cover hundreds of files.
- **Undated files are never grouped into one shoot.** They cluster by folder instead;
  grouping them by `(null day, null camera)` produced a single 3,194-file shoot that
  poisoned the index. A date guessed from a filename or a file's timestamp counts as
  undated for this.

## Repo discipline

**Markdown does not live in this repo**, with two exceptions: this file and `CHANGELOG.md`.
Design documents, plans and research go in `supporting-docs/`, and local agent instructions
in `CLAUDE.md`, both gitignored. This keeps exploratory writing and working notes out of
the diff.

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
