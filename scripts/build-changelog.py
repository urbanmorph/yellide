#!/usr/bin/env python3
"""Generate site/changelog.html from CHANGELOG.md.

CHANGELOG.md is canonical. The site page is the only channel a non-technical user has
for learning that a new version exists — sideloaded bundles never auto-update — so the
two must never drift. Run from pack.sh, or by hand:

    python3 scripts/build-changelog.py
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / 'site'
HOST = 'https://yellide.pages.dev'
VERSION = json.loads((ROOT / 'manifest.json').read_text())['version']


def inline(text):
    """The small subset of markdown the changelog actually uses."""
    text = (text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    text = re.sub(r'\*\*([^*]+)\*\*', r'<b class="k">\1</b>', text)
    text = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)', r'<em>\1</em>', text)
    text = re.sub(r'\[([^\]]+)\]\((https?://[^)]+)\)', r'<a href="\2">\1</a>', text)
    return text.replace('--', '&mdash;')


def render(md):
    """Only the release sections. The preamble is for developers, not for the page."""
    out, in_list = [], False
    lines = md.splitlines()
    started = False
    for raw in lines:
        line = raw.rstrip()
        if line.startswith('## '):
            started = True
        if not started or re.match(r'^\[\d', line):
            continue
        if line.startswith('## '):
            if in_list:
                out.append('</ul>'); in_list = False
            heading = inline(line[3:])
            heading = heading.replace('] &mdash; ', '] &mdash; ').replace('[', '').replace(']', '')
            out.append('<h2>%s</h2>' % heading)
        elif line.startswith('### '):
            if in_list:
                out.append('</ul>'); in_list = False
            out.append('<h3>%s</h3>' % inline(line[4:]))
        elif line.startswith('- '):
            if not in_list:
                out.append('<ul>'); in_list = True
            out.append('<li>%s</li>' % inline(line[2:]))
        elif line.startswith('  ') and in_list and line.strip():
            out[-1] = out[-1][:-5] + ' ' + inline(line.strip()) + '</li>'
        elif not line:
            if in_list:
                out.append('</ul>'); in_list = False
        else:
            if in_list:
                out.append('</ul>'); in_list = False
            out.append('<p>%s</p>' % inline(line))
    if in_list:
        out.append('</ul>')
    return '\n'.join(out)


def main():
    md = (ROOT / 'CHANGELOG.md').read_text()
    page = SITE / 'changelog.html'
    if not page.exists():
        sys.exit('site/changelog.html is missing — cannot reuse its shell')

    shell = page.read_text()
    body = render(md)
    tail = ('\n\n<h2>How to check which version you have</h2>\n'
            '<p>In Claude Desktop: <b>Settings &rarr; Extensions &rarr; Yellide</b>. Or just ask\n'
            '<em>&ldquo;run Yellide diagnostics&rdquo;</em> &mdash; the version is the first line.</p>\n')

    # Guard on whether the region was FOUND, not on whether the output differs —
    # regenerating an already-current page is a no-op, not a failure.
    region = re.compile(r'(<p class="sub">.*?</p>\n).*?(?=\n</main>)', re.S)
    if not region.search(shell):
        sys.exit('could not find the content region in site/changelog.html')
    new = region.sub(lambda m: m.group(1) + '\n' + body + tail, shell)
    new = re.sub(r'(<b class="ver">)[^<]*(</b>)', r'\g<1>' + VERSION + r'\g<2>', new)
    page.write_text(new)
    print('  site/changelog.html regenerated from CHANGELOG.md (v%s)' % VERSION)


if __name__ == '__main__':
    main()
