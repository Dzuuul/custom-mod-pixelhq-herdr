#!/usr/bin/env python3
"""Tambah task ke papan kanban Pixel HQ dari terminal, skrip, atau agent.

  pixel-hq-task "Judul task"                      masuk Antrean
  pixel-hq-task -k "Judul" -d "detail"            langsung Sedang dikerjakan (dikirim ke staf yang nganggur)
  pixel-hq-task -s api -m sonnet -e high -p tinggi --batas 30 --hentikan "Judul"
  git diff | pixel-hq-task -k -d - "Review perubahan ini"    detail dibaca dari stdin

Space: --space NAMA. Kalau gak diisi: space terminal Herdr tempat perintah ini jalan, kalau bukan di Herdr: space
yang lagi dibuka. Task ditulis ke pixel-hq-kanban-inbox.json di folder Herdr; mesin kanban (status bar Pixel HQ)
mengambilnya dalam beberapa detik, atau waktu Herdr dibuka lagi. Cuma file inbox itu yang ditulis perintah ini;
papan kanban sendiri gak pernah disentuh, jadi gak bisa bentrok dengan Herdr.
"""
import argparse
import json
import os
import random
import sys
import time

try:
    import fcntl  # Linux/macOS: kunci biar dua perintah barengan gak saling timpa
except ImportError:  # Windows pakai pixel-hq-task.ps1
    fcntl = None

MODELS = ["opus", "sonnet", "haiku", "fable"]
EFFORTS = ["low", "medium", "high", "xhigh", "max"]
KEEP_S = 7 * 86400  # entri yang gak pernah diambil dibuang setelah seminggu


def herdr_home() -> str:
    return os.environ.get("HERDR_APP_HOME") or os.path.join(os.path.expanduser("~"), ".config", "herdr-app")


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return default
    except Exception:
        return default


def new_id() -> str:
    n, digits, out = int(time.time() * 1000), "0123456789abcdefghijklmnopqrstuvwxyz", ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return "c" + out + "".join(random.choice(digits) for _ in range(3))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="pixel-hq-task", description="Tambah task ke papan kanban Pixel HQ.",
                                 epilog="Task diambil Herdr dalam beberapa detik (atau waktu Herdr dibuka).")
    ap.add_argument("judul", help="judul task, ini yang dikirim ke agent")
    ap.add_argument("-d", "--detail", default="", help="detail tambahan; '-' = baca dari stdin")
    ap.add_argument("-s", "--space", default="", help="nama space (lantai) yang ngerjain")
    ap.add_argument("-k", "--kerjakan", action="store_true", help="langsung masuk Sedang dikerjakan")
    ap.add_argument("-m", "--model", choices=MODELS)
    ap.add_argument("-e", "--effort", choices=EFFORTS)
    ap.add_argument("-p", "--prioritas", choices=["tinggi", "normal", "rendah"], default="normal")
    ap.add_argument("--batas", type=int, metavar="MENIT", help="batas waktu (1-1440 menit)")
    ap.add_argument("--hentikan", action="store_true", help="lewat batas = agent dihentikan (butuh --batas)")
    a = ap.parse_args(argv)

    title = a.judul.strip()
    if not title:
        ap.error("judul gak boleh kosong")
    detail = sys.stdin.read() if a.detail == "-" else a.detail
    if a.batas is not None and not 1 <= a.batas <= 1440:
        ap.error("--batas harus 1 sampai 1440 menit")
    if a.hentikan and a.batas is None:
        ap.error("--hentikan butuh --batas")

    cfg = herdr_home()
    if not os.path.isdir(cfg):
        print(f"Folder Herdr {cfg} gak ada. Jalanin Herdr sekali dulu (atau set HERDR_APP_HOME).", file=sys.stderr)
        return 1
    now = time.time()
    entry = {"id": new_id(), "title": title[:2000], "created": int(now * 1000), "column": "doing" if a.kerjakan else "todo"}
    if detail.strip():
        entry["detail"] = detail.strip()[:8000]
    if a.space.strip():
        entry["spaceName"] = a.space.strip()
    term = os.environ.get("HC_TERMINAL_ID", "")
    if term:
        entry["fromTerminal"] = term
    if a.model:
        entry["model"] = a.model
    if a.effort:
        entry["effort"] = a.effort
    if a.prioritas != "normal":
        entry["priority"] = a.prioritas
    if a.batas is not None:
        entry["limitMin"] = a.batas
        if a.hentikan:
            entry["limitStop"] = True

    inbox = os.path.join(cfg, "pixel-hq-kanban-inbox.json")
    with open(inbox + ".lock", "a") as lock:
        if fcntl:
            fcntl.flock(lock, fcntl.LOCK_EX)
        cur = read_json(inbox, [])
        if not isinstance(cur, list):
            cur = []
        # buang yang udah diambil Herdr (tercatat di papan) dan yang udah kelamaan
        board = read_json(os.path.join(cfg, "pixel-hq-kanban.json"), {})
        taken = set(board.get("imported") or []) if isinstance(board, dict) else set()
        if isinstance(board, dict):
            taken |= {t.get("id") for t in board.get("tasks") or [] if isinstance(t, dict)}
        cur = [e for e in cur if isinstance(e, dict) and e.get("id") not in taken
               and now * 1000 - (e.get("created") or 0) < KEEP_S * 1000]
        cur.append(entry)
        tmp = "%s.tmp.%d" % (inbox, os.getpid())
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(cur, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        os.replace(tmp, inbox)
    where = "Sedang dikerjakan" if a.kerjakan else "Antrean"
    print(f"Task masuk {where}: {title}")
    print("Herdr mengambilnya dalam beberapa detik (kalau Herdr lagi tutup, waktu dibuka lagi).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
