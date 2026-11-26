// Papan kanban: antrean, sedang dikerjakan, selesai. Tiap task terikat ke satu space (sesi).
// Task yang dipindah ke "Sedang dikerjakan" dikirim otomatis ke agent di space itu oleh
// company-status/kanban.js (mesinnya hidup terus, dialog ini cuma tampilan). Data: ~/.config/herdr-app/pixel-hq-kanban.json
// Task juga bisa ditambah dari terminal: pixel-hq-task "judul" (pixel-hq-task.py / .ps1 di folder ini).
// OPSI LAIN di form: CEK setelah kelar, batas biaya, bawa hasil task sebelumnya, worktree, jam mulai dan ulang,
// serta template (disimpan di pixel-hq-kanban-templates.json). NOTIF HP di atas: alamat ntfy/Discord/Slack/Telegram.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, agents, shared, setShared, theme, appHome, readTextFile, writeTextFile, closeOverlay, props, pickFolder, pickFiles, notify, run, hc, window } from "herdr";

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
const COSTS = [0, 0.5, 1, 2, 5];
const REPEAT_KEYS = ["", "harian", "kerja"];
const REPEATS = { harian: "tiap hari", kerja: "hari kerja" };
const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const MONO = "JetBrains Mono, Menlo, monospace";
const CHECK_COLOR = "#74c7ec";
const file = () => `${appHome()}/pixel-hq-kanban.json`;
const tplFile = () => `${appHome()}/pixel-hq-kanban-templates.json`;
const COLS = [
  { id: "todo", label: "ANTREAN", color: "#89b4fa" },
  { id: "doing", label: "SEDANG DIKERJAKAN", color: "#f9b84a" },
  { id: "done", label: "SELESAI", color: "#a6e3a1" },
];
// Field yang diisi mesin selama task jalan; dibuang tiap task dipindah atau diulang.
const RUNTIME = ["sentAt", "agent", "seen", "byTab", "finishedAt", "preIdx", "prevSaved", "prevModel", "prevEffort", "tries", "failed", "failedAt", "overdue", "result", "resultWanted", "resultAt",
  "startedAt", "stopWanted", "stopped", "asking", "askingSince", "askedMs", "held", "noHold", "notifyDone", "cost", "tokens", "costStart", "tokStart",
  "checkWanted", "checking", "checkAt", "checkRounds", "checkOk", "checkLog", "idleAt", "fixAt", "overCost", "resultFrom", "choices", "diff", "git", "logged", "agentName", "ranModel"];
// Pilihan task yang boleh kosong; dibuang dulu tiap task disimpan dari form, lalu diisi lagi yang dipilih.
const OPTIONAL = ["model", "effort", "priority", "limitMin", "limitStop", "after", "afterTitle", "target", "targetName",
  "check", "costMax", "carry", "worktree", "atTime", "startAt", "repeat", "runNow"];
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
// Jam mulai: sama dengan company-status/kanban.js (tests/js/dialog.test.js membandingkan keduanya).
function parseClock(s) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(s ?? ""));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}
function nextRun(atTime, repeat, fromMs) {
  const [h, m] = String(atTime).split(":").map(Number);
  const d = new Date(fromMs);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
  if (repeat === "kerja") while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0); // pergantian jam musim panas
  return d.getTime();
}
const fmtWhen = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, "0"), hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(ms); day.setHours(0, 0, 0, 0);
  const n = Math.round((day.getTime() - today.getTime()) / 86400000);
  return n === 0 ? `hari ini ${hm}` : n === 1 ? `besok ${hm}` : `${HARI[d.getDay()]} ${d.getDate()}/${d.getMonth() + 1} ${hm}`;
};
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const fmtUsd = (n) => `$${Number(n).toFixed(n < 1 ? 2 : Number.isInteger(n) ? 0 : 2)}`;
// Biaya dan token task (dari label statusline staf, dihitung mesin kanban). "" kalau belum ada angkanya.
const costText = (t) => [typeof t.cost === "number" && t.cost > 0 && `$${t.cost.toFixed(2)}`, typeof t.tokens === "number" && t.tokens > 0 && `${fmtTok(t.tokens)} token`].filter(Boolean).join(" · ");
const diffText = (df) => (df ? `± ${df.files} file +${df.add} −${df.del}${df.fresh ? ` · ${df.fresh} file baru` : ""}` : "");
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
const sortedIn = (tasks, col) => {
  const l = tasks.filter((x) => x.column === col);
  return col === "done" ? l.sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0)) : l.sort(sortTasks);
};
const newId = () => `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

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
        !t.failed && t.asking && "PERLU JAWABAN", !t.failed && t.held && "DITAHAN (usage)", t.limitMin && `batas ${t.limitMin} mnt${t.limitStop ? ", lewat = dihentikan" : ""}`,
        t.costMax && `batas biaya ${fmtUsd(t.costMax)}`, t.check && `cek: ${t.check}${t.checkOk ? " (lolos)" : t.checkRounds ? ` (gagal ${t.checkRounds}x)` : ""}`,
        t.worktree && `worktree${t.wtBranch ? ` ${t.wtBranch}` : ""}`, t.repeat && `${REPEATS[t.repeat]} ${t.atTime}`, !t.repeat && t.startAt && t.column === "todo" && `mulai ${fmtWhen(t.startAt)}`,
        t.sentAt && t.finishedAt && `durasi ${fmtDur(t.finishedAt - t.sentAt)}`, costText(t), diffText(t.diff)].filter(Boolean);
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
    this.limitStop = false; // lewat batas waktu/biaya: true = agent dihentikan, false = cuma diingatkan
    this.afterIdx = 0;
    this.costIdx = 0;
    this.costOther = null; // batas biaya dari terminal yang gak ada di COSTS (mis. $1.50), dijaga waktu diedit
    this.carry = false;
    this.worktree = false;
    this.repeatIdx = 0;
    this.more = false; // baris OPSI LAIN kebuka
    this.templates = [];
    this.tplIdx = 0;
    this.pushOpen = false;
    this.pushTestAt = 0;
    this.answers = new Map(); // id task -> kotak isian jawaban (kartu PERLU JAWABAN)
    this.editing = null; // id task yang lagi diedit di form, atau null (form bikin task baru)
    this.open = new Set(); // kartu yang hasil kerjanya dibuka penuh
    this.msg = "";
    const load = (cx) => cx.spawn(async (cx) => {
      const raw = await readTextFile(file()).catch(() => null);
      try {
        const t = raw ? (JSON.parse(raw).tasks ?? []) : [];
        if (JSON.stringify(t) !== JSON.stringify(this.tasks)) {
          this.tasks = t;
          // kotak jawaban buat kartu PERLU JAWABAN: dibuat di sini (bukan waktu render), dibuang kalau udah gak nanya
          for (const x of t) if (x.asking && !x.failed) this.answerState(x.id);
          for (const id of [...this.answers.keys()]) if (!t.some((x) => x.id === id && x.asking)) this.answers.delete(id);
          cx.notify();
        } else if (t.some((x) => x.column === "doing" && x.sentAt && !x.failed)) cx.notify(); // durasi yang lagi jalan
      } catch {}
    });
    load(cx);
    this.loadTemplates(cx);
    cx.timer.every(2000, (cx) => { if (this.msg && Date.now() - this.msgAt > 8000) { this.msg = ""; cx.notify(); } load(cx); });
    this.title = InputState.new({ placeholder: "Judul task (ini yang dikirim ke agent)" });
    this.detail = InputState.new({ placeholder: "Detail tambahan (opsional)" });
    this.check = InputState.new({ placeholder: "Cek setelah kelar, mis. npm test" });
    this.at = InputState.new({ placeholder: "Jam mulai, 22:00" });
    const push = shared("pixel-hq.push");
    this.pushMode = push?.mode === "always" ? "always" : "away";
    this.pushUrl = InputState.new({ placeholder: "https://ntfy.sh/topik-rahasiamu, atau webhook Discord/Slack/Telegram", value: typeof push?.url === "string" ? push.url : "" });
    for (const st of [this.title, this.detail, this.check, this.at]) st.on("submit", (_e, cx) => this.add(cx));
    this.pushUrl.on("submit", (_e, cx) => this.savePush(cx));
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
    return this.tasks.filter((x) => x.column !== "done" && !x.repeat && (!id || (x.id !== id && !waitsFor(x, id, byId)))).sort(sortTasks);
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

  // Isian form yang gak kebaca. "" = aman.
  formError() {
    const at = this.at.value().trim();
    if (at && !parseClock(at)) return `Jam "${at}" gak kebaca, pakai format 22:00.`;
    if (this.repeatIdx && !at) return "ULANG butuh JAM mulai.";
    return "";
  }

  // Pilihan form sekarang, sebagai field task (yang kosong gak diisi).
  formFields(sp) {
    const f = {};
    const pick = this.choices()[this.agentIdx - 1];
    if (this.modelIdx) f.model = MODELS[this.modelIdx - 1];
    if (this.effortIdx) f.effort = EFFORTS[this.effortIdx - 1];
    if (this.priIdx) f.priority = PRIORITIES[this.priIdx];
    if (this.limitIdx) f.limitMin = LIMITS[this.limitIdx];
    const cost = this.costIdx ? COSTS[this.costIdx] : this.costOther;
    if (cost) f.costMax = cost;
    if (this.limitStop && (f.limitMin || f.costMax)) f.limitStop = true;
    const dep = this.afterChoices()[this.afterIdx - 1];
    if (dep) { f.after = dep.id; f.afterTitle = dep.title; if (this.carry) f.carry = true; }
    if (pick) { f.target = pick.address; f.targetName = this.agentLabel(pick); }
    const check = this.check.value().trim();
    if (check) f.check = check.slice(0, 500);
    if (this.worktree) f.worktree = true;
    const at = parseClock(this.at.value());
    if (at) {
      const rep = REPEAT_KEYS[this.repeatIdx];
      f.atTime = at; f.startAt = nextRun(at, rep, Date.now());
      if (rep) f.repeat = rep;
    }
    return { title: this.title.value().trim(), detail: this.detail.value().trim(), space: sp.id, spaceName: sp.name, ...f };
  }

  // Jam mulai dan bawa hasil cuma buat task itu; pilihan lain (model, cek, worktree, ...) tetap buat task berikutnya.
  resetForm() { this.editing = null; this.title.set_value(""); this.detail.set_value(""); this.afterIdx = 0; this.carry = false; this.at.set_value(""); this.repeatIdx = 0; }

  add(cx) {
    const sp = this.space();
    if (!this.title.value().trim() || !sp) return;
    const err = this.formError();
    if (err) { this.say(err, cx); return; }
    if (this.editing) return this.saveEdit(cx);
    const now = Date.now();
    const task = { id: newId(), ...this.formFields(sp), column: "todo", created: now, order: now };
    if (task.startAt) task.note = task.repeat ? `Jadwal ${REPEATS[task.repeat]} ${task.atTime}` : `Mulai ${fmtWhen(task.startAt)}`;
    this.resetForm();
    this.change((d) => d.tasks.push(task), cx);
  }

  // Isi form dari task atau template (pilihan yang gak ada lagi dilewati).
  fillForm(task) {
    this.title.set_value(task.title ?? "");
    this.detail.set_value(task.detail ?? "");
    const sps = spaces();
    let si = sps.findIndex((s) => s.id === task.space);
    if (si < 0) si = sps.findIndex((s) => s.name === task.spaceName);
    if (si >= 0) this.spaceIdx = si;
    const ai = task.target ? this.choices().findIndex((a) => a.address === task.target) : -1;
    this.agentIdx = ai + 1;
    this.modelIdx = task.model ? MODELS.indexOf(task.model) + 1 : 0;
    this.effortIdx = task.effort ? EFFORTS.indexOf(task.effort) + 1 : 0;
    this.priIdx = Math.max(0, PRIORITIES.indexOf(task.priority ?? "normal"));
    this.limitIdx = Math.max(0, LIMITS.indexOf(task.limitMin ?? 0));
    this.limitStop = Boolean(task.limitStop);
    const ci = COSTS.indexOf(task.costMax ?? 0);
    this.costIdx = Math.max(0, ci);
    this.costOther = ci < 0 ? task.costMax : null;
    this.afterIdx = task.after ? this.afterChoices().findIndex((x) => x.id === task.after) + 1 : 0;
    this.carry = Boolean(task.carry);
    this.check.set_value(task.check ?? "");
    this.worktree = Boolean(task.worktree);
    this.at.set_value(task.atTime ?? "");
    this.repeatIdx = Math.max(0, REPEAT_KEYS.indexOf(task.repeat ?? ""));
    if (task.check || task.costMax || task.carry || task.worktree || task.atTime) this.more = true;
    return { si, ai };
  }

  // Isi form dengan task yang mau diubah. Bisa buat task di Antrean dan task yang gagal/dihentikan.
  startEdit(task, cx) {
    this.editing = task.id;
    const { si, ai } = this.fillForm(task);
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
          else if (t.startAt) t.note = t.repeat ? `Jadwal ${REPEATS[t.repeat]} ${t.atTime}` : `Mulai ${fmtWhen(t.startAt)}`;
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
      if (column !== "todo") { delete t.startAt; delete t.atTime; delete t.repeat; delete t.runNow; } // dijalankan manual: jadwalnya batal
      t.note = column === "doing" ? "Nunggu dikirim ke agent…" : "";
      if (column === "doing") t.startedAt = Date.now();
    }, cx);
  }

  // Jadwal berulang: jalankan salinannya sekarang (mesin yang bikin), jadwalnya tetap.
  runNow(id, cx) {
    this.change((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (!t || !t.repeat || t.column !== "todo") return;
      t.runNow = true; t.note = "Dijalankan sekarang juga…";
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

  closeSelf() { const overlay = props()?.overlay; if (overlay) closeOverlay(overlay); }

  // Buka terminal staf yang pegang task ini (buat lihat kerjanya atau jawab pertanyaannya). Dialog ditutup biar gak nutupin.
  look(task, cx) {
    const a = task.agent ? agents().find((x) => x.address === task.agent) : null;
    if (!a) { this.say("Stafnya udah gak ada (terminalnya ditutup).", cx); return; }
    try { run("agent.focus", { terminal: a.address }); } catch (e) { this.say(`Gagal buka terminal: ${e?.message ?? e}`, cx); return; }
    this.closeSelf();
  }

  // Jawab pertanyaan staf langsung dari kartu (sama kayak ngetik di terminalnya lalu Enter).
  // Mesin kanban lanjut memantau sendiri begitu stafnya kerja lagi.
  answerState(id) {
    let st = this.answers.get(id);
    if (!st) {
      st = InputState.new({ placeholder: "Ketik jawaban buat staf, Enter buat kirim" });
      st.on("submit", (_e, cx) => { const t = this.tasks.find((x) => x.id === id); if (t) this.answer(t, st.value(), cx); });
      this.answers.set(id, st);
    }
    return st;
  }
  answer(task, text, cx) {
    const msg = String(text ?? "").trim();
    if (!msg) return;
    const a = task.agent ? agents().find((x) => x.address === task.agent) : null;
    if (!a) { this.say("Stafnya udah gak ada (terminalnya ditutup).", cx); return; }
    cx.spawn(async (cx) => {
      const r = await hc(["send", a.address, msg]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0) { this.say(`Gagal kirim jawaban: ${String(r.stderr ?? "").trim().split("\n").pop() || "hc send gagal"}`, cx); return; }
      this.answers.get(task.id)?.set_value("");
      this.say(`Jawaban dikirim ke ${staffName(a)}: "${msg.slice(0, 60)}". Kartunya jalan lagi begitu dia mulai kerja.`, cx);
    });
  }

  // Task yang stafnya nanya balik, tapi kamu anggap udah beres: pindah ke Selesai, hasilnya tetap disimpan.
  markDone(id, cx) {
    this.change((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (!t || !t.asking || t.column !== "doing") return;
      delete t.asking; delete t.choices; t.column = "done"; t.finishedAt = Date.now(); t.note = "Kamu tandai kelar";
    }, cx);
  }

  // Task yang ditahan karena usage Claude hampir habis: kirim sekarang juga.
  sendAnyway(id, cx) {
    this.change((d) => {
      const t = d.tasks.find((x) => x.id === id);
      if (!t || t.column !== "doing" || t.failed || t.sentAt) return;
      t.noHold = true; t.note = "Dikirim walau usage hampir habis…";
    }, cx);
  }

  // Tab baru di space task itu: `argv` di folder `folder` (di mesin space-nya kalau space-nya di mesin lain).
  openTab(task, name, folder, argv, cx) {
    try { run("tab.new", { space: task.space, name: name.slice(0, 40), ...(folder ? { folder } : {}), ...(argv ? { argv } : {}) }); }
    catch (e) { this.say(`Gagal buka tab: ${e?.message ?? e}`, cx); return; }
    this.closeSelf();
  }

  // Lihat perubahan task ini: ringkasan lalu diff lengkap sejak task dikirim, terminalnya tetap kebuka setelahnya.
  openDiff(task, cx) {
    const g = task.git, base = String(g?.base ?? "");
    if (!g?.top || !/^[0-9a-f]{7,64}$/.test(base)) return;
    const remote = Boolean(spaces().find((s) => s.id === task.space)?.machine);
    const script = `git --no-pager diff --stat ${base}; echo; git diff ${base}; exec "\${SHELL:-sh}"`;
    if (remote || window()?.platform !== "windows") this.openTab(task, `diff ${task.title}`, g.top, ["sh", "-c", script], cx);
    else if (g.top.startsWith("/")) this.openTab(task, `diff ${task.title}`, null, ["wsl.exe", "--cd", g.top, "-e", "sh", "-c", script], cx);
    else this.openTab(task, `diff ${task.title}`, g.top, ["powershell.exe", "-NoExit", "-Command", `git --no-pager diff --stat ${base}; git diff ${base}`], cx);
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
      for (const t of d.tasks) if (t.after === id) { delete t.after; delete t.afterTitle; delete t.carry; }
    }, cx);
  }

  clearDone(cx) {
    this.change((d) => { d.tasks = d.tasks.filter((x) => x.column !== "done" || x.restore?.length); }, cx);
  }

  // Template: isian form yang sering dipakai, disimpan di pixel-hq-kanban-templates.json (cuma dialog ini yang nulis).
  loadTemplates(cx) {
    cx.spawn(async (cx) => {
      const raw = await readTextFile(tplFile()).catch(() => null);
      try { const l = raw ? JSON.parse(raw).templates : []; this.templates = Array.isArray(l) ? l.filter((x) => x && typeof x.name === "string" && x.f) : []; } catch { this.templates = []; }
      if (this.tplIdx > this.templates.length) this.tplIdx = 0;
      cx.notify();
    });
  }
  editTemplates(fn, done, cx) {
    cx.spawn(async (cx) => {
      try {
        for (let i = 0; ; i++) {
          const raw = await readTextFile(tplFile()).catch(() => null);
          let l = []; try { l = raw ? JSON.parse(raw).templates ?? [] : []; } catch { l = []; }
          if (!Array.isArray(l)) l = [];
          const next = fn(l);
          try { await writeTextFile(tplFile(), JSON.stringify({ templates: next }, null, 2), raw); this.templates = next; break; }
          catch (e) { if (i >= 3) throw e; }
        }
        done(cx);
      } catch (e) { this.say(`Gagal nyimpan template: ${e?.message ?? e}`, cx); }
    });
  }
  saveTemplate(cx) {
    const sp = this.space(), name = this.title.value().trim().slice(0, 60);
    if (!name || !sp) { this.say("Isi judul dulu: judulnya jadi nama template.", cx); return; }
    const f = this.formFields(sp);
    delete f.startAt; delete f.after; delete f.afterTitle; delete f.carry; // jadwal dihitung ulang waktu dipakai; SETELAH terikat task tertentu
    this.editTemplates((l) => [...l.filter((x) => x.name !== name), { id: newId(), name, f }], (cx) => {
      this.tplIdx = this.templates.findIndex((x) => x.name === name) + 1;
      this.say(`Template "${name}" disimpan. Pakai lewat tombol TEMPLATE.`, cx);
    }, cx);
  }
  deleteTemplate(cx) {
    const tp = this.templates[this.tplIdx - 1];
    if (!tp) return;
    this.editTemplates((l) => l.filter((x) => x.name !== tp.name), (cx) => { this.tplIdx = 0; this.say(`Template "${tp.name}" dihapus.`, cx); }, cx);
  }
  nextTemplate(cx) {
    if (!this.templates.length) { this.say("Belum ada template. Isi form, lalu klik + JADI TEMPLATE.", cx); return; }
    this.tplIdx = (this.tplIdx + 1) % (this.templates.length + 1);
    const tp = this.templates[this.tplIdx - 1];
    if (!tp) { cx.notify(); return; }
    this.editing = null;
    this.fillForm(tp.f);
    this.say(`Template "${tp.name}" dipakai. Ubah kalau perlu, lalu + TAMBAH.`, cx);
  }

  // Notifikasi HP: disimpan di shared("pixel-hq.push"), dikirim mesin kanban (company-status) lewat curl.
  savePush(cx, quiet = false) {
    const url = this.pushUrl.value().trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) { this.say("Alamat notifikasi harus mulai dengan https://", cx); return false; }
    setShared("pixel-hq.push", url ? { url, mode: this.pushMode } : null);
    if (!quiet) this.say(url ? `Notifikasi HP nyala (${this.pushMode === "always" ? "selalu" : "kalau Herdr lagi gak kamu lihat"}).` : "Notifikasi HP mati.", cx);
    return Boolean(url);
  }
  testPush(cx) {
    if (!this.savePush(cx, true)) { this.say("Isi alamatnya dulu.", cx); return; }
    this.pushTestAt = Date.now();
    setShared("pixel-hq.push-test", this.pushTestAt);
    this.say("Ngirim tes ke HP… (dikirim mesin kanban dalam beberapa detik)", cx);
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
            delete t.wtPath; delete t.wtBranch; delete t.runNow; // folder worktree juga
            if (!t.id) t.id = newId();
            // space dicocokkan lewat nama; kalau gak ada, pakai space yang lagi dipilih
            const same = sp.find((s) => s.id === t.space) ?? sp.find((s) => s.name === t.spaceName);
            if (same) { t.space = same.id; t.spaceName = same.name; }
            else if (here) { t.note = `Space asal "${t.spaceName ?? "?"}" gak ada di sini`; t.space = here.id; t.spaceName = here.name; }
            // yang tadinya jalan masuk antrean dulu, biar gak langsung dikirim ke agent
            if (t.column !== "done") { if (t.column === "doing") moved++; t.column = "todo"; }
            // jadwal dihitung ulang dari sekarang, biar yang udah lewat gak langsung jalan
            const at = parseClock(t.atTime);
            if (at && t.column === "todo") t.startAt = nextRun(at, t.repeat, Date.now()); else { delete t.startAt; delete t.atTime; delete t.repeat; }
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

  // Kotak teks yang bisa dibuka-tutup (hasil kerja, output cek). `key` dipakai di this.open.
  fold(key, title, color, text, tip) {
    const t = theme(), opened = this.open.has(key);
    const shown = opened ? text : text.split("\n").filter((l) => l.trim()).slice(0, 3).join("\n").slice(0, 280);
    return v_flex().id(key).gap(3).p(7).bg(t.background).rounded(4).cursor_pointer()
      .tooltip(opened ? "Klik buat ringkas" : tip)
      .on_click((_e, cx) => { if (opened) this.open.delete(key); else this.open.add(key); cx.notify(); })
      .child(div().text_size(9.5).font_bold().text_color(color).child(`${title} ${opened ? "▾" : "▸"}`))
      .child(div().text_size(10.5).text_color(t.muted).child(shown + (!opened && shown.length < text.length ? " …" : "")));
  }

  card(task) {
    const t = theme(), i = COLS.findIndex((c) => c.id === task.column), now = Date.now();
    const list = sortedIn(this.tasks, task.column), pos = list.indexOf(task);
    const samePri = (o) => o && (o.priority ?? "normal") === (task.priority ?? "normal");
    const canUp = task.column !== "done" && samePri(list[pos - 1]), canDown = task.column !== "done" && samePri(list[pos + 1]);
    const dur = task.sentAt ? fmtDur((task.finishedAt ?? (task.failed ? task.failedAt : null) ?? now) - task.sentAt) : null;
    const dep = task.after ? this.tasks.find((x) => x.id === task.after) : null;
    const result = task.result ?? "";
    const editing = this.editing === task.id;
    const canEdit = task.column === "todo" || Boolean(task.failed);
    const asking = Boolean(task.asking && !task.failed && task.column === "doing"), held = Boolean(task.held && !task.failed && task.column === "doing" && !task.sentAt);
    const checking = Boolean((task.checking || task.checkWanted) && !task.failed && task.column === "doing");
    const canStop = task.column === "doing" && Boolean(task.sentAt && task.agent) && !task.failed && !task.stopWanted && !asking;
    const canLook = Boolean(task.agent) && agents().some((a) => a.address === task.agent);
    const cost = costText(task), diff = diffText(task.diff);
    const scheduled = task.column === "todo" && typeof task.startAt === "number";
    const repeating = task.column === "todo" && Boolean(task.repeat);
    const choices = Array.isArray(task.choices) ? task.choices.filter((c) => typeof c === "string" && c.trim()).slice(0, 5) : [];
    const edge = editing ? "#89b4fa" : task.stopped ? "#fab387" : task.failed ? "#f38ba8" : asking ? "#f5c2e7" : held ? "#94e2d5" : checking ? CHECK_COLOR : task.overdue || task.overCost ? "#f9b84a" : repeating ? "#f9e2af" : t.border;
    const answerBox = this.answers.get(task.id);
    const answerRow = asking && canLook ? v_flex().gap(4)
      .when(choices.length > 0, (el) => el.child(h_flex().gap(4).flex_wrap().children(choices.map((c, n) =>
        this.btn(`ch-${task.id}-${n}`, c.length > 36 ? `${c.slice(0, 35)}…` : c, "#f5c2e7", (cx) => this.answer(task, c, cx), `Kirim jawaban ini ke staf: ${c}`)))))
      .when(Boolean(answerBox), (el) => el.child(h_flex().gap(4).items_center()
        .child(div().flex_1().min_w(0).h(24).px(8).flex().items_center().bg(t.background).border_1().border_color(t.border).rounded(4)
          .child(Input.new(answerBox).w_full().text_size(11).text_color(t.foreground)))
        .child(this.btn(`kirim-${task.id}`, "KIRIM ▸", "#f5c2e7", (cx) => this.answer(task, answerBox.value(), cx), "Kirim jawaban ini ke terminal staf (sama kayak ngetik lalu Enter)")))) : null;
    return v_flex().id(`card-${task.id}`).gap(5).p(9).bg(t.surface).border_1().border_color(edge).rounded(6)
      .child(h_flex().gap(6).items_center()
        .when(Boolean(task.failed), (el) => el.child(task.stopped ? this.tag("DIHENTIKAN", "#fab387") : this.tag("GAGAL", "#f38ba8")))
        .when(asking, (el) => el.child(this.tag("PERLU JAWABAN", "#f5c2e7")))
        .when(held, (el) => el.child(this.tag("DITAHAN", "#94e2d5")))
        .when(checking, (el) => el.child(this.tag("NGECEK", CHECK_COLOR)))
        .when(repeating, (el) => el.child(this.tag("JADWAL", "#f9e2af")))
        .when(editing, (el) => el.child(this.tag("LAGI DIEDIT", "#89b4fa")))
        .child(div().flex_1().min_w(0).text_size(12.5).font_semibold().text_color(t.foreground).child(task.title)))
      .when(Boolean(task.detail), (el) => el.child(div().text_size(11).text_color(t.muted).child(task.detail)))
      .child(h_flex().gap(6).items_center().flex_wrap()
        .child(this.tag(task.spaceName ?? "?", t.accent))
        .when(Boolean(task.priority && task.priority !== "normal"), (el) => el.child(this.tag(task.priority === "tinggi" ? "▲ TINGGI" : "▼ RENDAH", PRI_COLOR[task.priority])))
        .when(Boolean(task.model || task.effort), (el) => el.child(this.tag([task.model, task.effort].filter(Boolean).join(" · "), "#cba6f7")))
        .when(Boolean(task.targetName && !task.worktree), (el) => el.child(this.tag(task.targetName, "#f9b84a")))
        .when(Boolean(task.after), (el) => el.child(this.tag(`⛓ setelah: ${(dep?.title ?? task.afterTitle ?? "?").slice(0, 24)}${dep?.column === "done" ? " ✓" : ""}`, dep?.column === "done" ? "#a6e3a1" : "#89dceb")))
        .when(Boolean(task.after && task.carry), (el) => el.child(this.tag("↪ bawa hasil", "#89dceb")))
        .when(scheduled, (el) => el.child(this.tag(task.repeat ? `⟳ ${REPEATS[task.repeat]} ${task.atTime} · berikutnya ${fmtWhen(task.startAt)}` : `⏰ mulai ${fmtWhen(task.startAt)}`, "#f9e2af")))
        .when(Boolean(task.fromRepeat), (el) => el.child(this.tag("⟳ dari jadwal", t.dim)))
        .when(Boolean(dur), (el) => el.child(this.tag(`⏱ ${dur}${task.limitMin ? ` / ${task.limitMin} mnt` : ""}`, task.overdue ? "#f9b84a" : t.muted)))
        .when(Boolean(!dur && task.limitMin), (el) => el.child(this.tag(`batas ${task.limitMin} mnt${task.limitStop ? " ■" : ""}`, t.muted)))
        .when(Boolean(dur && task.limitStop && !task.failed), (el) => el.child(this.tag("lewat = stop", t.dim)))
        .when(Boolean(task.costMax), (el) => el.child(this.tag(`$ maks ${fmtUsd(task.costMax)}${task.limitStop ? " ■" : ""}`, task.overCost ? "#f9b84a" : t.muted)))
        .when(Boolean(cost), (el) => el.child(this.tag(cost, "#a6e3a1")))
        .when(Boolean(task.check), (el) => el.child(this.tag(`✓ cek: ${task.check.slice(0, 24)}${task.checkOk ? " · lolos" : task.checkRounds ? ` · gagal ${task.checkRounds}x` : ""}`, task.checkOk ? "#a6e3a1" : CHECK_COLOR)))
        .when(Boolean(task.worktree), (el) => el.child(this.tag(`⎇ ${task.wtBranch ?? "worktree baru"}`, "#b4befe")))
        .when(Boolean(diff), (el) => el.child(this.tag(diff, "#a6e3a1")))
        .when(task.source === "terminal", (el) => el.child(this.tag("⌨ terminal", t.dim)))
        .when(Boolean(task.overdue && task.column === "doing"), (el) => el.child(this.tag("LEWAT BATAS", "#f9b84a")))
        .when(Boolean(task.overCost && task.column === "doing"), (el) => el.child(this.tag("LEWAT BIAYA", "#f9b84a")))
        .when(Boolean(task.restore?.length), (el) => el.child(this.tag("ngembaliin model…", "#cba6f7"))))
      .when(Boolean(task.note), (el) => el.child(div().text_size(10).text_color(task.stopped ? "#fab387" : task.failed ? "#f38ba8" : asking ? "#f5c2e7" : held ? "#94e2d5" : checking ? CHECK_COLOR : task.column === "doing" ? "#f9b84a" : t.dim).child(task.note)))
      .when(Boolean(result), (el) => el.child(this.fold(`hasil-${task.id}`, `${asking ? "PERTANYAAN STAF" : "HASIL"}${task.resultFrom === "layar" ? " (dari layar terminal)" : ""}`,
        asking ? "#f5c2e7" : "#a6e3a1", result, "Klik buat lihat hasil lengkap")))
      .when(Boolean(task.checkLog && (task.failed || task.checkRounds || task.checkOk)), (el) => el.child(this.fold(`cek-${task.id}`, `OUTPUT CEK${task.checkOk ? " (lolos)" : ""}`,
        task.checkOk ? "#a6e3a1" : CHECK_COLOR, task.checkLog, "Klik buat lihat output cek lengkap")))
      .when(Boolean(answerRow), (el) => el.child(answerRow))
      .child(h_flex().gap(4).flex_wrap()
        .when(i > 0, (el) => el.child(this.btn(`l-${task.id}`, "◀", t.muted, (cx) => this.move(task.id, COLS[i - 1].id, cx), `Pindah ke ${COLS[i - 1].label.toLowerCase()}`)))
        .when(repeating, (el) => el.child(this.btn(`run-${task.id}`, "JALANKAN ▶", "#f9b84a", (cx) => this.runNow(task.id, cx), "Jalankan salinan task ini sekarang. Jadwalnya tetap di Antrean.")))
        .when(i < COLS.length - 1 && !repeating, (el) => el.child(this.btn(`r-${task.id}`, i === 0 ? "KERJAKAN ▶" : "▶", i === 0 ? "#f9b84a" : t.muted, (cx) => this.move(task.id, COLS[i + 1].id, cx),
          i === 0 ? `Pindah ke sedang dikerjakan: agent di space ini langsung ngerjain${scheduled ? " (jadwalnya batal)" : ""}` : `Pindah ke ${COLS[i + 1].label.toLowerCase()}`)))
        .when(canStop, (el) => el.child(this.btn(`s-${task.id}`, "STOP ■", "#fab387", (cx) => this.stop(task.id, cx), "Suruh agent berhenti ngerjain task ini (tombol stop, sama kayak Esc). Kartunya ditandai dihentikan; ULANGI buat kirim lagi.")))
        .when(Boolean(task.stopWanted && task.column === "doing"), (el) => el.child(this.tag("menghentikan…", "#fab387")))
        .when(canLook, (el) => el.child(this.btn(`v-${task.id}`, asking ? "TERMINAL ▸" : "LIHAT ▸", asking ? "#f5c2e7" : "#89dceb", (cx) => this.look(task, cx),
          asking ? "Buka terminal staf (buat jawab panjang atau lihat konteksnya). Setelah dijawab, task jalan lagi sendiri." : "Buka terminal staf yang pegang task ini")))
        .when(asking, (el) => el.child(this.btn(`k-${task.id}`, "KELAR ✓", "#a6e3a1", (cx) => this.markDone(task.id, cx), "Anggap task ini udah beres tanpa jawab pertanyaannya (pindah ke Selesai)")))
        .when(held, (el) => el.child(this.btn(`h-${task.id}`, "KIRIM AJA", "#94e2d5", (cx) => this.sendAnyway(task.id, cx), "Kirim sekarang walau usage Claude hampir habis")))
        .when(Boolean(task.git?.base) && (task.column === "done" || Boolean(task.failed)), (el) => el.child(this.btn(`diff-${task.id}`, "DIFF ▸", "#a6e3a1", (cx) => this.openDiff(task, cx),
          "Buka tab baru berisi perubahan file sejak task ini dikirim (git diff)")))
        .when(Boolean(task.wtPath), (el) => el.child(this.btn(`wt-${task.id}`, "FOLDER ▸", "#b4befe", (cx) => this.openTab(task, task.wtBranch ?? task.title, task.wtPath, null, cx),
          `Buka terminal di worktree task ini (${task.wtBranch ?? ""}). Gabungkan branch-nya sendiri kalau udah oke.`)))
        .when(Boolean(task.failed) || task.column === "done", (el) => el.child(this.btn(`u-${task.id}`, "ULANGI ↻", "#f38ba8", (cx) => this.retry(task.id, cx), "Kirim ulang task ini ke agent")))
        .when(canEdit && !editing, (el) => el.child(this.btn(`e-${task.id}`, "EDIT", "#89b4fa", (cx) => this.startEdit(task, cx), "Ubah judul, detail, dan pilihan task ini di form atas")))
        .when(canUp, (el) => el.child(this.btn(`up-${task.id}`, "▲", t.muted, (cx) => this.nudge(task.id, -1, cx), "Naikkan urutan")))
        .when(canDown, (el) => el.child(this.btn(`dn-${task.id}`, "▼", t.muted, (cx) => this.nudge(task.id, 1, cx), "Turunkan urutan")))
        .when(task.column !== "done", (el) => el.child(this.btn(`p-${task.id}`, "PRIO", PRI_COLOR[task.priority ?? "normal"] ?? t.muted, (cx) => this.cyclePriority(task.id, cx), "Ganti prioritas: normal → tinggi → rendah")))
        .child(div().flex_1())
        .child(this.btn(`x-${task.id}`, "HAPUS", "#f38ba8", (cx) => this.remove(task.id, cx), task.wtPath ? "Hapus task (worktree dan branch-nya gak dihapus)" : "Hapus task")));
  }

  pushRow(compact) {
    const t = theme(), cur = shared("pixel-hq.push"), res = shared("pixel-hq.push-result");
    const status = res && this.pushTestAt && res.at >= this.pushTestAt
      ? (res.ok ? "Tes terkirim ✓" : `Tes gagal: ${res.msg || "curl error"}`)
      : cur?.url ? `Nyala: ${cur.mode === "always" ? "selalu" : "kalau Herdr gak dilihat"}` : "Mati";
    const modeBtn = div().id("push-mode").h(30).px(10).flex().items_center().cursor_pointer().bg(t.raised).rounded(5).text_size(11).text_color("#cba6f7")
      .tooltip("Kapan dikirim ke HP: cuma kalau jendela Herdr lagi gak kamu lihat (bawaan), atau selalu. Klik SIMPAN setelah ganti.")
      .on_click((_e, cx) => { this.pushMode = this.pushMode === "always" ? "away" : "always"; cx.notify(); })
      .child(`KIRIM: ${this.pushMode === "always" ? "selalu" : "kalau gak dilihat"} ▾`);
    const field = div().h(30).px(10).flex().items_center().bg(t.surface).border_1().border_color(t.border).rounded(5).flex_1().min_w(0)
      .child(Input.new(this.pushUrl).w_full().text_size(12).text_color(t.foreground));
    const btns = h_flex().gap(4).items_center()
      .child(this.btn("push-simpan", "SIMPAN", "#a6e3a1", (cx) => this.savePush(cx), "Simpan alamat dan kapan dikirimnya"))
      .child(this.btn("push-tes", "TES", "#89dceb", (cx) => this.testPush(cx), "Kirim notifikasi tes ke alamat ini"))
      .child(this.btn("push-mati", "MATIKAN", "#f38ba8", (cx) => { this.pushUrl.set_value(""); this.savePush(cx); }, "Hapus alamat, notifikasi HP mati"))
      .child(div().text_size(10).text_color(res && !res.ok && res.at >= this.pushTestAt ? "#f38ba8" : t.dim).child(status));
    const help = div().text_size(10).text_color(t.dim).child("Task kelar, nanya balik, gagal, dan lewat batas dikirim ke alamat ini lewat curl. ntfy: pasang app ntfy di HP, langganan topik yang sama. Discord/Slack: URL webhook. Telegram: https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>.");
    return v_flex().gap(6).p(8).bg(t.background).rounded(6)
      .child(compact ? v_flex().gap(6).child(field).child(h_flex().gap(6).child(modeBtn)).child(btns) : h_flex().gap(6).items_center().child(field).child(modeBtn).child(btns))
      .child(help);
  }

  render() {
    const t = theme(), sp = this.space(), overlay = props()?.overlay;
    const compact = !overlay;
    const pushOn = Boolean(shared("pixel-hq.push")?.url);
    const header = h_flex().items_center().gap(6)
      .child(div().flex_1().text_size(13).font_bold().text_color("#b4befe").child(compact ? "KANBAN" : "KANBAN · TUGAS BUAT AGENT"))
      .child(this.btn("rekap", "REKAP", t.muted, () => { setShared("pixel-hq.usage-tab", "rekap"); this.closeSelf(); run("mod.open", { name: "company-usage" }); },
        "Rekap task: berapa yang kelar dan gagal, biaya, dan durasi per hari, per staf, dan per model"))
      .child(this.btn("hp", pushOn ? "HP ●" : "HP", pushOn ? "#a6e3a1" : t.muted, (cx) => { this.pushOpen = !this.pushOpen; cx.notify(); },
        "Notifikasi ke HP (ntfy, Discord, Slack, Telegram) waktu task kelar, nanya balik, atau gagal"))
      .child(this.btn("ekspor", "EKSPOR", t.muted, (cx) => this.exportBoard(cx), "Simpan papan ke file JSON (buat impor lagi) dan Markdown (buat dibaca)"))
      .child(this.btn("impor", "IMPOR", t.muted, (cx) => this.importBoard(cx), "Ambil task dari file ekspor JSON. Task yang udah ada gak didobel; yang tadinya jalan masuk antrean."))
      .when(!compact, (el) => el.child(this.btn("tutup", "TUTUP (ESC)", t.muted, () => overlay && closeOverlay(overlay), "Tutup papan")));
    const field = (st, w) => div().h(30).px(10).flex().items_center().bg(t.surface).border_1().border_color(t.border).rounded(5)
      .when(Boolean(w), (el) => el.w(w)).when(!w, (el) => el.flex_1()).child(Input.new(st).w_full().text_size(12).text_color(t.foreground));
    const spaceBtn = div().id("pilih-space").h(30).px(10).flex().items_center().cursor_pointer().bg(t.raised).rounded(5).text_size(11).text_color(t.accent)
      .tooltip("Space (sesi) yang ngerjain task ini. Klik buat ganti.").on_click((_e, cx) => { this.spaceIdx++; this.agentIdx = 0; cx.notify(); })
      .child(`SPACE: ${sp?.name ?? "-"}${sp?.machine ? ` @${sp.machine}` : ""} ▾`);
    const list = this.choices(), pick = list[this.agentIdx - 1];
    if (this.agentIdx > list.length) this.agentIdx = 0;
    const agentBtn = div().id("pilih-agent").h(30).px(10).flex().items_center().cursor_pointer().bg(t.raised).rounded(5).text_size(11).text_color(pick && !this.worktree ? "#f9b84a" : t.muted)
      .tooltip(this.worktree ? "Task worktree selalu dikerjain agent baru di worktree-nya, pilihan staf diabaikan." : "Staf (sesi terminal) yang ngerjain task ini. Klik buat ganti: otomatis = staf mana pun yang lagi nganggur di space ini.")
      .on_click((_e, cx) => { this.agentIdx = (this.agentIdx + 1) % (this.choices().length + 1); cx.notify(); })
      .child(`STAF: ${this.worktree ? "agent baru" : pick ? this.agentLabel(pick) : "otomatis"} ▾`);
    const cyc = (id, text, on, tip, fn, color = "#cba6f7") => div().id(id).h(30).px(10).flex().items_center().cursor_pointer().bg(t.raised).rounded(5).text_size(11)
      .text_color(on ? color : t.muted).tooltip(tip).on_click((_e, cx) => { fn(cx); cx.notify(); }).child(text);
    const modelBtn = cyc("pilih-model", `MODEL: ${this.modelIdx ? MODELS[this.modelIdx - 1] : "bawaan"} ▾`, this.modelIdx,
      "Model Claude buat task ini. Dikirim ke sesi staf lewat /model sebelum task, lalu dikembalikan ke model sebelumnya setelah task kelar. Bawaan = gak diubah.", () => { this.modelIdx = (this.modelIdx + 1) % (MODELS.length + 1); });
    const effortBtn = cyc("pilih-effort", `EFFORT: ${this.effortIdx ? EFFORTS[this.effortIdx - 1] : "bawaan"} ▾`, this.effortIdx,
      "Effort buat task ini. Dikirim lewat /effort sebelum task, lalu dikembalikan setelah task kelar. Bawaan = gak diubah.", () => { this.effortIdx = (this.effortIdx + 1) % (EFFORTS.length + 1); });
    const priBtn = cyc("pilih-prio", `PRIORITAS: ${PRIORITIES[this.priIdx]} ▾`, this.priIdx,
      "Prioritas tinggi dikirim duluan kalau beberapa task nunggu staf yang sama.", () => { this.priIdx = (this.priIdx + 1) % PRIORITIES.length; }, PRI_COLOR[PRIORITIES[this.priIdx]] ?? "#cba6f7");
    const limitBtn = cyc("pilih-batas", `BATAS: ${this.limitIdx ? `${LIMITS[this.limitIdx]} mnt` : "tanpa"} ▾`, this.limitIdx,
      "Batas waktu kerja agent. Lewat batas = notifikasi dan kartunya ditandai; atur di LEWAT BATAS apakah agent sekalian dihentikan.", () => { this.limitIdx = (this.limitIdx + 1) % LIMITS.length; }, "#f9b84a");
    const cost = this.costIdx ? COSTS[this.costIdx] : this.costOther;
    const overBtn = cyc("pilih-lewat", `LEWAT BATAS: ${this.limitStop ? "hentikan" : "ingatkan"} ▾`, this.limitStop,
      "Berlaku buat batas waktu dan batas biaya. Ingatkan = cuma notifikasi. Hentikan = agent disuruh berhenti (kayak tombol STOP), kartunya ditandai dihentikan dan bisa diulang.", () => { this.limitStop = !this.limitStop; }, "#fab387");
    const deps = this.afterChoices();
    if (this.afterIdx > deps.length) this.afterIdx = 0;
    const dep = deps[this.afterIdx - 1];
    const afterBtn = cyc("pilih-setelah", `SETELAH: ${dep ? dep.title.slice(0, 18) : "-"} ▾`, this.afterIdx,
      "Task ini baru dikirim setelah task yang dipilih masuk Selesai. Klik buat ganti.", () => { this.afterIdx = (this.afterIdx + 1) % (this.afterChoices().length + 1); }, "#89dceb");
    const extras = Boolean(this.check.value().trim() || cost || this.carry || this.worktree || this.at.value().trim() || this.repeatIdx);
    const moreBtn = cyc("opsi-lain", `OPSI LAIN ${this.more ? "▴" : "▾"}`, this.more || extras,
      "CEK setelah kelar, batas biaya, bawa hasil task sebelumnya, worktree, jam mulai dan ulang, dan template", () => { this.more = !this.more; }, "#94e2d5");
    const costBtn = cyc("pilih-biaya", `BIAYA MAKS: ${cost ? fmtUsd(cost) : "tanpa"} ▾`, cost,
      "Batas biaya task ini (dari biaya sesi staf). Lewat batas = notifikasi, atau agent dihentikan kalau LEWAT BATAS = hentikan.", () => { this.costIdx = (this.costIdx + 1) % COSTS.length; this.costOther = null; }, "#f9b84a");
    const carryBtn = cyc("pilih-bawa", `BAWA HASIL: ${this.carry ? "ya" : "gak"} ▾`, this.carry,
      "Hasil task yang dipilih di SETELAH ditempel di bawah task ini waktu dikirim ke agent.", (cx) => { if (!dep) { this.say("Pilih dulu task di SETELAH.", cx); return; } this.carry = !this.carry; }, "#89dceb");
    const wtBtn = cyc("pilih-worktree", `WORKTREE: ${this.worktree ? "ya" : "gak"} ▾`, this.worktree,
      "Ya = task dikerjain agent baru di git worktree dan branch sendiri (kanban/<judul>), jadi gak nabrak task lain di repo yang sama. Folder space-nya harus repo git.", () => { this.worktree = !this.worktree; }, "#b4befe");
    const repeatBtn = cyc("pilih-ulang", `ULANG: ${this.repeatIdx ? REPEATS[REPEAT_KEYS[this.repeatIdx]] : "sekali"} ▾`, this.repeatIdx,
      "Sekali = task masuk Antrean dan jalan sendiri di JAM itu. Tiap hari / hari kerja = jadi jadwal: tiap jam itu salinannya dijalankan.", () => { this.repeatIdx = (this.repeatIdx + 1) % REPEAT_KEYS.length; }, "#f9e2af");
    const tp = this.templates[this.tplIdx - 1];
    const tplBtn = cyc("pilih-template", `TEMPLATE: ${tp ? tp.name.slice(0, 18) : "-"} ▾`, tp,
      "Isi form dari template yang disimpan. Klik buat ganti ke template berikutnya.", (cx) => this.nextTemplate(cx), "#94e2d5");
    const saveTplBtn = this.btn("simpan-template", "+ JADI TEMPLATE", "#94e2d5", (cx) => this.saveTemplate(cx), "Simpan isian form sekarang jadi template (namanya = judul). Nama yang sama ditimpa.");
    const delTplBtn = this.btn("hapus-template", "HAPUS TEMPLATE", "#f38ba8", (cx) => this.deleteTemplate(cx), "Hapus template yang lagi dipilih");
    const addBtn = h_flex().gap(6)
      .when(Boolean(this.editing), (el) => el.child(div().id("batal-edit").h(30).px(10).flex().items_center().cursor_pointer().bg(t.raised).text_color(t.muted).rounded(5).text_size(11).font_bold()
        .hover((s) => s.bg(t.hover)).tooltip("Batal ngedit, form kosong lagi").on_click((_e, cx) => this.cancelEdit(cx)).child("BATAL")))
      .child(div().id("tambah").h(30).px(12).flex().items_center().cursor_pointer().bg(this.editing ? "#a6e3a1" : "#89b4fa").text_color(t.chrome).rounded(5).text_size(11).font_bold()
        .hover((s) => s.opacity(0.85)).tooltip(this.editing ? "Simpan perubahan task yang lagi diedit" : "Tambah task ke Antrean").on_click((_e, cx) => this.add(cx)).child(this.editing ? "SIMPAN ✓" : "+ TAMBAH"));
    const showOver = this.limitIdx > 0 || Boolean(cost);
    const more = compact
      ? v_flex().gap(6).child(field(this.check))
        .child(h_flex().gap(6).child(costBtn).child(wtBtn))
        .child(h_flex().gap(6).child(field(this.at, 120)).child(repeatBtn))
        .when(this.afterIdx > 0, (el) => el.child(h_flex().gap(6).child(carryBtn)))
        .child(h_flex().gap(6).flex_wrap().child(tplBtn).child(saveTplBtn).when(Boolean(tp), (el) => el.child(delTplBtn)))
      : v_flex().gap(6)
        .child(h_flex().gap(6).items_center().flex_wrap().child(field(this.check, 260)).child(costBtn).when(this.afterIdx > 0, (el) => el.child(carryBtn)).child(wtBtn).child(field(this.at, 130)).child(repeatBtn))
        .child(h_flex().gap(6).items_center().flex_wrap().child(tplBtn).child(saveTplBtn).when(Boolean(tp), (el) => el.child(delTplBtn)));
    const form = compact
      ? v_flex().gap(6).child(field(this.title)).child(field(this.detail))
        .child(h_flex().gap(6).child(spaceBtn).child(agentBtn))
        .child(h_flex().gap(6).child(modelBtn).child(effortBtn))
        .child(h_flex().gap(6).child(priBtn).child(limitBtn))
        .when(showOver, (el) => el.child(h_flex().gap(6).child(overBtn)))
        .child(h_flex().gap(6).child(afterBtn).child(moreBtn))
        .when(this.more, (el) => el.child(more))
        .child(h_flex().gap(6).child(div().flex_1()).child(addBtn))
      : v_flex().gap(8)
        .child(h_flex().gap(8).items_center().child(field(this.title)).child(field(this.detail, 260)).child(addBtn))
        .child(h_flex().gap(6).items_center().flex_wrap().child(spaceBtn).child(agentBtn).child(modelBtn).child(effortBtn).child(priBtn).child(limitBtn).when(showOver, (el) => el.child(overBtn)).child(afterBtn).child(moreBtn))
        .when(this.more, (el) => el.child(more));
    const column = (c, full) => {
      const list = sortedIn(this.tasks, c.id), failed = list.filter((x) => x.failed && !x.stopped).length, asking = list.filter((x) => x.asking && !x.failed).length;
      const checking = list.filter((x) => (x.checking || x.checkWanted) && !x.failed).length;
      return v_flex().flex_1().h_full().min_w(0).gap(8).p(8).bg(t.background).rounded(8)
        .child(h_flex().gap(6).items_center().child(div().size(7).bg(c.color)).child(div().text_size(11).font_bold().text_color(c.color).child(c.label)).child(div().text_size(10).text_color(t.dim).child(String(list.length)))
          .when(asking > 0, (el) => el.child(div().text_size(10).text_color("#f5c2e7").child(`${asking} nanya`)))
          .when(checking > 0, (el) => el.child(div().text_size(10).text_color(CHECK_COLOR).child(`${checking} dicek`)))
          .when(failed > 0, (el) => el.child(div().text_size(10).text_color("#f38ba8").child(`${failed} gagal`)))
          .when(c.id === "done" && list.length > 0, (el) => el.child(div().flex_1()).child(this.btn(`bersih-${full ? "f" : "c"}`, "BERSIHKAN", t.dim, (cx) => this.clearDone(cx), "Hapus semua task di Selesai (rekapnya tetap ada)"))))
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
    return (compact ? root : root.border_1().border_color(t.border).rounded(10)).child(header)
      .when(this.pushOpen, (el) => el.child(this.pushRow(compact)))
      .child(form)
      .when(Boolean(this.msg), (el) => el.child(div().text_size(11).text_color("#a6e3a1").child(this.msg)))
      .child(body);
  }
}
