#!/bin/bash
# Wipe every trace of Yellide from this machine, so you can install from the website as a
# stranger would and see exactly what they see.
#
# Read the warning. This destroys work that took real time to produce.
set -uo pipefail

DATA="$HOME/Library/Application Support/yellide"
EXT="$HOME/Library/Application Support/Claude/Claude Extensions"

echo
echo "  This will delete:"
if [ -f "$DATA/catalog.db" ]; then
  node -e "
    const s=require('$PWD/server/storage.js'); const db=s.open();
    const n=k=>{try{return db.prepare(k).get().n}catch{return 0}};
    console.log('    the index      ' + n('select count(*) n from asset').toLocaleString('en-US') + ' assets');
    console.log('    descriptions   ' + n(\"select count(*) n from annotation where key='caption'\") + ' captions, which took real time to write');
    console.log('    private marks  ' + n(\"select count(*) n from annotation where key='private'\") + ' items you marked private');
  " 2>/dev/null
else
  echo "    (no index found)"
fi
echo "    the .yellide marker on every drive it indexed"
echo "    the Yellide extension, if installed"
echo
echo "  BACK UP FIRST if you want any of it: ask Claude to \"export my index\"."
echo
read -r -p "  Type ERASE to continue: " reply
[ "$reply" = "ERASE" ] || { echo "  Nothing done."; exit 0; }

rm -rf "$DATA" && echo "  removed the index and its data directory"

for v in /Volumes/*; do
  [ -d "$v/.yellide" ] && rm -rf "$v/.yellide" && echo "  removed the marker from $v"
done
[ -d "$HOME/.yellide" ] && rm -rf "$HOME/.yellide" && echo "  removed ~/.yellide"

for d in "$EXT"/*yellide*; do
  [ -d "$d" ] && rm -rf "$d" && echo "  removed the installed extension"
done

cat <<'NEXT'

  Gone. To start as a stranger would:

    1. Quit Claude Desktop with Cmd-Q. It caches the extension list.
    2. Open https://yellide.pages.dev and follow it from the top.
    3. Do not use any .mcpb already on your Desktop. Download a fresh one,
       so you are testing what a visitor actually gets.
    4. Reopen Claude Desktop and say:

         "What media files do I have on this Mac?"

  Write down every question you have to ask that the site did not answer.
  Each one is a defect in a page, not a support request.

NEXT
