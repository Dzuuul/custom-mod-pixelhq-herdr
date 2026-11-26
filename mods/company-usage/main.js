// Dialog usage Claude Code: angka sekarang, grafik riwayat (sesi 5 jam: 24 jam terakhir, mingguan: 14 hari),
// dan pemakaian per staf (token, biaya, context) dari label terminal yang ditulis claude-statusline.sh.
// Data: ~/.local/state/pixel-hq/claude-usage.json dan claude-usage-history.json ([waktu, sesi %, minggu %]).
// Tab REKAP KANBAN: task yang kelar/gagal per hari, per staf, dan per model, dari pixel-hq-kanban-history.json
// (ditulis mesin kanban di company-status/kanban.js). Tombol REKAP di kanban membuka tab ini (shared "pixel-hq.usage-tab").
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { readState } from "./state.js";
import { agents, terminals, shared, setShared, theme, home, appHome, readTextFile, closeOverlay, props } from "herdr";

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

const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h) return `${h} jam ${m % 60} mnt`;
  if (m) return `${m} mnt ${s % 60} dtk`;
  return `${s} dtk`;
};
const PERIODS = [7, 30, 90];
const sum = (l, k) => l.reduce((a, r) => a + (typeof r[k] === "number" ? r[k] : 0), 0);
const mean = (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : null);
// Kelompokkan riwayat per `key` (staf/model): jumlah kelar, gagal, biaya, rata-rata durasi yang kelar. Urut dari yang paling banyak.
export function groupRuns(runs, key) {
  const by = new Map();
  for (const r of runs) {
    const k = r[key] || "-";
    const g = by.get(k) ?? { name: k, ok: 0, bad: 0, cost: 0, ms: [] };
    if (r.outcome === "kelar") { g.ok++; if (typeof r.ms === "number") g.ms.push(r.ms); } else g.bad++;
    if (typeof r.cost === "number") g.cost += r.cost;
    by.set(k, g);
  }
  return [...by.values()].map((g) => ({ ...g, avg: mean(g.ms) })).sort((a, b) => b.ok + b.bad - (a.ok + a.bad) || b.cost - a.cost);
}

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
    this.runs = [];
    this.days = PERIODS[0];
    // dibuka dari tombol REKAP di kanban: langsung ke tab rekap (sekali itu aja, berikutnya balik ke usage)
    this.tab = shared("pixel-hq.usage-tab") === "rekap" ? "rekap" : "usage";
    if (shared("pixel-hq.usage-tab")) setShared("pixel-hq.usage-tab", null);
    const load = (cx) => cx.spawn(async (cx) => {
      const [u, h, k] = await Promise.all([
        readState("claude-usage.json"),
        readState("claude-usage-history.json"),
        readTextFile(`${appHome()}/pixel-hq-kanban-history.json`).catch(() => null),
      ]);
      try { this.usage = u ? JSON.parse(u) : null; } catch {}
      try { const x = h ? JSON.parse(h) : []; this.history = Array.isArray(x) ? x : []; } catch {}
      try { const x = k ? JSON.parse(k)?.runs : []; this.runs = Array.isArray(x) ? x.filter((r) => r && typeof r === "object") : []; } catch {}
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

  tile(label, value, sub, color) {
    const t = theme();
    return v_flex().flex_1().gap(4).p(10).bg(t.surface).rounded(6)
      .child(div().text_size(10).text_color(t.dim).child(label))
      .child(div().text_size(18).font_bold().text_color(color).child(value))
      .child(div().text_size(10).text_color(t.muted).child(sub || " "));
  }

  // Batang per hari: hijau = kelar, merah = gagal/dihentikan (ditumpuk), tingginya relatif ke hari tersibuk.
  countBars(id, vals, height = 90) {
    const t = theme(), max = Math.max(1, ...vals.map((v) => v.ok + v.bad)), room = height - 12;
    const seg = (n) => Math.max(2, Math.round(room * n / max));
    return v_flex().id(id).gap(4)
      .child(h_flex().h(height).items_end().gap(2).p(6).bg(t.background).rounded(6)
        .children(vals.map((v, i) => v_flex().id(`${id}-${i}`).flex_1().min_w(2).justify_end()
          .tooltip(`${v.label}: ${v.ok} kelar${v.bad ? `, ${v.bad} gagal/dihentikan` : ""}${v.cost ? ` · $${v.cost.toFixed(2)}` : ""}`)
          .when(v.bad > 0, (el) => el.child(div().w_full().h(seg(v.bad)).bg("#f38ba8")))
          .when(v.ok > 0, (el) => el.child(div().w_full().h(seg(v.ok)).bg("#a6e3a1")))
          .when(!v.ok && !v.bad, (el) => el.child(div().w_full().h(1).bg(t.surface))))))
      .child(h_flex().justify_between().text_size(9.5).text_color(t.dim)
        .child(vals[0]?.label ?? "").child(vals[Math.floor(vals.length / 2)]?.label ?? "").child(vals[vals.length - 1]?.label ?? ""));
  }

  groupTable(id, title, rows) {
    const t = theme();
    const cell = (w, text, color) => div().w(w).flex_none().flex().justify_end().truncate().text_color(color).child(text);
    return v_flex().gap(3)
      .child(h_flex().gap(8).text_size(9.5).font_bold().text_color(t.dim)
        .child(div().flex_1().child(title)).child(cell(60, "KELAR", t.dim)).child(cell(60, "GAGAL", t.dim)).child(cell(110, "RATA DURASI", t.dim)).child(cell(80, "BIAYA", t.dim)))
      .children(rows.slice(0, 12).map((r, i) => h_flex().id(`${id}-${i}`).gap(8).px(4).py(3).text_size(11).rounded(4).hover((s) => s.bg(t.hover))
        .child(div().flex_1().min_w(0).truncate().child(r.name))
        .child(cell(60, String(r.ok), "#a6e3a1"))
        .child(cell(60, String(r.bad), r.bad ? "#f38ba8" : t.dim))
        .child(cell(110, r.avg == null ? "-" : fmtDur(r.avg), t.muted))
        .child(cell(80, r.cost ? `$${r.cost.toFixed(2)}` : "-", "#a6e3a1"))));
  }

  rekap() {
    const t = theme(), now = Date.now(), D = 86400000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const from = today.getTime() - (this.days - 1) * D;
    const runs = this.runs.filter((r) => (r.at ?? 0) >= from);
    if (!runs.length) {
      return v_flex().gap(8)
        .child(this.section("REKAP KANBAN", `${this.days} hari terakhir`))
        .child(div().text_size(11).text_color(t.dim).child(this.runs.length
          ? `Gak ada task yang kelar atau gagal dalam ${this.days} hari terakhir. Coba periode yang lebih panjang.`
          : "Belum ada riwayat. Rekap terisi setelah task kanban kelar, gagal, atau dihentikan (mulai versi 2.3). BERSIHKAN di kanban gak menghapus rekap."));
    }
    const ok = runs.filter((r) => r.outcome === "kelar"), stopped = runs.filter((r) => r.outcome === "dihentikan"), bad = runs.length - ok.length;
    const cost = sum(runs, "cost"), tok = sum(runs, "tokens"), avg = mean(ok.map((r) => r.ms).filter((x) => typeof x === "number"));
    const checked = runs.filter((r) => r.check), passed = checked.filter((r) => r.check === "lolos"), fixes = sum(checked, "fixes");
    const files = sum(ok.map((r) => r.diff ?? {}), "files");
    const n = Math.min(this.days, 30), start = today.getTime() - (n - 1) * D;
    const vals = Array.from({ length: n }, (_, i) => {
      const d = new Date(start + i * D), a = d.getTime(), b = a + D;
      const day = runs.filter((r) => r.at >= a && r.at < b);
      return { label: `${DAYS[d.getDay()]} ${d.getDate()}`, ok: day.filter((r) => r.outcome === "kelar").length, bad: day.filter((r) => r.outcome !== "kelar").length, cost: sum(day, "cost") };
    });
    return v_flex().gap(12)
      .child(h_flex().gap(10)
        .child(this.tile("KELAR", String(ok.length), files ? `${files} file diubah` : `dari ${runs.length} kali jalan`, "#a6e3a1"))
        .child(this.tile("GAGAL", String(bad), stopped.length ? `${stopped.length} di antaranya dihentikan` : bad ? "" : "mantap", bad ? "#f38ba8" : t.dim))
        .child(this.tile("BIAYA", `$${cost.toFixed(2)}`, ok.length ? `$${(cost / ok.length).toFixed(2)} per task kelar${tok ? ` · ${fmtTok(tok)} token` : ""}` : "", "#f9b84a"))
        .child(this.tile("RATA DURASI", avg == null ? "-" : fmtDur(avg), "task yang kelar, tanpa waktu nunggu jawaban", "#89b4fa"))
        .when(checked.length > 0, (el) => el.child(this.tile("CEK LOLOS", `${passed.length}/${checked.length}`, fixes ? `${fixes}x agent disuruh benerin` : "tanpa perlu dibenerin", "#74c7ec"))))
      .child(this.section("PER HARI", `${n} hari terakhir · hijau kelar, merah gagal/dihentikan`)).child(this.countBars("rekap-hari", vals))
      .child(this.section("PER STAF", "nama staf waktu task dikirim")).child(this.groupTable("rekap-staf", "STAF", groupRuns(runs, "staff")))
      .child(this.section("PER MODEL", "model yang dipilih di task, atau model staf waktu itu")).child(this.groupTable("rekap-model", "MODEL", groupRuns(runs, "model")))
      .child(div().text_size(10).text_color(t.dim).child(`Riwayat ${this.runs.length} kali jalan disimpan 90 hari di ~/.config/herdr-app/pixel-hq-kanban-history.json. Biaya = perkiraan dari statusline Claude Code.`));
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
    const rekap = this.tab === "rekap";
    const tabBtn = (id, label, on) => div().id(`tab-${id}`).px(8).h(22).flex().items_center().cursor_pointer().rounded(4).text_size(10.5).font_bold()
      .bg(on ? t.raised : t.chrome).text_color(on ? "#b4befe" : t.dim).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.tab = id; cx.notify(); }).child(label);
    const head = h_flex().items_center().gap(10)
      .child(h_flex().flex_1().gap(4).items_center().child(tabBtn("usage", "USAGE CLAUDE CODE", !rekap)).child(tabBtn("rekap", "REKAP KANBAN", rekap)))
      .when(!rekap && Boolean(stale), (el) => el.child(div().text_size(10).text_color("#f9b84a").child("data udah lebih dari 1 jam")))
      .when(!rekap, (el) => el.child(div().id("peringatan").px(7).h(20).flex().items_center().cursor_pointer().bg(t.raised).text_size(10).font_bold()
        .text_color(ths.length ? "#f9b84a" : t.dim).hover((s) => s.bg(t.hover))
        .tooltip("Kapan notifikasi usage muncul. Klik buat ganti: 80·95 → 70·90 → 50·80·95 → 90 → mati")
        .on_click(() => this.nextThresholds()).child(`PERINGATAN: ${thresholdText(ths)} ▾`)))
      .when(rekap, (el) => el.child(div().id("periode").px(7).h(20).flex().items_center().cursor_pointer().bg(t.raised).text_size(10).font_bold()
        .text_color("#89b4fa").hover((s) => s.bg(t.hover)).tooltip("Periode rekap. Klik buat ganti: 7 → 30 → 90 hari")
        .on_click((_e, cx) => { this.days = PERIODS[(PERIODS.indexOf(this.days) + 1) % PERIODS.length]; cx.notify(); }).child(`PERIODE: ${this.days} hari ▾`)))
      .child(div().id("tutup").px(7).h(20).flex().items_center().cursor_pointer().bg(t.raised).text_color(t.muted).text_size(10).font_bold()
        .hover((s) => s.bg(t.hover)).on_click(() => this.close()).child("TUTUP (ESC)"));
    const root = v_flex().size_full().bg(t.chrome).border_1().border_color(t.border).rounded(10).p(14).gap(12).font_family(MONO).text_color(t.foreground).child(head);
    if (rekap) return root.child(v_flex().id("isi-rekap").flex_1().min_h(0).gap(12).overflow_y_scrollbar().child(this.rekap()));
    return root
      .child(v_flex().id("isi").flex_1().min_h(0).gap(12).overflow_y_scrollbar()
        .child(h_flex().gap(10).child(this.now("SESI 5 JAM", u?.session)).child(this.now("MINGGU INI", u?.week)))
        .child(this.section("SESI 5 JAM", "24 jam terakhir, tertinggi tiap 30 menit")).child(this.bars("grafik-sesi", sVals, sLabels))
        .child(this.section("MINGGUAN", "14 hari terakhir, tertinggi tiap hari")).child(this.bars("grafik-minggu", wVals, wLabels))
        .child(this.section("PER STAF", "sesi yang lagi terbuka · biaya = perkiraan Claude Code, bukan tagihan"))
        .child(table)
        .child(div().text_size(10).text_color(t.dim).child(`${thresholdSentence(ths)} Riwayat disimpan 14 hari di ~/.local/state/pixel-hq/.`)));
  }
}
