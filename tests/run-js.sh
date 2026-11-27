#!/bin/sh
# Tes JavaScript mod (mesin kanban, state.js, dialog kanban, updater) di gjs, dengan modul "herdr" tiruan.
#   sh tests/run-js.sh          butuh gjs (Debian/Ubuntu: apt install gjs)
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
command -v gjs >/dev/null || { echo "gjs dibutuhin (apt install gjs)." >&2; exit 1; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cp "$ROOT"/tests/js/*.js "$T/"
# salinan mod dengan import "herdr" diganti ke mock.js
for f in company-status/kanban.js company-status/state.js company-agents/updater.js company-agents/team.js company-agents/tools.js; do
  sed 's#from "herdr";#from "./mock.js";#' "$ROOT/mods/$f" > "$T/$(basename "$f")"
done
rc=0
for t in "$T"/*.test.js; do
  printf '%-20s ' "$(basename "$t")"
  gjs -m "$t" "$ROOT/mods/company-kanban/main.js" || rc=1
done
exit $rc
