#!/bin/bash
# Build luci-app-multikmwan_<ver>_all.ipk with no OpenWrt SDK.
# Works on Linux, macOS and Windows (Git Bash) - needs bash + python3.
set -e
cd "$(dirname "$0")"

VER=$(sed -n 's/^Version: //p' control/control)
OUT="luci-app-multikmwan_${VER}_all.ipk"
TMP=$(mktemp -d)

mkdir -p "$TMP/data/www" "$TMP/control"
cp -r root/.   "$TMP/data/"
cp -r htdocs/. "$TMP/data/www/"
cp control/*   "$TMP/control/"

python pack_ipk.py "$TMP" "$OUT"
rm -rf "$TMP"
