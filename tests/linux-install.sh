#!/bin/sh
# Uji install.sh / uninstall.sh di folder home tiruan (Herdr dan Claude Code asli gak disentuh):
# pasang, statusLine, hook Stop, pixel-hq-task, doctor, pulihkan dari backup, copot --purge.
#   sh tests/linux-install.sh       butuh python3
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
F=$(mktemp -d); trap 'rm -rf "$F"' EXIT
CFG="$F/.config/herdr-app"
fails=0
check() { if eval "$2"; then echo "ok    $1"; else echo "GAGAL $1"; fails=$((fails + 1)); fi; }
# lingkungan bersih: home tiruan, PATH tanpa herdr-app/hc, jadi Herdr yang lagi jalan gak ikut dipindah layout-nya
run() { env -i PATH=/usr/bin:/bin HOME="$F" LANG=C.UTF-8 "$@"; }
js() { python3 -I -c "import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if ($2) else 1)" "$1"; }

mkdir -p "$CFG" "$F/.claude"
KEYS0='{"global":{"ctrl-shift-m":"app.palette"}}'
SET0='{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo punyaku"}]}]}}'
printf '%s\n' "$KEYS0" > "$CFG/keys.json"
printf '%s\n' "$SET0" > "$F/.claude/settings.json"

echo "== install.sh"
run sh "$ROOT/install.sh" > "$F/install.log" 2>&1; rc=$?
check "install.sh keluar 0" '[ $rc -eq 0 ] || { cat "$F/install.log"; false; }'
check "backup dibuat" 'ls "$F"/backups/herdr/sebelum-custom-pixelhq-*.tar.gz >/dev/null 2>&1'
check "mod, layout, tema disalin" '[ -f "$CFG/mods/company-kanban/main.js" ] && [ -f "$CFG/layouts/pixel-hq.json" ] && [ -f "$CFG/themes/pixel-hq.json" ]'
check "statusLine dipasang" 'js "$F/.claude/settings.json" "\"pixel-hq-statusline\" in d[\"statusLine\"][\"command\"]"'
check "hook aktivitas dipasang, hook punyamu tetap" 'js "$F/.claude/settings.json" "any(\"claude-activity.py\" in h[\"command\"] for g in d[\"hooks\"][\"Stop\"] for h in g[\"hooks\"]) and any(h[\"command\"] == \"echo punyaku\" for g in d[\"hooks\"][\"Stop\"] for h in g[\"hooks\"])"'
check "hotkey Kanban dipasang, Usage dilewati (ctrl-shift-m udah kepake)" 'js "$CFG/keys.json" "d[\"layout:pixel-hq\"] == {\"ctrl-shift-j\": \"mod.open:company-kanban\"} and d[\"global\"] == {\"ctrl-shift-m\": \"app.palette\"}"'
check "pixel-hq-task dipasang" '[ -x "$F/.local/bin/pixel-hq-task" ] && grep -q "custom Pixel HQ" "$F/.local/bin/pixel-hq-task"'

sleep 1
run sh "$ROOT/install.sh" > "$F/install2.log" 2>&1
check "install.sh kedua kali gak mendobel hook" 'js "$F/.claude/settings.json" "sum(\"claude-activity.py\" in h[\"command\"] for g in d[\"hooks\"][\"Stop\"] for h in g[\"hooks\"]) == 1"'

echo "== statusLine dan hook"
STATUS='{"model":{"display_name":"Opus 5.5"},"context_window":{"used_percentage":12},"rate_limits":{"five_hour":{"used_percentage":42,"resets_at":1999999999},"seven_day":{"used_percentage":7,"resets_at":1999999999}},"cost":{"total_cost_usd":0.25}}'
out=$(printf '%s' "$STATUS" | run sh "$F/.claude/pixel-hq-statusline.sh")
check "statusLine mencetak model" 'printf "%s" "$out" | grep -q "Opus 5.5"'
check "claude-usage.json ditulis" 'js "$F/.local/state/pixel-hq/claude-usage.json" "d[\"session\"][\"used\"] == 42 and d[\"week\"][\"used\"] == 7"'
check "riwayat usage ditulis" 'js "$F/.local/state/pixel-hq/claude-usage-history.json" "len(d) == 1 and d[0][1] == 42"'
printf '%s' '{"hook_event_name":"Stop","last_assistant_message":"Udah beres ✓. Mau lanjut?"}' \
  | run env HC_TERMINAL_ID=t1 python3 -I "$CFG/mods/company-agents/claude-activity.py" stop
check "hook Stop menyimpan balasan terakhir" 'js "$F/.local/state/pixel-hq/last/t1.json" "d[\"text\"] == \"Udah beres ✓. Mau lanjut?\""'

echo "== pixel-hq-task"
run "$F/.local/bin/pixel-hq-task" -k -m sonnet --batas 30 --hentikan "Tes dari CI" > /dev/null
printf 'isi detail' | run "$F/.local/bin/pixel-hq-task" -d - "Kedua" > /dev/null
check "dua task masuk inbox" 'js "$CFG/pixel-hq-kanban-inbox.json" "len(d) == 2 and d[0][\"column\"] == \"doing\" and d[0][\"model\"] == \"sonnet\" and d[0][\"limitStop\"] is True and d[1][\"detail\"] == \"isi detail\""'
run "$F/.local/bin/pixel-hq-task" -m gpt "x" > /dev/null 2>&1; rc=$?
check "model salah ditolak" '[ $rc -eq 2 ]'

echo "== doctor"
run python3 -I "$CFG/mods/company-agents/pixel-hq-doctor.py" > "$F/doctor.log" 2>&1; rc=$?
check "doctor keluar 0" '[ $rc -eq 0 ]'
check "doctor: 0 masalah" 'grep -q "Ringkasan: 0 masalah" "$F/doctor.log" || { cat "$F/doctor.log"; false; }'
check "doctor menyimpan laporan" 'ls "$F"/pixel-hq-doctor-*.txt >/dev/null 2>&1'
check "doctor menyembunyikan folder home" '! grep -q "$F" "$F/doctor.log"'

echo "== uninstall.sh --restore (ke kondisi sebelum install pertama)"
FIRST=$(ls -1tr "$F"/backups/herdr/sebelum-custom-pixelhq-*.tar.gz | head -n 1)
run sh "$ROOT/uninstall.sh" --restore "$FIRST" > "$F/restore.log" 2>&1; rc=$?
check "restore keluar 0" '[ $rc -eq 0 ] || { cat "$F/restore.log"; false; }'
check "keys.json kembali persis" '[ "$(cat "$CFG/keys.json")" = "$KEYS0" ]'
check "settings.json kembali persis" '[ "$(cat "$F/.claude/settings.json")" = "$SET0" ]'
check "mod Pixel HQ hilang" '! ls -d "$CFG"/mods/company-* >/dev/null 2>&1'
check "pixel-hq-task dicopot" '[ ! -e "$F/.local/bin/pixel-hq-task" ]'

echo "== uninstall.sh --purge"
run sh "$ROOT/install.sh" > /dev/null 2>&1
run sh "$ROOT/uninstall.sh" --purge > "$F/uninstall.log" 2>&1; rc=$?
check "uninstall keluar 0" '[ $rc -eq 0 ] || { cat "$F/uninstall.log"; false; }'
check "mod, layout, tema dihapus" '! ls -d "$CFG"/mods/company-* >/dev/null 2>&1 && [ ! -e "$CFG/layouts/pixel-hq.json" ] && [ ! -e "$CFG/themes/pixel-hq.json" ]'
check "statusLine dan hook Pixel HQ dicabut, hook punyamu tetap" 'js "$F/.claude/settings.json" "\"statusLine\" not in d and [h[\"command\"] for g in d[\"hooks\"][\"Stop\"] for h in g[\"hooks\"]] == [\"echo punyaku\"]"'
check "hotkey dicabut" 'js "$CFG/keys.json" "\"layout:pixel-hq\" not in d"'
check "data dihapus" '[ ! -e "$CFG/pixel-hq-kanban-inbox.json" ] && [ ! -e "$F/.local/state/pixel-hq" ]'
check "pixel-hq-task dicopot" '[ ! -e "$F/.local/bin/pixel-hq-task" ]'

echo
if [ $fails -eq 0 ]; then echo "Semua lolos."; else echo "$fails gagal."; fi
exit $fails
