#!/bin/sh
# Agent status line for Pixel HQ (Claude Code, Antigravity, and other compatible agents).
# The agent hands this script a JSON blob on stdin after every turn or status change;
# it tells Herdr how full the context is (labels agent.context / claude.context, 0-100),
# how much of the quota window is left (agent.quota / claude.quota, 0-100) and effort level (agent.effort / claude.effort)
# so the desk can show HP/SP bars, and prints a short status.
# Also clears the labels when the agent stops reporting them, so a stale number never outlives its source.
# Needs python3. Outside a Herdr terminal it only prints the status.
input=$(cat)
fields=$(printf '%s' "$input" | python3 -c '
import json, os, sys
try:
    d = json.load(sys.stdin)
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}

def clean(v):
    if not isinstance(v, str):
        v = "" if v is None else str(v)
    out = []
    for ch in v:
        o = ord(ch)
        if o <= 31 or o == 127:
            continue
        out.append(ch)
    return "".join(out).replace("|", "·")

m = d.get("model")
model = ""
if isinstance(m, dict):
    model = clean(m.get("display_name") or m.get("name") or m.get("id") or m.get("title") or "")
elif isinstance(m, str):
    model = clean(m)

if not model:
    model = clean(d.get("model_name") or d.get("model_id") or d.get("current_model") or "")

if not model:
    try:
        tp = clean(d.get("transcript_path") or "")
        if tp and os.path.exists(tp):
            for line in open(tp, "r", encoding="utf-8"):
                if "\"model\":" in line:
                    try:
                        ev = json.loads(line)
                        mod = (ev.get("message") or {}).get("model") or ev.get("model") or (ev.get("payload") or {}).get("model")
                        if mod and isinstance(mod, str):
                            model = clean(mod)
                    except Exception: pass
    except Exception: pass

if not model and d:
    for sp in [os.path.expanduser("~/.claude/settings.json"), os.path.expanduser("~/.gemini/antigravity-cli/settings.json")]:
        try:
            if os.path.exists(sp):
                sdata = json.load(open(sp, "r", encoding="utf-8"))
                model = clean(sdata.get("model") or "")
                if model: break
        except Exception: pass

c = (d.get("context_window") if isinstance(d.get("context_window"), dict) else {}) or {}
p = c.get("used_percentage")
if p is None:
    used_in = c.get("total_input_tokens")
    used_out = c.get("total_output_tokens")
    size = c.get("context_window_size")
    if used_in is not None and size:
        used = (used_in or 0) + (used_out or 0)
        p = used * 100.0 / size
if p is None:
    # older Claude Code: estimate from the last assistant message in the transcript
    try:
        last = None
        for line in open(clean(d.get("transcript_path") or "") or "/nonexistent"):
            try:
                u = (json.loads(line).get("message") or {}).get("usage")
            except Exception:
                u = None
            if u:
                last = u
        if last:
            used = last.get("input_tokens", 0) + last.get("cache_read_input_tokens", 0) + last.get("cache_creation_input_tokens", 0)
            size = 1000000 if "1m" in clean((d.get("model") or {}).get("id", "") if isinstance(d.get("model"), dict) else "").lower() else 200000
            p = used * 100.0 / size
    except Exception:
        pass
pct = str(max(0, min(100, int(round(p))))) if isinstance(p, (int, float)) else ""

# Quota: Claude Code rate_limits or Antigravity quota
q_pct = None
rl = d.get("rate_limits") if isinstance(d.get("rate_limits"), dict) else {}
five = rl.get("five_hour") if isinstance(rl.get("five_hour"), dict) else {}
if isinstance(five.get("used_percentage"), (int, float)) and 0 <= five["used_percentage"] <= 100:
    q_pct = int(round(100 - five["used_percentage"]))
elif isinstance(d.get("quota"), dict):
    q_dict = d["quota"]
    g5h = q_dict.get("gemini-5h") or q_dict.get("3p-5h")
    if isinstance(g5h, dict) and "remaining_fraction" in g5h and isinstance(g5h["remaining_fraction"], (int, float)):
        q_pct = int(round(g5h["remaining_fraction"] * 100))

quota = str(max(0, min(100, q_pct))) if q_pct is not None else ""

eff = d.get("effort") if isinstance(d.get("effort"), dict) else {}
effort = clean(eff.get("level") or (m.get("effort") if isinstance(m, dict) else "") or "")
# Usage for the status bar: 5-hour session and weekly window (percent used, reset time in epoch seconds)
try:
    sev = rl.get("seven_day") if isinstance(rl.get("seven_day"), dict) else {}
    if isinstance(five.get("used_percentage"), (int, float)) or isinstance(sev.get("used_percentage"), (int, float)):
        import time as _t
        ud = os.path.expanduser("~/.local/state/pixel-hq")
        os.makedirs(ud, exist_ok=True)
        _o = {"at": int(_t.time()), "session": {"used": five.get("used_percentage"), "resets": five.get("resets_at")}, "week": {"used": sev.get("used_percentage"), "resets": sev.get("resets_at")}}
        _tmp = ud + "/claude-usage.json.tmp.%d" % os.getpid()
        open(_tmp, "w").write(json.dumps(_o))
        os.replace(_tmp, ud + "/claude-usage.json")
        # Riwayat buat grafik di dialog usage: [waktu, sesi %, minggu %], paling sering tiap 5 menit
        # (atau kalau angkanya berubah), disimpan 14 hari.
        _hp = ud + "/claude-usage-history.json"
        try:
            _h = json.load(open(_hp))
            if not isinstance(_h, list): _h = []
        except Exception:
            _h = []
        _now = _o["at"]
        _row = [_now, five.get("used_percentage"), sev.get("used_percentage")]
        if not _h or _now - _h[-1][0] >= 300 or _h[-1][1:] != _row[1:]:
            _h = [r for r in _h if isinstance(r, list) and len(r) == 3 and _now - r[0] < 14 * 86400]
            if _h and _now - _h[-1][0] < 60: _h[-1] = _row
            else: _h.append(_row)
            _tmp = _hp + ".tmp.%d" % os.getpid()
            open(_tmp, "w").write(json.dumps(_h, separators=(",", ":")))
            os.replace(_tmp, _hp)
except Exception:
    pass
# Token dan biaya sesi ini, buat tabel per staf di dialog usage
cost = ""
tokens = ""
try:
    _c = d.get("cost") if isinstance(d.get("cost"), dict) else {}
    if isinstance(_c.get("total_cost_usd"), (int, float)): cost = "%.4f" % _c["total_cost_usd"]
    _ti, _to = c.get("total_input_tokens"), c.get("total_output_tokens")
    if isinstance(_ti, (int, float)) or isinstance(_to, (int, float)): tokens = str(int((_ti or 0) + (_to or 0)))
except Exception:
    pass
print(pct + "|" + model + "|" + quota + "|" + effort + "|" + cost + "|" + tokens)
' 2>/dev/null)
pct=${fields%%\|*}; rest=${fields#*\|}; model=${rest%%\|*}; rest=${rest#*\|}; quota=${rest%%\|*}; rest=${rest#*\|}
effort=${rest%%\|*}; rest=${rest#*\|}; cost=${rest%%\|*}; tokens=${rest#*\|}

if [ -n "$HC_TERMINAL_ID" ] && command -v hc >/dev/null 2>&1; then
  hc label "$HC_TERMINAL_ID" \
    "agent.context=$pct" "claude.context=$pct" "agy.context=$pct" \
    "agent.model=$model" "claude.model=$model" "agy.model=$model" \
    "agent.quota=$quota" "claude.quota=$quota" "agy.quota=$quota" \
    "agent.effort=$effort" "claude.effort=$effort" "agy.effort=$effort" \
    "agent.cost=$cost" "agent.tokens=$tokens" >/dev/null 2>&1 &
fi
if [ -n "$pct" ]; then
  if [ -n "$quota" ]; then printf '%s · %s%% context · %s%% 5h left' "$model" "$pct" "$quota"; else printf '%s · %s%% context' "$model" "$pct"; fi
else printf '%s' "$model"
fi
