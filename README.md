# Yellide

**ಎಲ್ಲಿದೆ** — Kannada for *"where is it?"*

Find what you shot. Yellide indexes the photos, videos and audio scattered across your
machine and your drives, lets your own AI describe what is actually in them, and keeps all
of it searchable — including on drives that aren't plugged in.

> The index travels. The footage stays home.

**Free. MIT. Local.** Nothing is uploaded, nothing is sold, and there is no account.

---

## What it does

```
"What media files do I have on this Mac?"
  → 8,910 files · 141 GB · 41 hours, across 16 locations you had forgotten about

"Find the cycling event"
  → IMG_0012.MOV — 2024-10-21 · 3840×2160 · ~/Premire Pro Videos/Pedaluru/brolls2/

"Where's that file now?"
  → on KERALA_2023. That drive isn't plugged in.
```

- **Finds your media itself.** No paths, no folder picker. It enumerates and ranks by
  density, because you don't know where everything is — that's the problem.
- **Reads what's already there.** Dates, cameras, lenses, GPS, duration — from container
  metadata, EXIF and vendor blocks. No AI needed, seconds not hours.
- **Lets your agent describe the rest.** It hands pictures to Claude or Codex, and a
  description of one shoot covers the whole shoot. One caption reached 622 files.
- **Never forgets.** Rename, move or delete a file and the index follows or remembers.
  Unplug a drive and it stays searchable.
- **Won't touch your cloud.** iCloud and Dropbox placeholders are detected and skipped —
  reading one would download it.

## Install

**Claude Desktop** — download `yellide.mcpb` from
[Releases](https://github.com/urbanmorph/yellide/releases), drag it onto the app window,
click **Install Anyway** at the warning. That's it; you never type a path.

**Anything else that speaks MCP** (Codex, Cursor, LM Studio, Cline, Goose):

```jsonc
{ "command": "node",
  "args": ["/absolute/path/to/yellide/server/index.js"] }
```

Requires Node 22+. Claude Desktop bundles its own, so there is nothing to install there.

## Privacy

Everything stays on your machine. Yellide reads metadata headers plus the first and last
megabyte of each file to identify it, and **never modifies, moves or renames anything.**

Pictures you ask it to describe go to **your own AI provider under your own account** —
that is the one thing that leaves the machine, and only when you ask for it.

Documents are handled deliberately: an ID card, bank record, medical report or contract is
labelled by **type only**, marked private, and excluded from search. Privacy follows the
file's content, so every copy of the same document is covered — not just the one it saw.

## Status

Working, and used daily on one real archive. Not yet tested by anyone but its authors, and
not yet run on Windows or Linux. Image and video description currently needs macOS.

See [`CLAUDE.md`](CLAUDE.md) for the thesis and constraints.

## Build

```bash
./scripts/pack.sh          # produces yellide.mcpb
node test/exif.test.js     # tests
```

No dependencies. No build step. ~2,200 lines of plain JavaScript.

## Licence

MIT. If this ever disappears, `export` writes your whole index to plain JSON, and
`rename` can put everything it knows into your filenames.
