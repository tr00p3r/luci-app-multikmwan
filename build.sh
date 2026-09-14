#!/bin/bash
# Build luci-app-multikmwan_<ver>_all.ipk with no OpenWrt SDK.
# Works on Linux, macOS and Windows (Git Bash) - needs bash + python3.
set -e
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
	exec python3 build.py
fi
exec python build.py
