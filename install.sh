#!/bin/sh
# Pasang custom Pixel HQ ke Herdr di komputer ini.
# Syarat: Herdr sudah terpasang dan pernah dijalankan (folder konfigurasinya ada), python3 tersedia.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
CFG="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
[ -d "$CFG" ] || { echo "Folder $CFG gak ada. Jalanin Herdr sekali dulu." >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 dibutuhin." >&2; exit 1; }

# 1. backup kondisi lama
BK="$HOME/backups/herdr/sebelum-custom-pixelhq-$(date +%Y%m%d-%H%M%S).tar.gz"
mkdir -p "$(dirname "$BK")"
FILES="${CFG#$HOME/}"; [ -f "$HOME/.claude/settings.json" ] && FILES="$FILES .claude/settings.json"
# Herdr yang lagi jalan terus nulis file, jadi GNU tar bisa keluar dengan kode 1 ("file changed").
# Itu masih backup yang valid; kode >1 berarti backup gagal beneran, jadi pemasangan dibatalin.
TAROPT=""; tar --version 2>/dev/null | grep -q GNU && TAROPT="--warning=no-file-changed"
rc=0; tar czf "$BK" $TAROPT --exclude='herdr-app.sock' -C "$HOME" $FILES || rc=$?
[ "$rc" -le 1 ] || { echo "Backup gagal (tar keluar $rc), pemasangan dibatalin." >&2; exit 1; }
echo "Backup kondisi lama: $BK"

# 2. layout, tema, mod (mod company-* ditimpa; file lain di konfigurasi kamu gak disentuh)
mkdir -p "$CFG/layouts" "$CFG/themes" "$CFG/mods"
cp "$HERE/layouts/pixel-hq.json" "$CFG/layouts/"
cp "$HERE/themes/pixel-hq.json" "$CFG/themes/"
for d in "$HERE"/mods/company-*; do
  rm -rf "$CFG/mods/$(basename "$d")"; cp -r "$d" "$CFG/mods/"
done
rm -rf "$CFG/mods/company-music"   # MusicBox sengaja dihilangin di versi ini

# 3. Claude Code: statusLine (buat chip usage) dan hook aktivitas
if [ -d "$HOME/.claude" ]; then
  cp "$HERE/mods/company-agents/claude-statusline.sh" "$HOME/.claude/pixel-hq-statusline.sh"
  python3 - <<'PY'
import json, os
p = os.path.expanduser("~/.claude/settings.json")
d = json.load(open(p)) if os.path.exists(p) else {}
if not d.get("statusLine"):
    d["statusLine"] = {"type": "command", "command": "sh " + os.path.expanduser("~/.claude/pixel-hq-statusline.sh")}
    json.dump(d, open(p, "w"), indent=2)
    print("statusLine dipasang")
else:
    print("statusLine sudah ada, gak diubah:", d["statusLine"].get("command"))
PY
  python3 "$CFG/mods/company-agents/claude-activity.py" install || true
else
  echo "~/.claude gak ada: lewati statusLine dan hook Claude Code."
fi

echo
echo "Selesai. Aktifkan layout-nya:"
echo "  herdr-app do layout.switch '{\"name\":\"pixel-hq\"}'"
echo "lalu cek: herdr-app status   (errors harus kosong)"
