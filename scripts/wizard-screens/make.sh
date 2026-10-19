#!/bin/sh
# Regenerates the wizard screenshots of the README (docs/images/wizard-*.svg)
# from demo.sh, which uses the real look of install.sh with invented data.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../../docs/images"
mkdir -p "$OUT"
sh "$HERE/demo.sh" host 2>&1 | python3 "$HERE/ansi2svg.py" "root@pve: ~" > "$OUT/wizard-host.svg"
sh "$HERE/demo.sh" done 2>&1 | python3 "$HERE/ansi2svg.py" "root@claude: ~" > "$OUT/wizard-install.svg"
sh "$HERE/demo.sh" warn 2>&1 | python3 "$HERE/ansi2svg.py" "dev@dev-box: ~" > "$OUT/wizard-untested.svg"
for f in "$OUT"/wizard-*.svg; do
    printf '%s %s\n' "$(basename "$f")" "$(sed -n 's/^<svg[^>]* width="\([0-9]*\)" height="\([0-9]*\)".*/\1x\2/p' "$f")"
done
