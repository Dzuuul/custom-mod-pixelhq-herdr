// Papan kanban: antrean, sedang dikerjakan, selesai. Tiap task terikat ke satu space (sesi).
// Task yang dipindah ke "Sedang dikerjakan" dikirim otomatis ke agent di space itu oleh
// company-status/kanban.js (mesinnya hidup terus, dialog ini cuma tampilan). Data: ~/.config/herdr-app/pixel-hq-kanban.json
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, agents, theme, appHome, readTextFile, writeTextFile, closeOverlay, props } from "herdr";

const staffName = (a) => {
  const tab = (a.tab_name ?? "").trim();
  if (tab && !/^\d+$/.test(tab)) return tab;
  const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return a.pane_name || clean(a.title) || a.program?.name || a.address;
};
const MODELS = ["opus", "sonnet", "haiku", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MONO = "JetBrains Mono, Menlo, monospace";
const file = () => `${appHome()}/pixel-hq-kanban.json`;
const COLS = [
  { id: "todo", label: "ANTREAN", color: "#89b4fa" },
  { id: "doing", label: "SEDANG DIKERJAKAN", color: "#f9b84a" },
  { id: "done", label: "SELESAI", color: "#a6e3a1" },
];

async function mutate(fn) {
  const raw = await readTextFile(file()).catch(() => null);
  let d; try { d = raw ? JSON.parse(raw) : null; } catch { d = null; }
  d = d && Array.isArray(d.tasks) ? d : { tasks: [] };
  fn(d);
  await writeTextFile(file(), JSON.stringify(d, null, 2), raw);
  return d;
}

export default class Kanban extends View {
  init(_p, cx) {
    this.tasks = [];
    this.spaceIdx = 0;
    this.col = "todo";
    this.agentIdx = 0;
    this.modelIdx = 0;
    this.effortIdx = 0;
    const load = (cx) => cx.spawn(async (cx) => {
      const raw = await readTextFile(file()).catch(() => null);
      try {
        const t = raw ? (JSON.parse(raw).tasks ?? []) : [];
        if (JSON.stringify(t) !== JSON.stringify(this.tasks)) { this.tasks = t; cx.notify(); }
      } catch {}
    });
    load(cx);
    cx.timer.every(2000, (cx) => load(cx));
    this.title = InputState.new({ placeholder: "Judul task (ini yang dikirim ke agent)" });
    this.detail = InputState.new({ placeholder: "Detail tambahan (opsional)" });
    this.title.on("submit", (_e, cx) => this.add(cx));
    this.detail.on("submit", (_e, cx) => this.add(cx));
    this.title.focus();
    cx.timer.after(200, () => this.title.focus());
    const sp = spaces();
    this.spaceIdx = Math.max(0, sp.findIndex((s) => s.active));
  }

  space() { const sp = spaces(); return sp[this.spaceIdx % Math.max(1, sp.length)] ?? null; }

  // agent yang bisa dipilih di space terpilih; indeks 0 = otomatis (agent mana pun yang nganggur)
  choices() {
    const sp = this.space();
    return sp ? agents().filter((a) => a.space === sp.id) : [];
  }
  agentLabel(a) { return staffName(a); }

  add(cx) {
    const title = this.title.value().trim(), sp = this.space();
    if (!title || !sp) return;
    const task = { id: `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, title, detail: this.detail.value().trim(), space: sp.id, spaceName: sp.name, column: "todo", created: Date.now() };
    const pick = this.choices()[this.agentIdx - 1];
    if (this.modelIdx) task.model = MODELS[this.modelIdx - 1];
    if (this.effortIdx) task.effort = EFFORTS[this.effortIdx - 1];
    if (pick) { task.target = pick.address; task.targetName = this.agentLabel(pick); }
    this.title.set_value(""); this.detail.set_value("");
    cx.spawn(async (cx) => { const d = await mutate((d) => d.tasks.push(task)); this.tasks = d.tasks; cx.notify(); });
  }

  move(id, column, cx) {
    cx.spawn(async (cx) => {
      const d = await mutate((d) => {
        const t = d.tasks.find((x) => x.id === id); if (!t) return;
        t.column = column;
        for (const k of ["sentAt", "agent", "seen", "byTab", "finishedAt", "preIdx"]) delete t[k];
        t.note = column === "doing" ? "Nunggu dikirim ke agent…" : "";
      });
      this.tasks = d.tasks; cx.notify();
    });
  }

  remove(id, cx) {
    cx.spawn(async (cx) => { const d = await mutate((d) => { d.tasks = d.tasks.filter((x) => x.id !== id); }); this.tasks = d.tasks; cx.notify(); });
  }

  btn(id, label, color, fn, tip) {
    const t = theme();
    return div().id(id).px(7).h(20).flex().items_center().cursor_pointer().bg(t.raised).text_color(color).font_family(MONO).text_size(10).font_bold()
      .hover((s) => s.bg(t.hover)).tooltip(tip).on_click((_e, cx) => fn(cx)).child(label);
  }

  card(task, ci) {
    const t = theme(), i = COLS.findIndex((c) => c.id === task.column);
    return v_flex().id(`card-${task.id}`).gap(5).p(9).bg(t.surface).border_1().border_color(t.border).rounded(6)
      .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child(task.title))
      .when(Boolean(task.detail), (el) => el.child(div().text_size(11).text_color(t.muted).child(task.detail)))
      .child(h_flex().gap(6).items_center()
        .child(div().px(6).h(16).flex().items_center().bg(t.raised).rounded(3).text_size(9.5).font_family(MONO).text_color(t.accent).child(task.spaceName ?? "?"))
        .when(Boolean(task.model || task.effort), (el) => el.child(div().px(6).h(16).flex().items_center().bg(t.raised).rounded(3).text_size(9.5).font_family(MONO).text_color("#cba6f7").child([task.model, task.effort].filter(Boolean).join(" · "))))
        .when(Boolean(task.targetName), (el) => el.child(div().px(6).h(16).flex().items_center().bg(t.raised).rounded(3).text_size(9.5).font_family(MONO).text_color("#f9b84a").child(task.targetName)))
        .when(Boolean(task.note), (el) => el.child(div().flex_1().min_w(0).text_size(10).text_color(task.column === "doing" ? "#f9b84a" : t.dim).child(task.note))))
      .child(h_flex().gap(4)
        .when(i > 0, (el) => el.child(this.btn(`l-${task.id}`, "◀", t.muted, (cx) => this.move(task.id, COLS[i - 1].id, cx), `Pindah ke ${COLS[i - 1].label.toLowerCase()}`)))
        .when(i < COLS.length - 1, (el) => el.child(this.btn(`r-${task.id}`, i === 0 ? "KERJAKAN ▶" : "▶", i === 0 ? "#f9b84a" : t.muted, (cx) => this.move(task.id, COLS[i + 1].id, cx), i === 0 ? "Pindah ke sedang dikerjakan: agent di space ini langsung ngerjain" : `Pindah ke ${COLS[i + 1].label.toLowerCase()}`)))
        .child(div().flex_1())
        .child(this.btn(`x-${task.id}`, "HAPUS", "#f38ba8", (cx) => this.remove(task.id, cx), "Hapus task")));
  }

  render() {
    const t = theme(), sp = this.space(), overlay = props()?.overlay;
    const compact = !overlay;
    const header = h_flex().items_center().gap(10)
      .child(div().flex_1().text_size(13).font_bold().text_color("#b4befe").child(compact ? "KANBAN" : "KANBAN · TUGAS BUAT AGENT"))
      .when(!compact, (el) => el.child(this.btn("tutup", "TUTUP (ESC)", t.muted, () => overlay && closeOverlay(overlay), "Tutup papan")));
    const field = (st, w) => div().h(30).px(10).flex().items_center().bg(t.surface).border_1().border_color(t.border).rounded(5)
      .when(Boolean(w), (el) => el.w(w)).when(!w, (el) => el.flex_1()).child(Input.new(st).w_full().text_size(12).text_color(t.foreground));
    const spaceBtn = div().id("pilih-space").h(30).px(10).flex().items_center().cursor_pointer().bg(t.raised).rounded(5).text_size(11).text_color(t.accent)
      .tooltip("Space (sesi) yang ngerjain task ini. Klik buat ganti.").on_click((_e, cx) => { this.spaceIdx++; this.agentIdx = 0; cx.notify(); })
      .child(`SPACE: ${sp?.name ?? "-"} ▾`);
    const list = this.choices(), pick = list[this.agentIdx - 1];
    if (this.agentIdx > list.length) this.agentIdx = 0;
    const agentBtn = div().id("pilih-agent").h(30).px(10).flex().items_center().cursor_pointer().bg(t.raised).rounded(5).text_size(11).text_color(pick ? "#f9b84a" : t.muted)
      .tooltip("Staf (sesi terminal) yang ngerjain task ini. Klik buat ganti: otomatis = staf mana pun yang lagi nganggur di space ini.")
      .on_click((_e, cx) => { this.agentIdx = (this.agentIdx + 1) % (this.choices().length + 1); cx.notify(); })
      .child(`STAF: ${pick ? this.agentLabel(pick) : "otomatis"} ▾`);
    const cyc = (id, text, on, tip, fn) => div().id(id).h(30).px(10).flex().items_center().cursor_pointer().bg(t.raised).rounded(5).text_size(11)
      .text_color(on ? "#cba6f7" : t.muted).tooltip(tip).on_click((_e, cx) => { fn(); cx.notify(); }).child(text);
    const modelBtn = cyc("pilih-model", `MODEL: ${this.modelIdx ? MODELS[this.modelIdx - 1] : "bawaan"} ▾`, this.modelIdx,
      "Model Claude buat task ini. Dikirim ke sesi staf lewat /model sebelum task (modelnya tetap berubah buat sesi itu setelahnya). Bawaan = gak diubah.", () => { this.modelIdx = (this.modelIdx + 1) % (MODELS.length + 1); });
    const effortBtn = cyc("pilih-effort", `EFFORT: ${this.effortIdx ? EFFORTS[this.effortIdx - 1] : "bawaan"} ▾`, this.effortIdx,
      "Effort buat task ini. Dikirim lewat /effort sebelum task. Bawaan = gak diubah.", () => { this.effortIdx = (this.effortIdx + 1) % (EFFORTS.length + 1); });
    const addBtn = div().id("tambah").h(30).px(12).flex().items_center().cursor_pointer().bg("#89b4fa").text_color(t.chrome).rounded(5).text_size(11).font_bold()
      .hover((s) => s.opacity(0.85)).on_click((_e, cx) => this.add(cx)).child("+ TAMBAH");
    const form = compact
      ? v_flex().gap(6).child(field(this.title)).child(field(this.detail)).child(h_flex().gap(6).child(spaceBtn).child(agentBtn)).child(h_flex().gap(6).child(modelBtn).child(effortBtn).child(div().flex_1()).child(addBtn))
      : h_flex().gap(8).items_center().child(field(this.title)).child(field(this.detail, 150)).child(spaceBtn).child(agentBtn).child(modelBtn).child(effortBtn).child(addBtn);
    const column = (c, full) => {
      const list = this.tasks.filter((x) => x.column === c.id);
      return v_flex().flex_1().h_full().min_w(0).gap(8).p(8).bg(t.background).rounded(8)
        .child(h_flex().gap(6).items_center().child(div().size(7).bg(c.color)).child(div().text_size(11).font_bold().text_color(c.color).child(c.label)).child(div().text_size(10).text_color(t.dim).child(String(list.length))))
        .child(v_flex().id(`kol-${c.id}${full ? "" : "-c"}`).flex_1().min_h(0).gap(8).overflow_y_scrollbar()
          .children(list.length ? list.map((x) => this.card(x)) : [div().text_size(11).text_color(t.dim).child(c.id === "todo" ? "Tambah task di atas." : "Kosong.")]));
    };
    const chips = h_flex().gap(4).children(COLS.map((c) => {
      const on = this.col === c.id, n = this.tasks.filter((x) => x.column === c.id).length;
      return div().id(`chip-${c.id}`).flex_1().h(24).flex().items_center().justify_center().cursor_pointer().rounded(4).text_size(9.5).font_bold()
        .bg(on ? t.raised : t.surface).text_color(on ? c.color : t.dim).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.col = c.id; cx.notify(); }).child(`${c.id === "doing" ? "JALAN" : c.label} ${n}`);
    }));
    const body = compact
      ? v_flex().flex_1().min_h(0).gap(8).child(chips).child(column(COLS.find((c) => c.id === this.col) ?? COLS[0], false))
      : h_flex().flex_1().min_h(0).items_stretch().gap(10).children(COLS.map((c) => column(c, true)));
    const root = v_flex().size_full().bg(t.chrome).p(compact ? 10 : 14).gap(compact ? 8 : 12).font_family(MONO).text_color(t.foreground);
    return (compact ? root : root.border_1().border_color(t.border).rounded(10)).child(header).child(form).child(body);
  }
}
