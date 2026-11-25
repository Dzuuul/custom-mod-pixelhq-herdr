#!/bin/sh
# Diagnosa pemasangan custom Pixel HQ (Linux/macOS). Gak mengubah apa pun.
# Hasilnya disimpan ke ~/pixel-hq-doctor-<waktu>.txt, buat ditempel waktu lapor masalah.
command -v python3 >/dev/null || { echo "python3 dibutuhin." >&2; exit 1; }
exec python3 -I "$(cd "$(dirname "$0")" && pwd)/mods/company-agents/pixel-hq-doctor.py" "$@"
