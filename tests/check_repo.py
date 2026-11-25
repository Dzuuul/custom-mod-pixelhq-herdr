#!/usr/bin/env python3
"""Pemeriksaan isi repo yang gak butuh Herdr. Jalankan dari mana aja: python3 tests/check_repo.py

- daftar cadangan updater (PIXEL_HQ_FILES di updater.js) sama dengan isi layouts/, mods/, themes/ di git
- skrip Windows (.ps1, .cmd) ASCII saja (PowerShell 5.1 membacanya sebagai ANSI) dan gak ada BOM di file lain
- semua file JSON di layouts/, themes/, mods/ valid; version.json punya versi x.y.z
- state.js di company-status dan company-usage sama persis (mod gak bisa saling impor)
- skrip .sh lolos `sh -n`, skrip .py lolos kompilasi
- .gitattributes masih mengatur akhir baris (.sh LF, .ps1/.cmd CRLF)
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
errors = []


def fail(msg):
    errors.append(msg)
    print(f"GAGAL {msg}")


def git_files():
    out = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    # file yang dihapus tapi belum di-commit gak dihitung
    return sorted(f for f in out.decode().split("\0") if f and os.path.exists(os.path.join(ROOT, f)))


def skip(p):  # sama dengan SKIP di updater.js
    return p.endswith((".d.ts", "jsconfig.json", ".png", "README.md")) or "company-music/" in p


def main() -> int:
    files = git_files()

    src = open(os.path.join(ROOT, "mods/company-agents/updater.js"), encoding="utf-8").read()
    m = re.search(r"const PIXEL_HQ_FILES = \[(.*?)\];", src, re.S)
    listed = set(re.findall(r'"([^"]+)"', m.group(1))) if m else set()
    if not listed:
        fail("PIXEL_HQ_FILES gak ketemu di updater.js")
    want = {f for f in files if f.split("/")[0] in ("layouts", "mods", "themes") and not skip(f)}
    for f in sorted(want - listed):
        fail(f"updater.js: {f} ada di repo tapi gak ada di PIXEL_HQ_FILES (pengguna gak kebagian kalau API GitHub kena batas)")
    for f in sorted(listed - want):
        fail(f"updater.js: {f} ada di PIXEL_HQ_FILES tapi gak ada di repo")

    for f in files:
        path = os.path.join(ROOT, f)
        data = open(path, "rb").read()
        if f.endswith((".ps1", ".cmd")):
            bad = [i for i, b in enumerate(data) if b > 127]
            if bad:
                line = data[:bad[0]].count(b"\n") + 1
                fail(f"{f}:{line}: ada karakter non-ASCII (PowerShell 5.1 salah baca)")
        if data.startswith(b"\xef\xbb\xbf"):
            fail(f"{f}: ada BOM di awal file")
        if f.endswith(".json") and f.split("/")[0] in ("layouts", "mods", "themes"):
            try:
                json.loads(data.decode("utf-8"))
            except ValueError as e:
                fail(f"{f}: JSON gak valid ({e})")
        if f.endswith(".sh"):
            r = subprocess.run(["sh", "-n", path], capture_output=True, text=True)
            if r.returncode:
                fail(f"{f}: sh -n gagal: {r.stderr.strip()}")
        if f.endswith(".py"):
            try:
                compile(data, f, "exec")
            except SyntaxError as e:
                fail(f"{f}: Python gak valid ({e})")

    v = json.load(open(os.path.join(ROOT, "mods/company-agents/version.json"), encoding="utf-8"))
    if not re.fullmatch(r"\d+\.\d+\.\d+", str(v.get("version", ""))):
        fail(f"version.json: versi '{v.get('version')}' bukan x.y.z")

    a = open(os.path.join(ROOT, "mods/company-status/state.js"), "rb").read()
    b = open(os.path.join(ROOT, "mods/company-usage/state.js"), "rb").read()
    if a != b:
        fail("mods/company-status/state.js dan mods/company-usage/state.js beda (harus sama persis)")

    attrs = open(os.path.join(ROOT, ".gitattributes"), encoding="utf-8").read()
    for rule in ("*.sh text eol=lf", "*.cmd text eol=crlf", "*.ps1 text eol=crlf"):
        if rule not in attrs:
            fail(f".gitattributes: aturan '{rule}' hilang")

    print(f"{len(files)} file diperiksa, {len(errors)} masalah")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
