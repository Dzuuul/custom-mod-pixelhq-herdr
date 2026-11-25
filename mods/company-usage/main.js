// Dialog usage Claude Code: angka sekarang, grafik riwayat (sesi 5 jam: 24 jam terakhir, mingguan: 14 hari),
// dan pemakaian per staf (token, biaya, context) dari label terminal yang ditulis claude-statusline.sh.
// Data: ~/.local/state/pixel-hq/claude-usage.json dan claude-usage-history.json ([waktu, sesi %, minggu %]).
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { readState } from "./state.js";
import { agents, terminals, shared, setShared, theme, home, readTextFile, closeOverlay, props } from "herdr";

const MONO = "JetBrains Mono, Menlo, monospace";
const dir = () => `${home()}/.local/state/pixel-hq`;
const color = (p) => (p >= 90 ? "#f38ba8" : p >= 70 ? "#f9b84a" : "#89b4fa");
const staffName = (a) => {
  const own = (shared("pixel-hq.names") ?? {})[a.pane]?.name; // nama acak/pilihan sendiri (company-agents/names.js)
  if (own) return own;
  const tab = (a.tab_name ?? "").trim();
  if (tab && !/^\d+$/.test(tab)) return tab;
  const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return a.pane_name || clean(a.title) || a.program?.name || a.address;
};
function fmtLeft(sec) {
  const d = sec * 1000 - Date.now();
  if (!sec || d <= 0) return "";
  const m = Math.floor(d / 60000), h = Math.floor(m / 60);
  if (h >= 48) return `${Math.floor(h / 24)} hari ${h % 24} jam lagi`;
  if (h >= 1) return `${h} jam ${m % 60} menit lagi`;
  return `${m} menit lagi`;
}
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const DAYS = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
// Ambang notifikasi usage, dibaca company-status (usageAlerts). Klik tombol PERINGATAN buat ganti ke pilihan berikutnya.
const THRESHOLDS_KEY = "pixel-hq.usage-thresholds";
const PRESETS = [[80, 95], [70, 90], [50, 80, 95], [90], []];
const thresholds = () => {
  const v = shared(THRESHOLDS_KEY);
  return Array.isArray(v) ? v.filter((n) => typeof n === "number" && n > 0 && n <= 100).sort((a, b) => a - b) : PRESETS[0];
};
const thresholdText = (ths) => (ths.length ? ths.map((n) => `${n}%`).join(" · ") : "mati");
const thresholdSentence = (ths) => ths.length
  ? `Notifikasi muncul saat sesi atau minggu ini lewat ${ths.length > 1 ? `${ths.slice(0, -1).map((n) => `${n}%`).join(", ")} dan ${ths[ths.length - 1]}%` : `${ths[0]}%`}.`
  : "Notifikasi usage dimatikan.";

// Nilai tertinggi per ember waktu; ember tanpa sampel = null (gak digambar).
function buckets(rows, idx, from, size, n) {
  const out = Array.from({ length: n }, () => null);
  for (const r of rows) {
    const v = r[idx], i = Math.floor((r[0] * 1000 - from) / size);
    if (typeof v !== "number" || i < 0 || i >= n) continue;
    out[i] = Math.max(out[i] ?? 0, v);
  }
  return out;
}

export default class Usage extends View {
  init(_p, cx) {
    this.usage = null;
    this.history = [];
    const load = (cx) => cx.spawn(async (cx) => {
      const [u, h] = await Promise.all([
        readState("claude-usage.json"),
        readState("claude-usage-history.json"),
      ]);
      try { this.usage = u ? JSON.parse(u) : null; } catch {}
      try { const x = h ? JSON.parse(h) : []; this.history = Array.isArray(x) ? x : []; } catch {}
      cx.notify();
    });
    load(cx);
    cx.timer.every(10000, (cx) => load(cx));
  }

  close() { const ov = props()?.overlay; if (ov) closeOverlay(ov); }

  nextThresholds() {
    const cur = JSON.stringify(thresholds()), i = PRESETS.findIndex((p) => JSON.stringify(p) === cur);
    setShared(THRESHOLDS_KEY, PRESETS[(i + 1) % PRESETS.length]);
  }

  section(title, sub) {
    const t = theme();
    return h_flex().gap(8).items_center().child(div().text_size(11).font_bold().text_color("#b4befe").child(title))
      .when(Boolean(sub), (el) => el.child(div().text_size(10).text_color(t.dim).child(sub)));
  }

  bars(id, values, labels, height = 90) {
    const t = theme();
    return v_flex().id(id).gap(4)
      .child(h_flex().h(height).items_end().gap(2).p(6).bg(t.background).rounded(6)
        .children(values.map((v, i) => div().id(`${id}-${i}`).flex_1().min_w(2)
          .h(v == null ? 1 : Math.max(2, Math.round((height - 12) * Math.min(100, v) / 100)))
          .bg(v == null ? t.surface : color(v)).tooltip(v == null ? `${labels[i]}: gak ada data` : `${labels[i]}: ${Math.round(v)}%`))))
      .child(h_flex().justify_between().text_size(9.5).text_color(t.dim)
        .child(labels[0] ?? "").child(labels[Math.floor(labels.length / 2)] ?? "").child(labels[labels.length - 1] ?? ""));
  }

  now(label, w) {
    const t = theme();
    if (typeof w?.used !== "number") return v_flex().flex_1().gap(4).p(10).bg(t.surface).rounded(6).child(div().text_size(10).text_color(t.dim).child(label)).child(div().text_color(t.dim).child("-"));
    const p = Math.round(w.used), left = fmtLeft(w.resets);
    return v_flex().flex_1().gap(5).p(10).bg(t.surface).rounded(6)
      .child(div().text_size(10).text_color(t.dim).child(label))
      .child(div().text_size(20).font_bold().text_color(color(p)).child(`${p}%`))
      .child(div().relative().w(300).h(6).bg(t.background).child(div().absolute().left(0).top(0).h(6).w(Math.max(2, Math.round(3 * Math.min(100, p)))).bg(color(p))))
      .child(div().text_size(10).text_color(t.muted).child(left ? `reset ${left}` : "waktu reset gak diketahui"));
  }

  staff() {
    const labels = new Map(); try { for (const x of terminals()) labels.set(x.address, x.labels ?? {}); } catch {}
    return agents().map((a) => {
      const L = labels.get(a.address) ?? {};
      const cost = Number.parseFloat(L["agent.cost"]), tok = Number.parseInt(L["agent.tokens"], 10), ctx = Number.parseInt(L["agent.context"] ?? L["claude.context"], 10);
      return { a, name: staffName(a), space: a.space_name, model: L["agent.model"] ?? L["claude.model"] ?? "", cost: Number.isFinite(cost) ? cost : null, tok: Number.isFinite(tok) ? tok : null, ctx: Number.isFinite(ctx) ? ctx : null };
    }).filter((r) => r.cost != null || r.tok != null).sort((x, y) => (y.cost ?? 0) - (x.cost ?? 0) || (y.tok ?? 0) - (x.tok ?? 0));
  }

  render() {
    const t = theme(), u = this.usage, H = 3600000, now = Date.now(), ths = thresholds();
    const stale = u && now / 1000 - (u.at ?? 0) > 3600;
    // sesi: 48 ember 30 menit; minggu: 14 hari (mulai tengah malam)
    const fromS = now - 24 * H, sLabels = Array.from({ length: 48 }, (_, i) => { const d = new Date(fromS + i * H / 2); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; });
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const fromW = today.getTime() - 13 * 24 * H, wLabels = Array.from({ length: 14 }, (_, i) => { const d = new Date(fromW + i * 24 * H); return `${DAYS[d.getDay()]} ${d.getDate()}`; });
    const sVals = buckets(this.history, 1, fromS, H / 2, 48), wVals = buckets(this.history, 2, fromW, 24 * H, 14);
    const rows = this.staff();
    const totCost = rows.reduce((s, r) => s + (r.cost ?? 0), 0), totTok = rows.reduce((s, r) => s + (r.tok ?? 0), 0);
    const cell = (w, text, color, right) => div().w(w).flex_none().truncate().text_color(color ?? t.foreground).when(Boolean(right), (el) => el.flex().justify_end()).child(text);
    const table = v_flex().gap(3)
      .child(h_flex().gap(8).text_size(9.5).font_bold().text_color(t.dim)
        .child(div().flex_1().child("STAF")).child(cell(120, "MODEL", t.dim)).child(cell(70, "CONTEXT", t.dim, true)).child(cell(70, "TOKEN", t.dim, true)).child(cell(80, "BIAYA", t.dim, true)))
      .children(rows.length ? rows.map((r) => h_flex().id(`staf-${r.a.address}`).gap(8).px(4).py(3).text_size(11).rounded(4).hover((s) => s.bg(t.hover))
        .child(v_flex().flex_1().min_w(0).child(div().truncate().child(r.name)).child(div().truncate().text_size(9.5).text_color(t.dim).child(r.space ?? "")))
        .child(cell(120, r.model || "-", "#cba6f7"))
        .child(cell(70, r.ctx == null ? "-" : `${r.ctx}%`, r.ctx == null ? t.dim : color(r.ctx), true))
        .child(cell(70, r.tok == null ? "-" : fmtTok(r.tok), t.muted, true))
        .child(cell(80, r.cost == null ? "-" : `$${r.cost.toFixed(2)}`, "#a6e3a1", true)))
        : [div().text_size(11).text_color(t.dim).child("Belum ada data per staf. Muncul setelah sesi Claude Code jalan minimal satu giliran.")])
      .when(rows.length > 1, (el) => el.child(h_flex().gap(8).px(4).pt(4).border_t(1).border_color(t.border).text_size(11).font_bold()
        .child(div().flex_1().child("TOTAL")).child(cell(120, "", t.dim)).child(cell(70, "", t.dim)).child(cell(70, fmtTok(totTok), t.muted, true)).child(cell(80, `$${totCost.toFixed(2)}`, "#a6e3a1", true))));
    return v_flex().size_full().bg(t.chrome).border_1().border_color(t.border).rounded(10).p(14).gap(12).font_family(MONO).text_color(t.foreground)
      .child(h_flex().items_center().gap(10)
        .child(div().flex_1().text_size(13).font_bold().text_color("#b4befe").child("USAGE CLAUDE CODE"))
        .when(Boolean(stale), (el) => el.child(div().text_size(10).text_color("#f9b84a").child("data udah lebih dari 1 jam")))
        .child(div().id("peringatan").px(7).h(20).flex().items_center().cursor_pointer().bg(t.raised).text_size(10).font_bold()
          .text_color(ths.length ? "#f9b84a" : t.dim).hover((s) => s.bg(t.hover))
          .tooltip("Kapan notifikasi usage muncul. Klik buat ganti: 80·95 → 70·90 → 50·80·95 → 90 → mati")
          .on_click(() => this.nextThresholds()).child(`PERINGATAN: ${thresholdText(ths)} ▾`))
        .child(div().id("tutup").px(7).h(20).flex().items_center().cursor_pointer().bg(t.raised).text_color(t.muted).text_size(10).font_bold()
          .hover((s) => s.bg(t.hover)).on_click(() => this.close()).child("TUTUP (ESC)")))
      .child(v_flex().id("isi").flex_1().min_h(0).gap(12).overflow_y_scrollbar()
        .child(h_flex().gap(10).child(this.now("SESI 5 JAM", u?.session)).child(this.now("MINGGU INI", u?.week)))
        .child(this.section("SESI 5 JAM", "24 jam terakhir, tertinggi tiap 30 menit")).child(this.bars("grafik-sesi", sVals, sLabels))
        .child(this.section("MINGGUAN", "14 hari terakhir, tertinggi tiap hari")).child(this.bars("grafik-minggu", wVals, wLabels))
        .child(this.section("PER STAF", "sesi yang lagi terbuka · biaya = perkiraan Claude Code, bukan tagihan"))
        .child(table)
        .child(div().text_size(10).text_color(t.dim).child(`${thresholdSentence(ths)} Riwayat disimpan 14 hari di ~/.local/state/pixel-hq/.`)));
  }
}
