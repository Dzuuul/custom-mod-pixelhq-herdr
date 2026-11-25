#!/bin/sh
# Copot custom Pixel HQ dari Herdr dan Claude Code di komputer ini.
#   sh uninstall.sh            copot mod, layout, tema, hook, statusLine, dan hotkey Pixel HQ (data kanban & usage disimpan)
#   sh uninstall.sh --purge    sekalian hapus data kanban dan riwayat usage
#   sh uninstall.sh --restore  bukan copot: kembalikan kondisi dari backup terbaru yang dibuat install.sh
#   sh uninstall.sh --restore FILE   sama, tapi dari backup tertentu (lihat daftar: ls ~/backups/herdr/)
# Sebelum mengubah apa pun, kondisi sekarang di-backup ke ~/backups/herdr/sebelum-uninstall-pixelhq-<waktu>.tar.gz
set -e
CFG="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODE="copot"; FROM=""
for a in "$@"; do
  case "$a" in
    --purge) MODE="purge" ;;
    --restore) MODE="restore" ;;
    -h|--help) sed -n '2,7p' "$0"; exit 0 ;;
    *) if [ "$MODE" = "restore" ] && [ -z "$FROM" ] && [ -f "$a" ]; then FROM="$a"; continue; fi
       echo "Opsi gak dikenal: $a (pakai --purge, --restore, atau --help)" >&2; exit 1 ;;
  esac
done
[ -d "$CFG" ] || { echo "Folder $CFG gak ada, gak ada yang dicopot." >&2; exit 1; }

# pindah dari layout pixel-hq dulu kalau Herdr lagi jalan, biar gak error waktu mod-nya hilang
leave_layout() {
  command -v herdr-app >/dev/null 2>&1 || return 0
  for l in main terminals; do
    [ -f "$CFG/layouts/$l.json" ] && herdr-app do layout.switch "{\"name\":\"$l\"}" >/dev/null 2>&1 && { echo "Layout dipindah ke $l"; return 0; }
  done
  return 0
}

# backup kondisi sekarang (sama seperti install.sh: kode tar 1 = ada file yang berubah saat dibaca, masih valid)
BK="$HOME/backups/herdr/sebelum-uninstall-pixelhq-$(date +%Y%m%d-%H%M%S).tar.gz"
mkdir -p "$(dirname "$BK")"
FILES="${CFG#$HOME/}"; [ -f "$HOME/.claude/settings.json" ] && FILES="$FILES .claude/settings.json"
TAROPT=""; tar --version 2>/dev/null | grep -q GNU && TAROPT="--warning=no-file-changed"

if [ "$MODE" = "restore" ]; then
  LAST="$FROM"; [ -n "$LAST" ] || LAST=$(ls -1t "$HOME"/backups/herdr/sebelum-custom-pixelhq-*.tar.gz 2>/dev/null | head -n 1)
  [ -n "$LAST" ] || { echo "Gak ada backup dari install.sh di ~/backups/herdr/." >&2; exit 1; }
  rc=0; tar czf "$BK" $TAROPT --exclude='herdr-app.sock' -C "$HOME" $FILES || rc=$?
  [ "$rc" -le 1 ] || { echo "Backup gagal (tar keluar $rc), dibatalin." >&2; exit 1; }
  echo "Backup kondisi sekarang: $BK"
  leave_layout
  # buang mod company-* dulu, biar mod yang gak ada di backup (mis. company-kanban) gak tertinggal
  for d in "$CFG"/mods/company-*; do [ -d "$d" ] && rm -rf "$d"; done
  tar xzf "$LAST" -C "$HOME"
  echo "Dipulihkan dari $LAST"
  echo "Restart Herdr biar semuanya kepake."
  exit 0
fi

rc=0; tar czf "$BK" $TAROPT --exclude='herdr-app.sock' -C "$HOME" $FILES || rc=$?
[ "$rc" -le 1 ] || { echo "Backup gagal (tar keluar $rc), dibatalin." >&2; exit 1; }
echo "Backup kondisi sekarang: $BK"

# 1. Claude Code: hook aktivitas dan statusLine (hanya yang punya Pixel HQ)
if [ -f "$HOME/.claude/settings.json" ]; then
  ACT="$CFG/mods/company-agents/claude-activity.py"
  [ -f "$ACT" ] || ACT="$(cd "$(dirname "$0")" && pwd)/mods/company-agents/claude-activity.py"
  [ -f "$ACT" ] && python3 "$ACT" uninstall || echo "claude-activity.py gak ketemu: hook dilewati"
  python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.claude/settings.json")
d = json.load(open(p))
cmd = (d.get("statusLine") or {}).get("command", "") if isinstance(d.get("statusLine"), dict) else str(d.get("statusLine") or "")
if "pixel-hq" in cmd or "claude-statusline" in cmd:
    del d["statusLine"]
    json.dump(d, open(p, "w"), indent=2)
    print("statusLine Pixel HQ dicabut")
else:
    print("statusLine bukan punya Pixel HQ, gak diubah")
PY
fi
rm -f "$HOME/.claude/pixel-hq-statusline.sh"

# 2. Herdr: mod, layout, tema
leave_layout
for d in "$CFG"/mods/company-*; do [ -d "$d" ] && rm -rf "$d"; done
rm -f "$CFG/layouts/pixel-hq.json" "$CFG/themes/pixel-hq.json"
echo "Mod company-*, layout, dan tema pixel-hq dihapus"
# hotkey Kanban/Usage yang dipasang install.sh, cuma yang masih menunjuk ke mod Pixel HQ
if [ -f "$CFG/keys.json" ]; then
  python3 - "$CFG/keys.json" <<'PY'
import json, os, sys
KEYS = {"ctrl-shift-j": "mod.open:company-kanban", "ctrl-shift-m": "mod.open:company-usage"}
p = sys.argv[1]
try:
    with open(p, encoding="utf-8") as fh:
        d = json.load(fh)
except Exception:
    sys.exit(0)
sec = d.get("layout:pixel-hq") if isinstance(d, dict) else None
if isinstance(sec, dict) and any(sec.get(k) == a for k, a in KEYS.items()):
    for k, a in KEYS.items():
        if sec.get(k) == a:
            del sec[k]
    if not sec:
        del d["layout:pixel-hq"]
    tmp = "%s.tmp.%d" % (p, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(d, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, p)
    print("Hotkey Kanban/Usage dicabut dari keys.json")
PY
fi

# 3. data
if [ "$MODE" = "purge" ]; then
  rm -f "$CFG/pixel-hq-kanban.json"
  rm -rf "$HOME/.local/state/pixel-hq"
  echo "Data kanban dan riwayat usage dihapus"
else
  echo "Data disimpan: $CFG/pixel-hq-kanban.json dan ~/.local/state/pixel-hq/ (hapus pakai --purge)"
fi

echo
echo "Selesai. Restart Herdr. Pasang lagi kapan aja pakai: sh install.sh"
