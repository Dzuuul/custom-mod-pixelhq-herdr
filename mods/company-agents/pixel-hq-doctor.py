#!/usr/bin/env python3
"""Diagnosa pemasangan custom Pixel HQ (Linux/macOS). Gak mengubah apa pun.

  sh doctor.sh                                               dari folder repo
  python3 ~/.config/herdr-app/mods/company-agents/pixel-hq-doctor.py

Hasilnya ditampilkan dan disimpan ke ~/pixel-hq-doctor-<waktu>.txt, buat ditempel waktu lapor masalah.
Laporannya gak berisi isi task, balasan agent, atau isi settings.json selain bagian Pixel HQ, dan folder home
ditulis "~". Versi Windows: pixel-hq-doctor.ps1 (doctor.cmd di folder repo).
"""
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
CFG = os.environ.get("HERDR_APP_HOME") or os.path.join(HOME, ".config", "herdr-app")
STATE = os.path.join(HOME, ".local", "state", "pixel-hq")
HERE = os.path.dirname(os.path.abspath(__file__))
HOOK_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop",
               "UserPromptSubmit", "Stop", "SessionStart", "SessionEnd"]
NOW = time.time()
# Sama dengan SKIP di updater.js: file yang memang gak diunduh/dipasang.
SKIP = lambda p: p.endswith((".d.ts", "jsconfig.json", ".png", "README.md")) or "company-music/" in p  # noqa: E731

lines = []
count = {"MASALAH": 0, "AWAS": 0}


def hide(s) -> str:
    return str(s).replace(HOME, "~")


def say(s="") -> None:
    lines.append(hide(s))


def section(title) -> None:
    say()
    say(f"== {title}")


def mark(kind, text, fix="") -> None:
    if kind in count:
        count[kind] += 1
    say(f"  {kind:<8}{text}")
    if fix:
        say(f"          -> {fix}")


def ok(text):
    mark("ok", text)


def info(text):
    mark("info", text)


def warn(text, fix=""):
    mark("AWAS", text, fix)


def bad(text, fix=""):
    mark("MASALAH", text, fix)


def read_json(path):
    """(isi, None) kalau berhasil, (None, "gak ada") / (None, pesan error) kalau gagal."""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh), None
    except FileNotFoundError:
        return None, "gak ada"
    except Exception as e:  # noqa: BLE001
        return None, f"gak kebaca: {e}"


def ago(sec) -> str:
    s = max(0, int(NOW - sec))
    if s < 90:
        return f"{s} dtk lalu"
    if s < 5400:
        return f"{s // 60} mnt lalu"
    if s < 172800:
        return f"{s // 3600} jam lalu"
    return f"{s // 86400} hari lalu"


def run(argv, timeout=10):
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except FileNotFoundError:
        return None
    except subprocess.TimeoutExpired:
        return -1, "", "timeout"


def same_text(a, b) -> bool:
    try:
        with open(a, "rb") as fa, open(b, "rb") as fb:
            return fa.read().replace(b"\r\n", b"\n") == fb.read().replace(b"\r\n", b"\n")
    except OSError:
        return False


def updater_files(path):
    """Daftar file Pixel HQ dari updater.js (PIXEL_HQ_FILES), atau None."""
    try:
        src = open(path, encoding="utf-8").read()
    except OSError:
        return None
    m = re.search(r"const PIXEL_HQ_FILES = \[(.*?)\];", src, re.S)
    return [f for f in re.findall(r'"([^"]+)"', m.group(1)) if not SKIP(f)] if m else None


def check_system():
    section("Sistem")
    info(f"{platform.system()} {platform.release()} ({platform.machine()}), Python {platform.python_version()}")
    info(f"folder Herdr: {CFG}" + (" (dari HERDR_APP_HOME)" if os.environ.get("HERDR_APP_HOME") else ""))


def check_herdr():
    section("Herdr")
    if not os.path.isdir(CFG):
        bad(f"folder {CFG} gak ada", "jalankan Herdr sekali, lalu pasang lagi (sh install.sh)")
        return False
    exe = shutil.which("herdr-app")
    if not exe:
        warn("herdr-app gak ada di PATH, status Herdr gak bisa dicek")
        return True
    r = run([exe, "--version"])
    if r and r[0] == 0:
        info(r[1].strip().splitlines()[0] if r[1].strip() else "herdr-app")
    r = run([exe, "status"])
    st = None
    if r and r[0] == 0:
        try:
            st = json.loads(r[1])
        except ValueError:
            st = None
    if not isinstance(st, dict):
        info("Herdr lagi gak jalan (herdr-app status gak menjawab)")
        return True
    layout = st.get("layout")
    if layout == "pixel-hq":
        ok("layout aktif: pixel-hq")
    else:
        warn(f"layout aktif: {layout}", "herdr-app do layout.switch '{\"name\":\"pixel-hq\"}'")
    errs = st.get("errors") or []
    if errs:
        for e in errs[:8]:
            bad(f"error Herdr: {json.dumps(e, ensure_ascii=False)[:300]}")
    else:
        ok("Herdr gak melaporkan error")
    return True


def check_pixelhq():
    section("Pixel HQ")
    mine, err = read_json(os.path.join(CFG, "mods", "company-agents", "version.json"))
    if err:
        bad(f"version.json terpasang {err}", "pasang lagi: sh install.sh")
    else:
        info(f"terpasang: {mine.get('version')} ({mine.get('base', '?')})")
    own = os.path.join(HERE, "version.json")
    if os.path.normcase(os.path.realpath(HERE)) != os.path.normcase(os.path.realpath(os.path.join(CFG, "mods", "company-agents"))):
        repo, rerr = read_json(own)
        if not rerr:
            if mine and repo.get("version") != mine.get("version"):
                warn(f"repo ini versi {repo.get('version')}, yang terpasang {mine.get('version')}", "sh install.sh")
            else:
                info(f"repo ini versi {repo.get('version')}")
    files = updater_files(os.path.join(CFG, "mods", "company-agents", "updater.js"))
    if files is None:
        bad("daftar file Pixel HQ (updater.js) gak kebaca", "pasang lagi: sh install.sh")
    else:
        missing = [f for f in files if not os.path.exists(os.path.join(CFG, f))]
        if missing:
            bad(f"{len(missing)} file Pixel HQ gak ada: " + ", ".join(missing[:10]) + (" …" if len(missing) > 10 else ""),
                "pasang lagi (sh install.sh) atau update dari tombol update")
        else:
            ok(f"{len(files)} file Pixel HQ lengkap")
    if os.path.isdir(os.path.join(CFG, "mods", "company-music")):
        warn("mod company-music (MusicBox) masih ada", "sh install.sh menghapusnya")


def check_keys():
    section("Hotkey")
    k, err = read_json(os.path.join(CFG, "keys.json"))
    if err == "gak ada":
        info("keys.json belum ada (dibuat Herdr)")
        return
    if err or not isinstance(k, dict):
        bad(f"keys.json {err or 'bukan objek JSON'}", "perbaiki atau hapus keys.json, lalu sh install.sh")
        return
    sec = k.get("layout:pixel-hq") if isinstance(k.get("layout:pixel-hq"), dict) else {}
    for key, act in (("ctrl-shift-j", "mod.open:company-kanban"), ("ctrl-shift-m", "mod.open:company-usage")):
        if sec.get(key) == act:
            ok(f"{key} = {act.split(':')[1]}")
        else:
            info(f"{key} buat {act.split(':')[1]} gak dipasang (dilewati installer kalau tombolnya udah kepake)")


def check_claude():
    section("Claude Code")
    cdir = os.path.join(HOME, ".claude")
    if not os.path.isdir(cdir):
        info("~/.claude gak ada: statusLine dan hook gak dipasang")
        return
    s, err = read_json(os.path.join(cdir, "settings.json"))
    if err == "gak ada":
        warn("~/.claude/settings.json gak ada: statusLine dan hook Pixel HQ belum terpasang", "sh install.sh")
        return
    if err or not isinstance(s, dict):
        bad(f"~/.claude/settings.json {err or 'bukan objek JSON'}")
        return
    sl = s.get("statusLine")
    cmd = sl.get("command", "") if isinstance(sl, dict) else str(sl or "")
    if "pixel-hq-statusline" in cmd:
        ok(f"statusLine: {cmd}")
        copy = os.path.join(cdir, "pixel-hq-statusline.sh")
        if not os.path.exists(copy):
            bad("~/.claude/pixel-hq-statusline.sh gak ada", "buka Herdr (menyalinnya waktu start) atau sh install.sh")
        elif not same_text(copy, os.path.join(CFG, "mods", "company-agents", "claude-statusline.sh")):
            info("pixel-hq-statusline.sh beda dari versi mod (Herdr menyalin yang baru waktu start)")
    elif not cmd:
        warn("statusLine kosong: chip usage dan biaya per task gak keisi", "sh install.sh")
    else:
        info(f"statusLine punyamu sendiri ({cmd}): chip usage butuh statusLine Pixel HQ")
    hooks = s.get("hooks") if isinstance(s.get("hooks"), dict) else {}
    have, broken = [], []
    for ev in HOOK_EVENTS:
        cmds = [h.get("command", "") for g in hooks.get(ev) or [] if isinstance(g, dict)
                for h in g.get("hooks") or [] if isinstance(h, dict)]
        mine = [c for c in cmds if "claude-activity." in c]
        if mine:
            have.append(ev)
        for c in mine:
            m = re.search(r'"([^"]+claude-activity\.[a-z0-9]+)"', c)
            if m and not os.path.exists(m.group(1)):
                broken.append(m.group(1))
    if len(have) == len(HOOK_EVENTS):
        ok(f"hook aktivitas terpasang ({len(have)} event)")
    elif have:
        warn("hook aktivitas cuma sebagian: " + ", ".join(e for e in HOOK_EVENTS if e not in have) + " gak ada",
             "sh install.sh")
    else:
        warn("hook aktivitas gak terpasang: HASIL dan PERLU JAWABAN di kanban gak jalan", "sh install.sh")
    for b in sorted(set(broken)):
        bad(f"hook menunjuk ke file yang gak ada: {b}", "sh install.sh")


def check_data():
    section("Data")
    u, err = read_json(os.path.join(STATE, "claude-usage.json"))
    if err == "gak ada":
        warn("claude-usage.json belum ada: statusLine Pixel HQ belum pernah jalan", "pakai Claude Code sekali di Herdr")
    elif err or not isinstance(u, dict):
        bad(f"claude-usage.json {err or 'bukan objek JSON'}")
    else:
        part = []
        for label, key in (("sesi", "session"), ("minggu", "week")):
            w = u.get(key) or {}
            if isinstance(w.get("used"), (int, float)):
                part.append(f"{label} {round(w['used'])}%")
        info(f"usage: {', '.join(part) or '-'} (ditulis {ago(u.get('at') or 0)})")
    h, err = read_json(os.path.join(STATE, "claude-usage-history.json"))
    if not err and isinstance(h, list):
        info(f"riwayat usage: {len(h)} titik")
    last = os.path.join(STATE, "last")
    if os.path.isdir(last):
        names = [os.path.join(last, n) for n in os.listdir(last) if n.endswith(".json")]
        if names:
            info(f"hasil kerja tersimpan: {len(names)} terminal, terbaru {ago(max(os.path.getmtime(n) for n in names))}")
    b, err = read_json(os.path.join(CFG, "pixel-hq-kanban.json"))
    if err == "gak ada":
        info("papan kanban belum ada")
    elif err or not isinstance(b, dict) or not isinstance(b.get("tasks"), list):
        bad(f"pixel-hq-kanban.json {err or 'formatnya salah'}: mesin kanban berhenti", "ekspor dulu kalau bisa, lalu perbaiki/hapus file itu")
    else:
        t = [x for x in b["tasks"] if isinstance(x, dict)]
        n = lambda f: sum(1 for x in t if f(x))  # noqa: E731
        info(f"kanban: {n(lambda x: x.get('column') == 'todo')} antrean, {n(lambda x: x.get('column') == 'doing' and not x.get('failed'))} jalan, "
             f"{n(lambda x: x.get('column') == 'done')} selesai, {n(lambda x: x.get('failed') and not x.get('stopped'))} gagal, "
             f"{n(lambda x: x.get('asking') and not x.get('failed'))} nanya balik, {n(lambda x: x.get('held') and not x.get('failed'))} ditahan")
    inbox, err = read_json(os.path.join(CFG, "pixel-hq-kanban-inbox.json"))
    if not err and isinstance(inbox, list):
        taken = set((b or {}).get("imported") or []) | {x.get("id") for x in (b or {}).get("tasks") or [] if isinstance(x, dict)} if isinstance(b, dict) else set()
        waiting = [e for e in inbox if isinstance(e, dict) and e.get("id") not in taken]
        if waiting:
            info(f"{len(waiting)} task dari pixel-hq-task belum diambil (Herdr mengambilnya waktu jalan)")


def check_terminal():
    section("Perintah terminal")
    exe = shutil.which("pixel-hq-task")
    if exe:
        ok(f"pixel-hq-task: {exe}")
    else:
        info("pixel-hq-task gak ada di PATH (dipasang install.sh ke ~/.local/bin)")
    if not shutil.which("python3"):
        bad("python3 gak ada: hook aktivitas dan statusLine gak jalan")


def main() -> int:
    say(f"Pixel HQ doctor · {time.strftime('%Y-%m-%d %H:%M:%S')}")
    check_system()
    if check_herdr():
        check_pixelhq()
        check_keys()
    check_claude()
    check_data()
    check_terminal()
    say()
    say(f"Ringkasan: {count['MASALAH']} masalah, {count['AWAS']} peringatan")
    say("Laporan ini gak berisi isi task, balasan agent, atau isi settings.json selain bagian Pixel HQ.")
    text = "\n".join(lines) + "\n"
    path = os.path.join(HOME, f"pixel-hq-doctor-{time.strftime('%Y%m%d-%H%M%S')}.txt")
    try:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        text += f"Disimpan ke {hide(path)}\n"
    except OSError as e:
        text += f"Gagal menyimpan laporan: {e}\n"
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
