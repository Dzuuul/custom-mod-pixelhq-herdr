import { View, div, svg } from "gpui-kit";
import { KanbanEngine } from "./kanban.js";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, agents, theme, run, window, keys, setBadge, openOverlay, shared, home, checking, readTextFile, notify } from "herdr";

const MONO = "JetBrains Mono, Menlo, monospace";

const notch = (c, [l, r, t, b]) => [
  div().absolute().left(l + 2).right(r + 2).top(t).bottom(b).bg(c),
  div().absolute().left(l).right(r).top(t + 2).bottom(b + 2).bg(c),
];
const box = (frame, fill, shadow) => [
  ...notch(shadow, [2, 0, 2, 0]),
  ...notch(frame, [0, 2, 0, 2]),
  ...notch(fill, [2, 4, 2, 4]),
];
// A pixel button: a framed, hard-shadowed chip with mono text.
const chip = (el, t) => el.relative().h(24).pl(9).pr(11).pt(4).pb(6).items_center().cursor_pointer()
  .children(box(t.raised, t.chrome, t.surface)).font_family(MONO).font_bold().text_size(10).text_color(t.muted)
  .hover(s => s.text_color(t.foreground));

// Claude Code usage (5-hour session and weekly window), written by claude-statusline.sh
function fmtLeft(sec) {
  const d = sec * 1000 - Date.now();
  if (!sec || d <= 0) return "";
  const m = Math.floor(d / 60000), h = Math.floor(m / 60);
  if (h >= 48) return `${Math.floor(h / 24)} hari ${h % 24} jam lagi`;
  if (h >= 1) return `${h} jam ${m % 60} menit lagi`;
  return `${m} menit lagi`;
}
// Peringatan sekali per jendela usage (sesi 5 jam / minggu) untuk tiap ambang; yang sudah muncul diingat
// di localStorage, jadi gak muncul lagi setelah restart sampai jendelanya reset.
// Ambangnya diatur dari dialog Usage Claude (tombol PERINGATAN), disimpan di shared("pixel-hq.usage-thresholds"):
// daftar persen, [] = mati. Belum pernah diatur = 80 dan 95.
const USAGE_ALERTS = [80, 95];
function usageThresholds() {
  const v = shared("pixel-hq.usage-thresholds");
  return Array.isArray(v) ? v.filter((n) => typeof n === "number" && n > 0 && n <= 100).sort((a, b) => a - b) : USAGE_ALERTS;
}
function usageAlerts(u) {
  if (!u || Date.now() / 1000 - (u.at ?? 0) > 3600) return;
  const ths = usageThresholds();
  if (!ths.length) return;
  let fired = {};
  try { fired = JSON.parse(localStorage.getItem("pixel-hq.usage-alerts") ?? "{}") ?? {}; } catch {}
  let dirty = false;
  for (const [id, label, w] of [["session", "sesi 5 jam", u.session], ["week", "minggu ini", u.week]]) {
    if (typeof w?.used !== "number") continue;
    const hit = ths.filter((th) => w.used >= th).pop();
    if (hit === undefined) continue;
    const key = `${id}:${w.resets ?? "?"}:${hit}`;
    if (fired[key]) continue;
    fired[key] = Date.now(); dirty = true;
    const left = fmtLeft(w.resets);
    try {
      notify({ title: `Usage Claude ${label} udah ${Math.round(w.used)}%`, body: left ? `Reset ${left}. Klik buat lihat detail.` : "Klik buat lihat detail.",
        level: hit >= 90 ? "error" : "warning", timeout: 20000, action: { name: "mod.open", args: { name: "company-usage" } } });
    } catch {}
  }
  if (dirty) {
    const week = Date.now() - 8 * 86400000;
    for (const k of Object.keys(fired)) if (fired[k] < week) delete fired[k];
    try { localStorage.setItem("pixel-hq.usage-alerts", JSON.stringify(fired)); } catch {}
  }
}
const usageColor = (p) => (p >= 90 ? "#f38ba8" : p >= 70 ? "#f9b84a" : "#89b4fa");
function usageCell(label, w, t) {
  if (typeof w?.used !== "number") return null;
  const p = Math.max(0, Math.min(100, Math.round(w.used)));
  return h_flex().gap(5).items_center()
    .child(div().text_color(t.dim).child(label))
    .child(div().relative().w(34).h(5).bg(t.surface).child(div().absolute().left(0).top(0).h(5).w(Math.max(1, Math.round(34 * p / 100))).bg(usageColor(p))))
    .child(div().text_color(usageColor(p)).child(`${p}%`));
}

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    if (checking()) return;
    this.usage = null;
    this.kb = new KanbanEngine();
    cx.timer.every(3000, (cx) => this.kb.tick().then(() => cx.notify()).catch(() => {}));
    const loadUsage = (cx) => cx.spawn(async (cx) => {
      try {
        const raw = await readTextFile(`${home()}/.local/state/pixel-hq/claude-usage.json`).catch(() => null);
        const u = raw ? JSON.parse(raw) : null;
        if (JSON.stringify(u) !== JSON.stringify(this.usage)) { this.usage = u; cx.notify(); }
        usageAlerts(u);
      } catch {}
    });
    loadUsage(cx);
    cx.timer.every(20000, (cx) => loadUsage(cx));
  }

  switcherHint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const all = keys().filter((k) => k.section === "global" && (k.action === "mod.open:company-switcher" || k.action === "mod.open:company-keymap"));
    const b = all.find((k) => k.keys === "ctrl-p" || k.keys === "cmd-p") ?? all[0];
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts ? parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("") : (mac ? "⌘P" : "Ctrl+P");
    return `${key} Pindah lantai`;
  }

  // Tombol yang membuka `action` (global, atau "layout:pixel-hq" yang dipasang installer), ditulis buat orang. "" kalau gak ada.
  keyOf(action) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => (k.section === "global" || k.section === "layout:pixel-hq") && k.action === action);
    if (!b) return "";
    const parts = b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b.keys.split("-");
    return parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
  }

  // Isi chip KANBAN: yang jalan (atau antrean), lalu yang perlu kamu urus: nanya balik, ditahan usage, gagal.
  kanbanText() {
    const c = this.kb?.counts ?? {};
    return ["KANBAN", c.doing ? `${c.doing} JALAN` : c.todo ? String(c.todo) : "", c.asking ? `${c.asking} NANYA` : "",
      c.held ? `${c.held} DITAHAN` : "", c.failed ? `${c.failed} GAGAL` : ""].filter(Boolean).join(" · ");
  }

  hint(t) {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key} PERINTAH` : "PERINTAH";
  }

  render() {
    const t = theme();
    const space = spaces().find(s => s.active);
    const activeTab = (space?.tabs ?? []).find(t => t.active) ?? space?.tabs?.[0];
    const leadPane = panes().find(p => p.tab === activeTab?.id && p.terminal) ?? focused();
    const currentBranch = space?.branch || leadPane?.branch;
    const list = agents();
    const n = (k) => list.filter(a => a.status === k).length;
    const wants = n("blocked") > 0 ? String(n("blocked")) : null;
    if (window()?.platform === "macos" && this.badge !== wants) {
      this.badge = wants;
      try { setBadge(wants); } catch { this.badge = undefined; }
    }
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/company-status/${icon}.svg`).size(13)).child(text.toUpperCase());
    const pill = (color, text) => h_flex().gap(6).items_center().child(div().size(6).bg(color)).child(text.toUpperCase());
    return h_flex().size_full().px(14).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.surface).font_family(MONO).text_size(11).text_color(t.muted)
      .child(div().font_bold().text_size(11).text_color("#b4befe").child("PIXEL HQ"))
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "Komputer ini"))
      .when(Boolean(currentBranch), el => el.child(label("branch", currentBranch)))
      .child(div().text_color(t.dim).child(`${list.length} ANGGOTA TIM`))
      .when(Boolean(shared("pixel-hq.updating")), (el) => el.child(
        h_flex().id("update-status-pill").gap(6).items_center().px(7).py(2)
          .bg("#89b4fa").text_color(t.chrome)
          .tooltip("Lagi download update Pixel HQ...")
          .child(div().font_bold().text_size(11).child("⏳ Lagi update Pixel HQ..."))
      ))
      .when(Boolean(!shared("pixel-hq.updating") && shared("pixel-hq.new-version")), (el) => {
        const upd = shared("pixel-hq.new-version");
        const urgent = Boolean(upd?.isUrgent);
        const pillBg = urgent ? (t.blocked ?? "#f38ba8") : t.accent;
        const verText = upd?.versionLabel ?? `v${upd.version}`;
        const pillText = urgent ? `⚠️ Update penting: ${verText}` : `✨ Update baru: ${verText}`;
        const tooltip = urgent
          ? `[Update Penting] Pixel HQ ${verText} udah rilis${upd.notes ? ` · ${upd.notes}` : ""} · Klik buat update sekarang`
          : `Pixel HQ ${verText} udah rilis${upd.notes ? ` · ${upd.notes}` : ""} · Klik buat update`;
        return el.child(
          h_flex().id("update-status-pill").gap(6).items_center().px(7).py(2)
            .bg(pillBg).text_color(t.chrome).cursor_pointer().hover(s => s.opacity(0.85))
            .tooltip(tooltip)
            .on_click(() => run("company-agents.update"))
            .child(div().font_bold().text_size(11).child(pillText))
        );
      })
      .when(n("working") > 0, el => el.child(pill("#89b4fa", `${n("working")} lagi ngetik`)))
      .when(n("blocked") > 0, el => el.child(div().id("needs-you-pill").cursor_pointer().px(4).hover(s => s.bg(t.hover))
        .tooltip("Buka daftar yang nunggu kamu")
        .on_click(() => openOverlay({ mod: "company-agents", kind: "popup", frame: "none", width: 340, height: Math.min(440, Math.max(150, 52 + n("blocked") * 56)), props: { needsYou: true } }))
        .child(pill(t.blocked ?? "#e8744f", `${n("blocked")} nunggu kamu`))))
      .when(n("done") > 0, el => el.child(pill(t.done ?? "#8ec07c", `${n("done")} kelar`)))
      .when(list.length - n("working") - n("blocked") - n("done") > 0, el => el.child(pill(t.dim ?? "#9a8f86", `${list.length - n("working") - n("blocked") - n("done")} lagi santai`)))
      .child(div().flex_1())
      .when(Boolean(this.usage && (usageCell("SESI", this.usage.session, t) || usageCell("MINGGU", this.usage.week, t))), (el) => {
        const u = this.usage, stale = Date.now() / 1000 - (u.at ?? 0) > 3600;
        const tip = `Pemakaian Claude Code${stale ? " (data udah lama, jalanin Claude dulu biar ke-update)" : ""}\n`
          + `Sesi 5 jam: ${typeof u.session?.used === "number" ? Math.round(u.session.used) + "% terpakai" : "-"}${fmtLeft(u.session?.resets) ? ", reset " + fmtLeft(u.session.resets) : ""}\n`
          + `Minggu ini: ${typeof u.week?.used === "number" ? Math.round(u.week.used) + "% terpakai" : "-"}${fmtLeft(u.week?.resets) ? ", reset " + fmtLeft(u.week.resets) : ""}`;
        const key = this.keyOf("mod.open:company-usage");
        return el.child(h_flex().id("claude-usage").gap(10).items_center().px(6).tooltip(`${tip}\nKlik${key ? ` (atau ${key})` : ""} buat riwayat dan pemakaian per staf`).opacity(stale ? 0.55 : 1)
          .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => run("mod.open", { name: "company-usage" }))
          .child(div().text_color(t.dim).child("CLAUDE"))
          .child(usageCell("SESI", u.session, t) ?? div())
          .child(usageCell("MINGGU", u.week, t) ?? div()));
      })
      .child(
        chip(h_flex(), t)
          .id("btn-switcher")
          .tooltip("Buka pindah lantai")
          .on_click(() => run("mod.open", { name: "company-switcher" }))
          .child(this.switcherHint().toUpperCase())
      )
      .child(
        chip(h_flex(), t)
          .id("btn-kanban")
          .tooltip(`Buka papan kanban${this.keyOf("mod.open:company-kanban") ? ` (${this.keyOf("mod.open:company-kanban")})` : ""}: task yang dipindah ke 'sedang dikerjakan' dikerjain agent otomatis`)
          .on_click(() => run("mod.open", { name: "company-kanban" }))
          .child(this.kanbanText())
      )
      .child(
        chip(h_flex(), t)
          .id("btn-hotkeys")
          .tooltip("Atur hotkey")
          .on_click(() => run("mod.open", { name: "company-hotkeys" }))
          .child("HOTKEY")
      )
      .child(
        chip(h_flex().id("palette"), t)
          .on_click(() => run("app.palette"))
          .tooltip("Buka palet perintah")
          .child(this.hint(t).toUpperCase())
      );
  }
}
