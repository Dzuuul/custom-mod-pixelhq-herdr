// Papan kanban: antrean, sedang dikerjakan, selesai. Tiap task terikat ke satu space (sesi).
// Task yang dipindah ke "Sedang dikerjakan" dikirim otomatis ke agent di space itu oleh
// company-status/kanban.js (mesinnya hidup terus, dialog ini cuma tampilan). Data: ~/.config/herdr-app/pixel-hq-kanban.json
// Task juga bisa ditambah dari terminal: pixel-hq-task "judul" (pixel-hq-task.py / .ps1 di folder ini).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, agents, shared, theme, appHome, readTextFile, writeTextFile, closeOverlay, props, pickFolder, pickFiles, notify, run } from "herdr";

const staffName = (a) => {
  const own = (shared("pixel-hq.names") ?? {})[a.pane]?.name; // nama acak/pilihan sendiri (company-agents/names.js)
  if (own) return own;
  const tab = (a.tab_name ?? "").trim();
  if (tab && !/^\d+$/.test(tab)) return tab;
  const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return a.pane_name || clean(a.title) || a.program?.name || a.address;
};
const MODELS = ["opus", "sonnet", "haiku", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const PRIORITIES = ["normal", "tinggi", "rendah"];
const PRI_COLOR = { tinggi: "#f38ba8", normal: null, rendah: "#7f849c" };
const LIMITS = [0, 10, 30, 60, 120];
const MONO = "JetBrains Mono, Menlo, monospace";
const file = () => `${appHome()}/pixel-hq-kanban.json`;
const COLS = [
  { id: "todo", label: "ANTREAN", color: "#89b4fa" },
  { id: "doing", label: "SEDANG DIKERJAKAN", color: "#f9b84a" },
  { id: "done", label: "SELESAI", color: "#a6e3a1" },
];
// Field yang diisi mesin selama task jalan; dibuang tiap task dipindah atau diulang.
const RUNTIME = ["sentAt", "agent", "seen", "byTab", "finishedAt", "preIdx", "prevSaved", "prevModel", "prevEffort", "tries", "failed", "failedAt", "overdue", "result", "resultWanted", "resultAt",
  "startedAt", "stopWanted", "stopped", "asking", "askingSince", "askedMs", "held", "noHold", "notifyDone", "cost", "tokens", "costStart", "tokStart"];
// Pilihan task yang boleh kosong; dibuang dulu tiap task disimpan dari form, lalu diisi lagi yang dipilih.
const OPTIONAL = ["model", "effort", "priority", "limitMin", "limitStop", "after", "afterTitle", "target", "targetName"];
// Apakah `t` (lewat rantai "SETELAH") nunggu task `id`. Dipakai biar edit gak bikin task saling nunggu selamanya.
const waitsFor = (t, id, byId) => {
  const seen = new Set();
  for (let x = t; x?.after && !seen.has(x.id); x = byId.get(x.after)) { if (x.after === id) return true; seen.add(x.id); }
  return false;
};
// Sama dengan company-status/kanban.js (mod gak bisa impor dari folder mod lain).
const PRI = { tinggi: 0, normal: 1, rendah: 2 };
const sortTasks = (a, b) => (PRI[a.priority ?? "normal"] - PRI[b.priority ?? "normal"]) || ((a.order ?? a.created) - (b.order ?? b.created));
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h) return `${h} jam ${m % 60} mnt`;
  if (m) return `${m} mnt ${s % 60} dtk`;
  return `${s} dtk`;
};
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
// Biaya dan token task (dari label statusline staf, dihitung mesin kanban). "" kalau belum ada angkanya.
const costText = (t) => [typeof t.cost === "number" && t.cost > 0 && `$${t.cost.toFixed(2)}`, typeof t.tokens === "number" && t.tokens > 0 && `${fmtTok(t.tokens)} token`].filter(Boolean).join(" · ");
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
const sortedIn = (tasks, col) => {
  const l = tasks.filter((x) => x.column === col);
  return col === "done" ? l.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)) : l.sort(sortTasks);
};

// Baca, ubah, tulis. Kalau mesin kanban nulis di sela-selanya (writeTextFile menolak), baca ulang dan ulangi
// `fn` di atas isi yang baru, jadi klik kamu gak hilang diam-diam. `fn` harus aman dijalankan ulang.
async function mutate(fn) {
  for (let i = 0; ; i++) {
    const raw = await readTextFile(file()).catch(() => null);
    let d; try { d = raw ? JSON.parse(raw) : null; } catch { d = null; }
    d = d && Array.isArray(d.tasks) ? d : { tasks: [] };
    fn(d);
    try { await writeTextFile(file(), JSON.stringify(d, null, 2), raw); return d; }
    catch (e) { if (i >= 4) throw e; }
  }
}

function toMarkdown(tasks) {
  const out = [`# Kanban Pixel HQ`, ``, `Diekspor ${new Date().toLocaleString()}`, ``];
  for (const c of COLS) {
    out.push(`## ${c.label} (${tasks.filter((t) => t.column === c.id).length})`, ``);
    for (const t of sortedIn(tasks, c.id)) {
      const tags = [t.spaceName, t.priority && t.priority !== "normal" && `prioritas ${t.priority}`, t.model, t.effort, t.targetName, t.failed && (t.stopped ? "DIHENTIKAN" : `GAGAL: ${t.failed}`),
        !t.failed && t.asking && "PERLU JAWABAN", !t.failed && t.held && "DITAHAN", t.limitMin && `batas ${t.limitMin} mnt${t.limitStop ? ", lewat = dihentikan" : ""}`,
        t.sentAt && t.finishedAt && `durasi ${fmtDur(t.finishedAt - t.sentAt)}`, costText(t)].filter(Boolean);
      out.push(`- [${c.id === "done" ? "x" : " "}] **${t.title}**${tags.length ? ` (${tags.join(", ")})` : ""}`);
      if (t.detail) out.push(`  ${t.detail.replace(/\n/g, "\n  ")}`);
      if (t.result) out.push(``, `  > ${t.result.slice(0, 600).replace(/\n/g, "\n  > ")}`, ``);
    }
    out.push(``);
  }
  return out.join("\n");
}

export default class Kanban extends View {
  init(_p, cx) {
    this.tasks = [];
    this.spaceIdx = 0;
    this.col = "todo";
    this.agentIdx = 0;
    this.modelIdx = 0;
    this.effortIdx = 0;
    this.priIdx = 0;
    this.limitIdx = 0;
    this.limitStop = false; // lewat batas waktu: true = agent dihentikan, false = cuma diingatkan
    this.afterIdx = 0;
    this.editing = null; // id task yang lagi diedit di form, atau null (form bikin task baru)
    this.open = new Set(); // kartu yang hasil kerjanya dibuka penuh
    this.msg = "";
    const load = (cx) => cx.spawn(async (cx) => {
      const raw = await readTextFile(file()).catch(() => null);
      try {
        const t = raw ? (JSON.parse(raw).tasks ?? []) : [];
        if (JSON.stringify(t) !== JSON.stringify(this.tasks)) { this.tasks = t; cx.notify(); }
        else if (t.some((x) => x.column === "doing" && x.sentAt && !x.failed)) cx.notify(); // durasi yang lagi jalan
      } catch {}
    });
    load(cx);
    cx.timer.every(2000, (cx) => { if (this.msg && Date.now() - this.msgAt > 8000) { this.msg = ""; cx.notify(); } load(cx); });
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
  // task yang bisa ditunggu: yang belum selesai; indeks 0 = gak nunggu siapa-siapa.
  // Waktu ngedit, task itu sendiri dan task yang (lewat rantai) nunggu dia gak bisa dipilih.
  afterChoices() {
    const byId = new Map(this.tasks.map((x) => [x.id, x])), id = this.editing;
    return this.tasks.filter((x) => x.column !== "done" && (!id || (x.id !== id && !waitsFor(x, id, byId)))).sort(sortTasks);
  }
  agentLabel(a) { return staffName(a); }
  say(text, cx) { this.msg = text; this.msgAt = Date.now(); cx.notify(); }

  // Baca-ubah-tulis papan, lalu tampilkan hasilnya. Gagal nyimpan = pesan di atas papan, bukan diam-diam.
  change(fn, cx) {
    cx.spawn(async (cx) => {
      try { const d = await mutate(fn); this.tasks = d.tasks; cx.notify(); }
      catch (e) { this.say(`Gagal nyimpan papan: ${e?.message ?? e}`, cx); }
    });
  }

  // Pilihan form sekarang, sebagai field task (yang kosong gak diisi).
  formFields(sp) {
    const f = {};
    const pick = this.choices()[this.agentIdx - 1];
    if (this.modelIdx) f.model = MODELS[this.modelIdx - 1];
    if (this.effortIdx) f.effort = EFFORTS[this.effortIdx - 1];
    if (this.priIdx) f.priority = PRIORITIES[this.priIdx];
    if (this.limitIdx) { f.limitMin = LIMITS[this.limitIdx]; if (this.limitStop) f.limitStop = true; }
    const dep = this.afterChoices()[this.afterIdx - 1];
    if (dep) { f.after = dep.id; f.afterTitle = dep.title; }
    if (pick) { f.target = pick.address; f.targetName = this.agentLabel(pick); }
    return { title: this.title.value().trim(), detail: this.detail.value().trim(), space: sp.id, spaceName: sp.name, ...f };
  }

  resetForm() { this.editing = null; this.title.set_value(""); this.detail.set_value(""); this.afterIdx = 0; }

  add(cx) {
    const sp = this.space();
    if (!this.title.value().trim() || !sp) return;
    if (this.editing) return this.saveEdit(cx);
    const now = Date.now();
    const task = { id: `k${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`, ...this.formFields(sp), column: "todo", created: now, order: now };
    this.resetForm();
    this.change((d) => d.tasks.push(task), cx);
  }

  // Isi form dengan task yang mau diubah. Bisa buat task di Antrean dan task yang gagal/dihentikan.
  startEdit(task, cx) {
    this.editing = task.id;
    this.title.set_value(task.title ?? "");
    this.detail.set_value(task.detail ?? "");
    const si = spaces().findIndex((s) => s.id === task.space);
    if (si >= 0) this.spaceIdx = si;
    const ai = task.target ? this.choices().findIndex((a) => a.address === task.target) : -1;
    this.agentIdx = ai + 1;
    this.modelIdx = task.model ? MODELS.indexOf(task.model) + 1 : 0;
    this.effortIdx = task.effort ? EFFORTS.indexOf(task.effort) + 1 : 0;
    this.priIdx = Math.max(0, PRIORITIES.indexOf(task.priority ?? "normal"));
    this.limitIdx = Math.max(0, LIMITS.indexOf(task.limitMin ?? 0));
    this.limitStop = Boolean(task.limitStop);
    this.afterIdx = task.after ? this.afterChoices().findIndex((x) => x.id === task.after) + 1 : 0;
    this.title.focus();
    const lost = [si < 0 && `space "${task.spaceName ?? "?"}"`, task.target && ai < 0 && `staf ${task.targetName ?? "?"}`].filter(Boolean);
    this.say(lost.length ? `Ngedit "${task.title.slice(0, 40)}". ${lost.join(" dan ")} udah gak ada, pilih lagi.` : `Ngedit "${task.title.slice(0, 40)}". SIMPAN kalau udah, BATAL buat batal.`, cx);
  }

  cancelEdit(cx) { this.resetForm(); this.say("Edit dibatalin.", cx); }

  saveEdit(cx) {
    const id = this.editing, f = this.formFields(this.space());
    let result = "";
    this.resetForm();
    cx.spawn(async (cx) => {
      try {
        const d = await mutate((d) => {
          const t = d.tasks.find((x) => x.id === id);
          if (!t) { result = "Task-nya udah dihapus, gak jadi diubah."; return; }
          if (t.column !== "todo" && !t.failed) { result = "Task-nya keburu jalan, gak jadi diubah."; return; }
          for (const k of OPTIONAL) delete t[k];
          Object.assign(t, f);
          if (t.failed) t.note = "Diubah. Klik ULANGI buat kirim lagi.";
          result = "Task disimpan.";
        });
        this.tasks = d.tasks;
        this.say(result, cx);
      } catch (e) { this.say(`Gagal nyimpan papan: ${e?.message ?? e}`, cx); }
    });
  }

  move(id, column, cx) {
    if (this.editing === id) this.resetForm();
    this.change((d) => {
      const t = d.tasks.find((x) => x.id === id); if (!t) return;
      t.column = column;
      for (const k of RUNTIME) delete t[k];
      delete t.restore; // perintah pemulihan yang belum terkirim ikut batal kalau task dipindah manual
      t.note = column === "doing" ? "Nunggu dikirim ke agent…" : "";
      if (column === "doing") t.startedAt = Date.now();
    }, cx);
  }

  retry(id, cx) {
    if (this.editing === id) this.resetForm();
    this.change((d) => {
      const t = d.tasks.find((x) => x.id === id); if (!t) return;
      for (const k of RUNTIME) delete t[k];
      t.column = "doing"; t.startedAt = Date.now(); t.note = "Diulang, nunggu dikirim ke agent…";
    }, cx);
  }

  // Minta mesin kanban menghentikan task yang lagi dikerjakan (tombol stop agent, sama kayak Esc).
  // Mesinnya yang menekan, biar gak keburu dianggap "kelar" waktu agent berhenti.
  stop(id, cx) {
    this.change((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (!t || t.column !== "doing" || t.failed) return;
      t.stopWanted = true; t.note = "Menghentikan…";
    }, cx);
  }

  // Buka terminal staf yang pegang task ini (buat lihat kerjanya atau jawab pertanyaannya). Dialog ditutup biar gak nutupin.
  look(task, cx) {
    const a = task.agent ? agents().find((x) => x.address === task.agent) : null;
    if (!a) { this.say("Stafnya udah gak ada (terminalnya ditutup).", cx); return; }
    try { run("agent.focus", { terminal: a.address }); } catch (e) { this.say(`Gagal buka terminal: ${e?.message ?? e}`, cx); return; }
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
  }

  // Task yang stafnya nanya balik, tapi kamu anggap udah beres: pindah ke Selesai, hasilnya tetap disimpan.
  markDone(id, cx) {
    this.change((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (!t || !t.asking || t.column !== "doing") return;
      delete t.asking; t.column = "done"; t.finishedAt = Date.now(); t.note = "Kamu tandai kelar";
    }, cx);
  }

  // Task yang ditahan (usage hampir habis, atau stafnya lagi nanya): kirim sekarang juga.
  sendAnyway(id, cx) {
    this.change((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (!t || t.column !== "doing" || t.failed || t.sentAt) return;
      t.noHold = true; t.note = "Dikirim sekarang…";
    }, cx);
  }

  // geser kartu satu langkah di kolomnya (hanya di antara kartu dengan prioritas yang sama)
  nudge(id, dir, cx) {
    this.change((d) => {
      const t = d.tasks.find((x) => x.id === id); if (!t) return;
      const list = sortedIn(d.tasks, t.column), i = list.indexOf(t), o = list[i + dir];
      if (!o || (o.priority ?? "normal") !== (t.priority ?? "normal")) return;
      const a = t.order ?? t.created, b = o.order ?? o.created;
      t.order = b; o.order = a === b ? a - dir : a;
    }, cx);
  }

  cyclePriority(id, cx) {
    this.change((d) => {
      const t = d.tasks.find((x) => x.id === id); if (!t) return;
      t.priority = PRIORITIES[(PRIORITIES.indexOf(t.priority ?? "normal") + 1) % PRIORITIES.length];
      if (t.priority === "normal") delete t.priority;
    }, cx);
  }

  remove(id, cx) {
    if (this.editing === id) this.resetForm();
    this.change((d) => {
      d.tasks = d.tasks.filter((x) => x.id !== id);
      for (const t of d.tasks) if (t.after === id) { delete t.after; delete t.afterTitle; }
    }, cx);
  }

  clearDone(cx) {
    this.change((d) => { d.tasks = d.tasks.filter((x) => x.column !== "done" || x.restore?.length); }, cx);
  }

  exportBoard(cx) {
    cx.spawn(async (cx) => {
      try {
        const dir = await pickFolder({ prompt: "Ekspor ke sini" });
        if (!dir) return;
        const base = `${dir.replace(/[\\/]+$/, "")}/pixel-hq-kanban-${stamp()}`;
        await writeTextFile(`${base}.json`, JSON.stringify({ exported: Date.now(), tasks: this.tasks }, null, 2), null);
        await writeTextFile(`${base}.md`, toMarkdown(this.tasks), null);
        this.say(`Diekspor: ${base}.json dan .md`, cx);
        try { notify({ title: "Kanban diekspor", body: `${base}.json`, level: "success" }); } catch {}
      } catch (e) { this.say(`Gagal ekspor: ${e?.message ?? e}`, cx); }
    });
  }

  importBoard(cx) {
    cx.spawn(async (cx) => {
      try {
        const files = await pickFiles({ prompt: "Impor" });
        if (!files?.length) return;
        const raw = await readTextFile(files[0]);
        const incoming = JSON.parse(raw ?? "null")?.tasks;
        if (!Array.isArray(incoming)) { this.say("File itu bukan ekspor kanban (gak ada daftar tasks).", cx); return; }
        const sp = spaces(), here = this.space();
        let added = 0, moved = 0;
        const d = await mutate((d) => {
          added = 0; moved = 0; // mutate bisa mengulang fungsi ini kalau mesin kanban nulis di sela-selanya
          const have = new Set(d.tasks.map((x) => x.id));
          for (const src of incoming) {
            if (!src || typeof src.title !== "string" || !src.title.trim() || have.has(src.id)) continue;
            const t = { ...src };
            for (const k of RUNTIME) delete t[k];
            delete t.restore; delete t.target; delete t.targetName; // alamat terminal beda di tiap komputer
            if (!t.id) t.id = `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
            // space dicocokkan lewat nama; kalau gak ada, pakai space yang lagi dipilih
            const same = sp.find((s) => s.id === t.space) ?? sp.find((s) => s.name === t.spaceName);
            if (same) { t.space = same.id; t.spaceName = same.name; }
            else if (here) { t.note = `Space asal "${t.spaceName ?? "?"}" gak ada di sini`; t.space = here.id; t.spaceName = here.name; }
            // yang tadinya jalan masuk antrean dulu, biar gak langsung dikirim ke agent
            if (t.column !== "done") { if (t.column === "doing") moved++; t.column = "todo"; }
            t.created = t.created ?? Date.now(); t.order = t.order ?? t.created;
            d.tasks.push(t); have.add(t.id); added++;
          }
        });
        this.tasks = d.tasks;
        this.say(`Diimpor ${added} task${moved ? ` (${moved} yang tadinya jalan masuk antrean)` : ""}.`, cx);
      } catch (e) { this.say(`Gagal impor: ${e?.message ?? e}`, cx); }
    });
  }

  btn(id, label, color, fn, tip) {
    const t = theme();
    return div().id(id).px(7).h(20).flex().items_center().cursor_pointer().bg(t.raised).text_color(color).font_family(MONO).text_size(10).font_bold()
      .hover((s) => s.bg(t.hover)).tooltip(tip).on_click((_e, cx) => fn(cx)).child(label);
  }

  tag(text, color) {
    const t = theme();
    return div().px(6).h(16).flex().items_center().bg(t.raised).rounded(3).text_size(9.5).font_family(MONO).text_color(color).child(text);
  }

  card(task) {
    const t = theme(), i = COLS.findIndex((c) => c.id === task.column), now = Date.now();
    const list = sortedIn(this.tasks, task.column), pos = list.indexOf(task);
    const samePri = (o) => o && (o.priority ?? "normal") === (task.priority ?? "normal");
    const canUp = task.column !== "done" && samePri(list[pos - 1]), canDown = task.column !== "done" && samePri(list[pos + 1]);
    const dur = task.sentAt ? fmtDur((task.finishedAt ?? (task.failed ? task.failedAt : null) ?? now) - task.sentAt) : null;
    const dep = task.after ? this.tasks.find((x) => x.id === task.after) : null;
    const result = task.result ?? "";
    const opened = this.open.has(task.id);
    const shown = opened ? result : result.split("\n").filter((l) => l.trim()).slice(0, 3).join("\n").slice(0, 280);
    const editing = this.editing === task.id;
    const canEdit = task.column === "todo" || Boolean(task.failed);
    const asking = Boolean(task.asking && !task.failed && task.column === "doing"), held = Boolean(task.held && !task.failed && task.column === "doing" && !task.sentAt);
    const canStop = task.column === "doing" && Boolean(task.sentAt && task.agent) && !task.failed && !task.stopWanted && !asking;
    const canLook = Boolean(task.agent) && agents().some((a) => a.address === task.agent);
    const cost = costText(task);
    const edge = editing ? "#89b4fa" : task.stopped ? "#fab387" : task.failed ? "#f38ba8" : asking ? "#f5c2e7" : held ? "#94e2d5" : task.overdue ? "#f9b84a" : t.border;
    return v_flex().id(`card-${task.id}`).gap(5).p(9).bg(t.surface).border_1().border_color(edge).rounded(6)
      .child(h_flex().gap(6).items_center()
        .when(Boolean(task.failed), (el) => el.child(task.stopped ? this.tag("DIHENTIKAN", "#fab387") : this.tag("GAGAL", "#f38ba8")))
        .when(asking, (el) => el.child(this.tag("PERLU JAWABAN", "#f5c2e7")))
        .when(held, (el) => el.child(this.tag("DITAHAN", "#94e2d5")))
        .when(editing, (el) => el.child(this.tag("LAGI DIEDIT", "#89b4fa")))
        .child(div().flex_1().min_w(0).text_size(12.5).font_semibold().text_color(t.foreground).child(task.title)))
      .when(Boolean(task.detail), (el) => el.child(div().text_size(11).text_color(t.muted).child(task.detail)))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(this.tag(task.spaceName ?? "?", t.accent))
        .when(Boolean(task.priority && task.priority !== "normal"), (el) => el.child(this.tag(task.priority === "tinggi" ? "▲ TINGGI" : "▼ RENDAH", PRI_COLOR[task.priority])))
        .when(Boolean(task.model || task.effort), (el) => el.child(this.tag([task.model, task.effort].filter(Boolean).join(" · "), "#cba6f7")))
        .when(Boolean(task.targetName), (el) => el.child(this.tag(task.targetName, "#f9b84a")))
        .when(Boolean(task.after), (el) => el.child(this.tag(`⛓ setelah: ${(dep?.title ?? task.afterTitle ?? "?").slice(0, 24)}${dep?.column === "done" ? " ✓" : ""}`, dep?.column === "done" ? "#a6e3a1" : "#89dceb")))
        .when(Boolean(dur), (el) => el.child(this.tag(`⏱ ${dur}${task.limitMin ? ` / ${task.limitMin} mnt` : ""}`, task.overdue ? "#f9b84a" : t.muted)))
        .when(Boolean(!dur && task.limitMin), (el) => el.child(this.tag(`batas ${task.limitMin} mnt${task.limitStop ? " ■" : ""}`, t.muted)))
        .when(Boolean(dur && task.limitStop && !task.failed), (el) => el.child(this.tag("lewat = stop", t.dim)))
        .when(Boolean(cost), (el) => el.child(this.tag(cost, "#a6e3a1")))
        .when(task.source === "terminal", (el) => el.child(this.tag("⌨ terminal", t.dim)))
        .when(Boolean(task.overdue && task.column === "doing"), (el) => el.child(this.tag("LEWAT BATAS", "#f9b84a")))
        .when(Boolean(task.restore?.length), (el) => el.child(this.tag("ngembaliin model…", "#cba6f7"))))
      .when(Boolean(task.note), (el) => el.child(div().text_size(10).text_color(task.stopped ? "#fab387" : task.failed ? "#f38ba8" : asking ? "#f5c2e7" : held ? "#94e2d5" : task.column === "doing" ? "#f9b84a" : t.dim).child(task.note)))
      .when(Boolean(result), (el) => el.child(v_flex().id(`hasil-${task.id}`).gap(3).p(7).bg(t.background).rounded(4).cursor_pointer()
        .tooltip(opened ? "Klik buat ringkas" : "Klik buat lihat hasil lengkap")
        .on_click((_e, cx) => { if (opened) this.open.delete(task.id); else this.open.add(task.id); cx.notify(); })
        .child(div().text_size(9.5).font_bold().text_color(asking ? "#f5c2e7" : "#a6e3a1").child(`${asking ? "PERTANYAAN STAF" : "HASIL"} ${opened ? "▾" : "▸"}`))
        .child(div().text_size(10.5).text_color(t.muted).child(shown + (!opened && shown.length < result.length ? " …" : "")))))
      .child(h_flex().gap(4).flex_wrap()
        .when(i > 0, (el) => el.child(this.btn(`l-${task.id}`, "◀", t.muted, (cx) => this.move(task.id, COLS[i - 1].id, cx), `Pindah ke ${COLS[i - 1].label.toLowerCase()}`)))
        .when(i < COLS.length - 1, (el) => el.child(this.btn(`r-${task.id}`, i === 0 ? "KERJAKAN ▶" : "▶", i === 0 ? "#f9b84a" : t.muted, (cx) => this.move(task.id, COLS[i + 1].id, cx), i === 0 ? "Pindah ke sedang dikerjakan: agent di space ini langsung ngerjain" : `Pindah ke ${COLS[i + 1].label.toLowerCase()}`)))
        .when(canStop, (el) => el.child(this.btn(`s-${task.id}`, "STOP ■", "#fab387", (cx) => this.stop(task.id, cx), "Suruh agent berhenti ngerjain task ini (tombol stop, sama kayak Esc). Kartunya ditandai dihentikan; ULANGI buat kirim lagi.")))
        .when(Boolean(task.stopWanted && task.column === "doing"), (el) => el.child(this.tag("menghentikan…", "#fab387")))
        .when(canLook, (el) => el.child(this.btn(`v-${task.id}`, asking ? "JAWAB ▸" : "LIHAT ▸", asking ? "#f5c2e7" : "#89dceb", (cx) => this.look(task, cx),
          asking ? "Buka terminal staf buat jawab pertanyaannya. Setelah dijawab, task jalan lagi sendiri." : "Buka terminal staf yang pegang task ini")))
        .when(asking, (el) => el.child(this.btn(`k-${task.id}`, "KELAR ✓", "#a6e3a1", (cx) => this.markDone(task.id, cx), "Anggap task ini udah beres tanpa jawab pertanyaannya (pindah ke Selesai)")))
        .when(held, (el) => el.child(this.btn(`h-${task.id}`, "KIRIM AJA", "#94e2d5", (cx) => this.sendAnyway(task.id, cx), "Kirim sekarang walau lagi ditahan (usage hampir habis, atau stafnya lagi nanya)")))
        .when(Boolean(task.failed) || task.column === "done", (el) => el.child(this.btn(`u-${task.id}`, "ULANGI ↻", "#f38ba8", (cx) => this.retry(task.id, cx), "Kirim ulang task ini ke agent")))
        .when(canEdit && !editing, (el) => el.child(this.btn(`e-${task.id}`, "EDIT", "#89b4fa", (cx) => this.startEdit(task, cx), "Ubah judul, detail, dan pilihan task ini di form atas")))
        .when(canUp, (el) => el.child(this.btn(`up-${task.id}`, "▲", t.muted, (cx) => this.nudge(task.id, -1, cx), "Naikkan urutan")))
        .when(canDown, (el) => el.child(this.btn(`dn-${task.id}`, "▼", t.muted, (cx) => this.nudge(task.id, 1, cx), "Turunkan urutan")))
        .when(task.column !== "done", (el) => el.child(this.btn(`p-${task.id}`, "PRIO", PRI_COLOR[task.priority ?? "normal"] ?? t.muted, (cx) => this.cyclePriority(task.id, cx), "Ganti prioritas: normal → tinggi → rendah")))
        .child(div().flex_1())
        .child(this.btn(`x-${task.id}`, "HAPUS", "#f38ba8", (cx) => this.remove(task.id, cx), "Hapus task")));
  }

  render() {
    const t = theme(), sp = this.space(), overlay = props()?.overlay;
    const compact = !overlay;
    const header = h_flex().items_center().gap(6)
      .child(div().flex_1().text_size(13).font_bold().text_color("#b4befe").child(compact ? "KANBAN" : "KANBAN · TUGAS BUAT AGENT"))
      .child(this.btn("ekspor", "EKSPOR", t.muted, (cx) => this.exportBoard(cx), "Simpan papan ke file JSON (buat impor lagi) dan Markdown (buat dibaca)"))
      .child(this.btn("impor", "IMPOR", t.muted, (cx) => this.importBoard(cx), "Ambil task dari file ekspor JSON. Task yang udah ada gak didobel; yang tadinya jalan masuk antrean."))
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
    const cyc = (id, text, on, tip, fn, color = "#cba6f7") => div().id(id).h(30).px(10).flex().items_center().cursor_pointer().bg(t.raised).rounded(5).text_size(11)
      .text_color(on ? color : t.muted).tooltip(tip).on_click((_e, cx) => { fn(); cx.notify(); }).child(text);
    const modelBtn = cyc("pilih-model", `MODEL: ${this.modelIdx ? MODELS[this.modelIdx - 1] : "bawaan"} ▾`, this.modelIdx,
      "Model Claude buat task ini. Dikirim ke sesi staf lewat /model sebelum task, lalu dikembalikan ke model sebelumnya setelah task kelar. Bawaan = gak diubah.", () => { this.modelIdx = (this.modelIdx + 1) % (MODELS.length + 1); });
    const effortBtn = cyc("pilih-effort", `EFFORT: ${this.effortIdx ? EFFORTS[this.effortIdx - 1] : "bawaan"} ▾`, this.effortIdx,
      "Effort buat task ini. Dikirim lewat /effort sebelum task, lalu dikembalikan setelah task kelar. Bawaan = gak diubah.", () => { this.effortIdx = (this.effortIdx + 1) % (EFFORTS.length + 1); });
    const priBtn = cyc("pilih-prio", `PRIORITAS: ${PRIORITIES[this.priIdx]} ▾`, this.priIdx,
      "Prioritas tinggi dikirim duluan kalau beberapa task nunggu staf yang sama.", () => { this.priIdx = (this.priIdx + 1) % PRIORITIES.length; }, PRI_COLOR[PRIORITIES[this.priIdx]] ?? "#cba6f7");
    const limitBtn = cyc("pilih-batas", `BATAS: ${this.limitIdx ? `${LIMITS[this.limitIdx]} mnt` : "tanpa"} ▾`, this.limitIdx,
      "Batas waktu kerja agent. Lewat batas = notifikasi dan kartunya ditandai; atur di LEWAT BATAS apakah agent sekalian dihentikan.", () => { this.limitIdx = (this.limitIdx + 1) % LIMITS.length; }, "#f9b84a");
    const overBtn = cyc("pilih-lewat", `LEWAT BATAS: ${this.limitStop ? "hentikan" : "ingatkan"} ▾`, this.limitStop,
      "Ingatkan = cuma notifikasi. Hentikan = agent disuruh berhenti (kayak tombol STOP), kartunya ditandai dihentikan dan bisa diulang.", () => { this.limitStop = !this.limitStop; }, "#fab387");
    const deps = this.afterChoices();
    if (this.afterIdx > deps.length) this.afterIdx = 0;
    const dep = deps[this.afterIdx - 1];
    const afterBtn = cyc("pilih-setelah", `SETELAH: ${dep ? dep.title.slice(0, 18) : "-"} ▾`, this.afterIdx,
      "Task ini baru dikirim setelah task yang dipilih masuk Selesai. Klik buat ganti.", () => { this.afterIdx = (this.afterIdx + 1) % (this.afterChoices().length + 1); }, "#89dceb");
    const addBtn = h_flex().gap(6)
      .when(Boolean(this.editing), (el) => el.child(div().id("batal-edit").h(30).px(10).flex().items_center().cursor_pointer().bg(t.raised).text_color(t.muted).rounded(5).text_size(11).font_bold()
        .hover((s) => s.bg(t.hover)).tooltip("Batal ngedit, form kosong lagi").on_click((_e, cx) => this.cancelEdit(cx)).child("BATAL")))
      .child(div().id("tambah").h(30).px(12).flex().items_center().cursor_pointer().bg(this.editing ? "#a6e3a1" : "#89b4fa").text_color(t.chrome).rounded(5).text_size(11).font_bold()
        .hover((s) => s.opacity(0.85)).tooltip(this.editing ? "Simpan perubahan task yang lagi diedit" : "Tambah task ke Antrean").on_click((_e, cx) => this.add(cx)).child(this.editing ? "SIMPAN ✓" : "+ TAMBAH"));
    const form = compact
      ? v_flex().gap(6).child(field(this.title)).child(field(this.detail))
        .child(h_flex().gap(6).child(spaceBtn).child(agentBtn))
        .child(h_flex().gap(6).child(modelBtn).child(effortBtn))
        .child(h_flex().gap(6).child(priBtn).child(limitBtn))
        .when(this.limitIdx > 0, (el) => el.child(h_flex().gap(6).child(overBtn)))
        .child(h_flex().gap(6).child(afterBtn).child(div().flex_1()).child(addBtn))
      : v_flex().gap(8)
        .child(h_flex().gap(8).items_center().child(field(this.title)).child(field(this.detail, 260)).child(addBtn))
        .child(h_flex().gap(6).items_center().flex_wrap().child(spaceBtn).child(agentBtn).child(modelBtn).child(effortBtn).child(priBtn).child(limitBtn).when(this.limitIdx > 0, (el) => el.child(overBtn)).child(afterBtn));
    const column = (c, full) => {
      const list = sortedIn(this.tasks, c.id), failed = list.filter((x) => x.failed && !x.stopped).length, asking = list.filter((x) => x.asking && !x.failed).length;
      return v_flex().flex_1().h_full().min_w(0).gap(8).p(8).bg(t.background).rounded(8)
        .child(h_flex().gap(6).items_center().child(div().size(7).bg(c.color)).child(div().text_size(11).font_bold().text_color(c.color).child(c.label)).child(div().text_size(10).text_color(t.dim).child(String(list.length)))
          .when(asking > 0, (el) => el.child(div().text_size(10).text_color("#f5c2e7").child(`${asking} nanya`)))
          .when(failed > 0, (el) => el.child(div().text_size(10).text_color("#f38ba8").child(`${failed} gagal`)))
          .when(c.id === "done" && list.length > 0, (el) => el.child(div().flex_1()).child(this.btn(`bersih-${full ? "f" : "c"}`, "BERSIHKAN", t.dim, (cx) => this.clearDone(cx), "Hapus semua task di Selesai"))))
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
    return (compact ? root : root.border_1().border_color(t.border).rounded(10)).child(header).child(form)
      .when(Boolean(this.msg), (el) => el.child(div().text_size(11).text_color("#a6e3a1").child(this.msg)))
      .child(body);
  }
}
