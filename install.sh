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

# 2b. hotkey Kanban dan Usage, cuma aktif di layout pixel-hq (bagian "layout:pixel-hq" di keys.json).
# Tombol yang udah kamu pakai buat hal lain gak ditimpa.
python3 - "$CFG/keys.json" <<'PY'
import json, os, sys
KEYS = {"ctrl-shift-j": "mod.open:company-kanban", "ctrl-shift-m": "mod.open:company-usage"}
p = sys.argv[1]
def skip(why):
    print(why + ": hotkey Kanban/Usage dilewati")
    sys.exit(0)
try:
    with open(p, encoding="utf-8") as fh:
        d = json.load(fh)
except FileNotFoundError:
    skip("keys.json belum ada (jalanin Herdr sekali dulu)")
except Exception:
    skip("keys.json gak kebaca sebagai JSON")
if not isinstance(d, dict):
    skip("keys.json bukan objek JSON")
sec = d.get("layout:pixel-hq")
if not isinstance(sec, dict):
    sec = {}
added, skipped = [], []
for key, act in KEYS.items():
    if sec.get(key) == act:
        continue
    used = [n for n in ("layout:pixel-hq", "terminal", "global") if isinstance(d.get(n), dict) and key in d[n] and d[n][key] != act]
    if used:
        skipped.append("%s (udah dipakai di %s)" % (key, used[0]))
        continue
    sec[key] = act
    added.append(key)
if added:
    d["layout:pixel-hq"] = sec
    tmp = "%s.tmp.%d" % (p, os.getpid())
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(d, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    os.replace(tmp, p)
    print("Hotkey dipasang: " + ", ".join("%s = %s" % (k, KEYS[k].split(":")[1]) for k in added))
for s in skipped:
    print("Hotkey dilewati: " + s)
PY

# 2c. perintah terminal `pixel-hq-task` (tambah task ke kanban dari terminal/skrip), di ~/.local/bin.
# Isinya cuma memanggil skrip di folder mod, jadi ikut terbarui waktu mod-nya diperbarui.
BIN="$HOME/.local/bin"; TASKCMD="$BIN/pixel-hq-task"
if { [ -e "$TASKCMD" ] || [ -L "$TASKCMD" ]; } && ! grep -q 'custom Pixel HQ' "$TASKCMD" 2>/dev/null; then
  echo "$TASKCMD udah ada dan bukan punya Pixel HQ, gak ditimpa."
else
  mkdir -p "$BIN"
  cat > "$TASKCMD" <<EOF
#!/bin/sh
# pixel-hq-task: dipasang custom Pixel HQ (install.sh), dicopot uninstall.sh. Tambah task ke kanban Herdr.
export HERDR_APP_HOME="\${HERDR_APP_HOME:-$CFG}"
exec python3 "$CFG/mods/company-kanban/pixel-hq-task.py" "\$@"
EOF
  chmod +x "$TASKCMD"
  echo "Perintah terminal dipasang: pixel-hq-task \"judul task\"   (bantuan: pixel-hq-task -h)"
  case ":$PATH:" in *":$BIN:"*) ;; *) echo "  $BIN belum ada di PATH: jalankan $TASKCMD, atau tambahkan folder itu ke PATH." ;; esac
fi

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
