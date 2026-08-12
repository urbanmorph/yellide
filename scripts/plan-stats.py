#!/usr/bin/env python3
"""Regenerate the facts block in supporting-docs/plan.md from the repository.

Those numbers were maintained by hand and drifted within a day of being written: the plan
said v0.9.7, 13 tools and 2,181 lines while the repo held v0.9.16, 15 tools and 2,368. Prose
about a moving codebase goes stale faster than anyone will reconcile it, so the counts are
read from the code and the block is rewritten between two markers.

Index figures come from a live catalog and cannot be derived here, so they carry the date
they were measured and are left alone.

    python3 scripts/plan-stats.py
"""
import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PLAN = ROOT / 'supporting-docs' / 'plan.md'
START, END = '<!-- stats:start -->', '<!-- stats:end -->'

if not PLAN.exists():
    sys.exit('supporting-docs/plan.md not found (it is gitignored and local only)')

version = json.loads((ROOT / 'manifest.json').read_text())['version']
server = sorted((ROOT / 'server').glob('*.js'))
lines = sum(len(f.read_text().splitlines()) for f in server)

index_js = (ROOT / 'server' / 'index.js').read_text()
tools = len(re.findall(r"name: '([a-z_]+)',\s*\n?\s*description:", index_js))
prompts = len(re.findall(r"\{ name: '([a-z]+)',\s*\n\s*title:", index_js))

pages = sorted(p.name for p in (ROOT / 'site').glob('*.html') if p.name != '404.html')
tests = sorted(p.name for p in (ROOT / 'test').glob('*.test.js'))

try:
    tags = subprocess.run(['git', '-C', str(ROOT), 'log', '--oneline'],
                          capture_output=True, text=True).stdout.strip().splitlines()
    commits = len(tags)
except Exception:
    commits = None

block = f"""{START}
| | |
|---|---|
| Code | **{lines:,} lines** across {len(server)} files, **zero dependencies**, no build step |
| Tools | **{tools}** MCP tools, **{prompts}** prompts |
| Version | **{version}**, `.mcpb` served from the site rather than GitHub Releases |
| Site | **{len(pages)} pages**: {', '.join('`/' + p.replace('index.html', '').replace('.html', '') + '`' for p in pages)}, plus `llms.txt`, `robots.txt`, `sitemap.xml`, a 404 and the OG card |
| Tests | {', '.join('`' + t + '`' for t in tests)}, run by `pack.sh` before any build |
| Repo | **public**, MIT{f', {commits} commits' if commits else ''} |
| Index | measured 2026-08-09 on one archive: 8,910 assets, 141 GB, 45% content-searchable |
{END}"""

text = PLAN.read_text()
if START in text and END in text:
    new = re.sub(re.escape(START) + r'[\s\S]*?' + re.escape(END), block, text)
else:
    old = re.search(r'\| \| \|\n\|---\|---\|\n(?:\|.*\n)+', text)
    if not old:
        sys.exit('could not find the facts table in plan.md; add the markers by hand once')
    new = text.replace(old.group(0), block + '\n')

# the revision footer drifted out of step with the header
hdr = re.search(r'\*\*rev (\d+)', new)
if hdr:
    new = re.sub(r'\*Rev \d+,', f'*Rev {hdr.group(1)},', new)

if new != text:
    PLAN.write_text(new)
    print(f'  plan.md facts regenerated: v{version}, {tools} tools, {lines:,} lines, {len(pages)} pages')
else:
    print('  plan.md already current')
