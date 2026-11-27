// Mesin kanban: tiap beberapa detik cek task yang ada di kolom "doing".
// Belum terkirim -> kirim ke agent yang nganggur di space-nya (hc send), atau buka agent baru kalau space itu belum punya.
// Sudah terkirim -> pantau; kalau agent-nya balik idle/done, task pindah ke "selesai".
// Tambahan: urutan prioritas, task yang nunggu task lain, batas waktu (bisa sekalian menghentikan), status gagal,
// hasil kerja dari hook Stop (claude-activity.py), dan model/effort staf dikembalikan ke setelan sebelumnya.
// Tombol STOP di kartu cuma menandai `stopWanted`; mesin ini yang menekan tombol stop agent (hc interrupt),
// supaya gak balapan dengan pengecekan "staf udah nganggur = task kelar".
// Juga: task ditahan kalau usage Claude hampir habis, balasan yang berupa pertanyaan bikin kartu nunggu jawaban,
// biaya/token per task dari label statusline, dan task dari terminal (pixel-hq-task) lewat pixel-hq-kanban-inbox.json.
import { agents, terminals, spaces, panes, shared, hc, run, appHome, readTextFile, writeTextFile, notify } from "herdr";
import { readState } from "./state.js";

const file = () => `${appHome()}/pixel-hq-kanban.json`;
// Ditulis cuma oleh pixel-hq-task (mods/company-kanban/pixel-hq-task.*); mesin ini cuma membacanya.
const inboxFile = () => `${appHome()}/pixel-hq-kanban-inbox.json`;
// File di ~/.local/state/pixel-hq (ditulis statusline dan hook Claude Code), dibaca lewat readState: di Windows
// juga dari WSL, tempat Claude Code-nya bisa jalan (cuma dari distro yang lagi jalan). Itu manggil wsl.exe, jadi
// yang dicek terus-terusan di-cache, di sini dan di state.js (dibagi dengan status bar).
const USAGE = "claude-usage.json";
const lastOf = (addr) => `last/${addr}.json`;
const staffName = (a) => {
  const own = (shared("pixel-hq.names") ?? {})[a.pane]?.name; // nama acak/pilihan sendiri (company-agents/names.js)
  if (own) return own;
  const tab = (a.tab_name ?? "").trim();
  if (tab && !/^\d+$/.test(tab)) return tab;
  const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return a.pane_name || clean(a.title) || a.program?.name || a.address;
};
const textOf = (t) => (t.detail ? `${t.title}\n\n${t.detail}` : t.title);
const PRI = { tinggi: 0, normal: 1, rendah: 2 };
export const sortTasks = (a, b) => (PRI[a.priority ?? "normal"] - PRI[b.priority ?? "normal"]) || ((a.order ?? a.created) - (b.order ?? b.created));
export const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000)), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h) return `${h} jam ${m % 60} mnt`;
  if (m) return `${m} mnt ${s % 60} dtk`;
  return `${s} dtk`;
};
const MAX_TRIES = 5;
const MODELS = ["opus", "sonnet", "haiku", "fable"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// Label agent.model berisi nama tampilan ("Opus 5.5"); /model butuh alias ("opus").
const modelAlias = (display) => { const w = String(display ?? "").trim().toLowerCase().split(/\s+/)[0]; return MODELS.includes(w) ? w : null; };
const labelsOf = (addr) => { try { return terminals().find((x) => x.address === addr)?.labels ?? {}; } catch { return {}; } };
const isFree = (a) => a.status === "idle" || a.status === "done";
const isClaude = (a) => /claude/i.test(`${a.app ?? ""} ${a.program?.name ?? ""}`);
// Jawaban yang jelas-jelas error dari Claude Code, bukan hasil kerja.
const AGENT_ERROR = /^(API Error|Claude AI usage limit reached|.*usage limit reached)/i;
// Perintah buat ngembaliin model/effort staf ke setelan sebelum task.
const backOf = (t) => [t.prevModel && `/model ${t.prevModel}`, t.prevEffort && `/effort ${t.prevEffort}`].filter(Boolean);
// Agent baru buat space yang belum punya staf: model/effort langsung lewat argumen claude (--model, --effort).
export const newAgentArgv = (t) => ["claude", ...(t.model ? ["--model", t.model] : []), ...(t.effort ? ["--effort", t.effort] : [])];
const num = (v) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : null; };
// Biaya (USD) dan token sesi staf sekarang, dari label claude-statusline (agent.cost, agent.tokens). null = gak dilaporkan.
const meterOf = (addr) => { const L = labelsOf(addr); return { cost: num(L["agent.cost"]), tok: num(L["agent.tokens"]) }; };

// Usage Claude ditahan dari angka ini: task yang belum terkirim ke Claude ditunda sampai jendelanya reset.
export const HOLD_AT = 95;
const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
export const fmtClock = (sec, nowMs) => {
  const d = new Date(sec * 1000), p = (n) => String(n).padStart(2, "0"), hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return sec * 1000 - nowMs > 20 * 3600000 ? `${HARI[d.getDay()]} ${hm}` : hm;
};
// Jendela usage yang udah >= HOLD_AT dan belum reset (yang resetnya paling lama, kalau dua-duanya), atau null.
// Persennya cuma bisa naik sampai reset, jadi data lama pun masih benar selama waktu resetnya belum lewat.
export function usageHold(u, nowMs) {
  let hit = null;
  for (const [label, w] of [["sesi 5 jam", u?.session], ["minggu ini", u?.week]]) {
    if (typeof w?.used !== "number" || w.used < HOLD_AT || typeof w.resets !== "number" || w.resets * 1000 <= nowMs) continue;
    if (!hit || w.resets > hit.resets) hit = { label, used: Math.round(w.used), resets: w.resets };
  }
  return hit;
}

// Balasan agent yang baris terakhirnya pertanyaan: kemungkinan dia nunggu jawaban, bukan kelar.
// Penutup markdown (**, _, `, kurung, kutip) di ujung baris diabaikan.
export function asksBack(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const last = (lines.pop() ?? "").replace(/[\s*_`"'”’)\]]+$/u, "");
  return /[?？]$/.test(last);
}
export const lastLine = (text) => String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

// Task dari terminal (pixel-hq-task) masuk lewat pixel-hq-kanban-inbox.json: daftar task yang cuma ditulis perintah itu.
// Yang udah diambil dicatat di `imported` (id) di file papan, jadi task yang kamu hapus gak muncul lagi,
// dan pixel-hq-task membuang entri yang udah diambil dari inbox.
export const MAX_IMPORTED = 500;
const INBOX_MAX_AGE = 7 * 86400000;
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
function spaceFor(e, sps, pns) {
  if (e.spaceName) {
    const want = String(e.spaceName).trim().toLowerCase();
    const s = sps.find((x) => String(x.name ?? "").toLowerCase() === want);
    if (s) return { sp: s };
  }
  if (e.fromTerminal) {
    // dijalankan dari terminal Herdr: masuk ke space terminal itu
    const p = pns.find((x) => x.terminal === e.fromTerminal);
    const s = p && sps.find((x) => (x.tabs ?? []).some((tb) => tb.id === p.tab));
    if (s) return { sp: s, missed: Boolean(e.spaceName) };
  }
  const s = sps.find((x) => x.active) ?? sps[0];
  return s ? { sp: s, missed: Boolean(e.spaceName) } : null;
}
export function importInbox(d, entries, sps, pns, now) {
  if (!Array.isArray(entries)) return 0;
  const seen = new Set([...(Array.isArray(d.imported) ? d.imported : []), ...d.tasks.map((t) => t.id)]);
  let added = 0;
  for (const e of entries) {
    if (!e || typeof e.id !== "string" || !/^[\w-]{1,40}$/.test(e.id) || seen.has(e.id)) continue;
    if (typeof e.created === "number" && now - e.created > INBOX_MAX_AGE) continue; // pixel-hq-task juga membuangnya
    const title = str(e.title, 2000);
    const where = title ? spaceFor(e, sps, pns) : null;
    if (title && !where) continue; // belum ada space sama sekali: coba lagi nanti
    seen.add(e.id);
    d.imported = [...(Array.isArray(d.imported) ? d.imported : []), e.id].slice(-MAX_IMPORTED);
    if (!title) continue;
    const at = now + added;
    const t = { id: e.id, title, detail: str(e.detail, 8000), space: where.sp.id, spaceName: where.sp.name, column: e.column === "doing" ? "doing" : "todo", created: at, order: at, source: "terminal" };
    if (MODELS.includes(e.model)) t.model = e.model;
    if (EFFORTS.includes(e.effort)) t.effort = e.effort;
    if (e.priority === "tinggi" || e.priority === "rendah") t.priority = e.priority;
    if (Number.isInteger(e.limitMin) && e.limitMin > 0 && e.limitMin <= 1440) { t.limitMin = e.limitMin; if (e.limitStop === true) t.limitStop = true; }
    const missed = where.missed ? ` (space "${str(e.spaceName, 60)}" gak ada, masuk ke ${where.sp.name})` : "";
    if (t.column === "doing") { t.startedAt = at; t.note = `Dari terminal, nunggu dikirim ke agent…${missed}`; }
    else t.note = `Ditambah dari terminal${missed}`;
    d.tasks.push(t);
    added++;
  }
  return added;
}

// Perubahan satu task dari `a` ke `b`: kunci yang diisi/diubah dan kunci yang dibuang. null kalau sama.
export function patchOf(a, b) {
  const set = {}, del = [];
  for (const k of Object.keys(b)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) set[k] = b[k];
  for (const k of Object.keys(a)) if (!(k in b)) del.push(k);
  return Object.keys(set).length || del.length ? { set, del } : null;
}

// Terapkan perubahan mesin ke isi file yang lebih baru (yang barusan ditulis dialog kanban).
// Task yang dihapus, dipindah kolom, atau diulang sejak mesin membacanya dilewati: pilihan kamu menang.
// Perubahan lain dari dialog (prioritas, urutan, STOP) tetap ada, karena cuma kunci yang diubah mesin yang ditimpa.
// Task baru dari mesin (dari terminal) ditambahkan kalau belum ada, dan daftar `imported` digabung.
export function mergeInto(fresh, patches, added = [], imported = null) {
  if (!Array.isArray(fresh.tasks)) fresh.tasks = [];
  for (const { id, before, patch } of patches) {
    const cur = fresh.tasks.find((x) => x.id === id);
    if (!cur || cur.column !== before.column || cur.startedAt !== before.startedAt) continue;
    for (const k of patch.del) delete cur[k];
    Object.assign(cur, patch.set);
  }
  for (const t of added) if (!fresh.tasks.some((x) => x.id === t.id)) fresh.tasks.push(t);
  if (Array.isArray(imported) && imported.length) {
    fresh.imported = [...new Set([...(Array.isArray(fresh.imported) ? fresh.imported : []), ...imported])].slice(-MAX_IMPORTED);
  }
  return fresh;
}

const parse = (r) => { try { return r ? JSON.parse(r) : null; } catch { return null; } };
const readJson = async (path) => parse(await readTextFile(path).catch(() => null));

export class KanbanEngine {
  constructor() { this.busy = false; this.counts = { todo: 0, doing: 0, failed: 0, asking: 0, held: 0 }; this.reads = new Map(); }

  // Isi file state (JSON), dibaca ulang paling cepat tiap `maxAge` ms. 0 = selalu baca.
  async state(rel, maxAge = 0) {
    const c = this.reads.get(rel), now = Date.now();
    if (maxAge && c && now - c.at < maxAge) return c.value;
    const value = parse(await readState(rel, maxAge).catch(() => null));
    this.reads.set(rel, { at: now, value });
    if (this.reads.size > 200) this.reads.delete(this.reads.keys().next().value);
    return value;
  }

  async tick() {
    if (this.busy) return false;
    this.busy = true;
    try {
      const raw = await readTextFile(file()).catch(() => null);
      let d;
      if (raw) { try { d = JSON.parse(raw); } catch { return false; } } // file rusak: jangan ditimpa
      else d = { tasks: [] }; // belum ada papan: bisa jadi dibuat kalau ada task dari terminal
      if (!Array.isArray(d.tasks)) return false;
      const before = new Map(raw ? JSON.parse(raw).tasks.map((t) => [t?.id, t]) : []); // salinan buat tahu apa yang diubah mesin
      const importedBefore = JSON.stringify(d.imported ?? []);
      const now = Date.now(), ag = agents(), name = staffName;
      const byId = new Map(d.tasks.map((t) => [t.id, t]));
      const hold = usageHold(await this.state(USAGE, 20000), now);
      // staf yang lagi dipakai: task jalan yang sudah pegang staf, atau yang masih nunggu model/effort-nya dikembalikan
      const claimed = new Set(d.tasks.filter((t) => t.agent && ((t.column === "doing" && !t.failed) || t.restore?.length)).map((t) => t.agent));
      let changed = false;
      const note = (t, n) => { if (t.note !== n) { t.note = n; changed = true; } };
      const fail = (t, why) => {
        t.failed = why; t.failedAt = now; note(t, why); changed = true;
        try { notify({ title: "Task gagal", body: `${t.title}: ${why}`, level: "error", timeout: 15000 }); } catch {}
      };
      const missed = (t, why) => { t.tries = (t.tries ?? 0) + 1; changed = true; if (t.tries >= MAX_TRIES) fail(t, `${why} (${MAX_TRIES}x)`); else note(t, `${why}, nyoba lagi…`); };
      // biaya/token task = angka sesi staf sekarang dikurangi angka waktu task dikirim (sesi baru = mulai dari 0)
      const trackMeter = (t) => {
        if (!t.agent || t.costStart == null) return;
        const m = meterOf(t.agent);
        if (m.cost != null) { const c = Math.round((m.cost >= t.costStart ? m.cost - t.costStart : m.cost) * 10000) / 10000; if (t.cost !== c) { t.cost = c; changed = true; } }
        if (m.tok != null) { const k = Math.round(m.tok >= (t.tokStart ?? 0) ? m.tok - (t.tokStart ?? 0) : m.tok); if (t.tokens !== k) { t.tokens = k; changed = true; } }
      };
      const stopTask = async (t, a, why) => {
        // staf yang lagi nunggu jawaban gak ditekan tombol stop-nya: bisa menghapus jawaban yang lagi kamu ketik
        if (a && t.sentAt && !t.asking) await hc(["interrupt", a.address]).catch(() => null);
        t.failed = why; t.stopped = true; t.failedAt = now; delete t.asking; delete t.held; changed = true;
        note(t, a ? `${why}, ${name(a)} disuruh berhenti` : why);
        const back = backOf(t);
        if (a && back.length) t.restore = back;
      };

      for (const t of d.tasks.filter((x) => x.column === "doing" && !x.failed).sort(sortTasks)) {
        if (t.stopWanted) {
          // diminta berhenti dari tombol STOP: tekan tombol stop agent kalau task-nya udah dikirim
          delete t.stopWanted;
          await stopTask(t, t.agent ? ag.find((x) => x.address === t.agent) : null, "Dihentikan");
          continue;
        }
        if (!t.sentAt) {
          if (t.after) {
            const dep = byId.get(t.after);
            // `resultWanted`: hasilnya belum dibaca, bisa jadi ternyata pertanyaan (lalu balik ke kolom jalan)
            if (dep && (dep.column !== "done" || dep.resultWanted)) {
              note(t, dep.failed ? `Nunggu "${dep.title.slice(0, 30)}" (${dep.stopped ? "dihentikan" : "gagal"}, ulangi dulu)`
                : dep.asking ? `Nunggu "${dep.title.slice(0, 30)}" (stafnya nanya balik)` : `Nunggu "${dep.title.slice(0, 30)}" kelar dulu`);
              continue;
            }
          }
          const want = t.target ? ag.find((a) => a.address === t.target && a.space === t.space) : null;
          if (t.target && !want) { delete t.target; delete t.targetName; note(t, "Staf pilihan udah ilang, pindah ke otomatis"); changed = true; }
          const ok = (a) => a.space === t.space && !claimed.has(a.address) && isFree(a);
          const staged = t.agent ? ag.find((a) => a.address === t.agent) : null;
          const free = staged ? (isFree(staged) ? staged : null) : want ? (ok(want) ? want : null) : t.target ? null : ag.find(ok);
          const newTab = !free && !staged && !want && !ag.some((a) => a.space === t.space);
          // usage Claude hampir habis: jangan kirim dulu (kecuali kamu klik KIRIM AJA di kartunya)
          if (hold && !t.noHold && (free ? isClaude(free) : newTab)) {
            if (!t.held) {
              t.held = true; changed = true;
              try { notify({ title: "Task ditahan", body: `${t.title}: usage ${hold.label} ${hold.used}%, dikirim setelah reset ${fmtClock(hold.resets, now)}`, level: "warning", timeout: 15000 }); } catch {}
            }
            note(t, `Ditahan: usage ${hold.label} ${hold.used}%, dikirim setelah reset ${fmtClock(hold.resets, now)}`);
            continue;
          }
          // staf yang balasan terakhirnya pertanyaan (mis. dari obrolanmu sendiri): task antrean jangan sampai jadi jawabannya
          if (free && isClaude(free) && !t.noHold && !t.preIdx) {
            const j = await this.state(lastOf(free.address), 10000);
            const born = terminals().find((x) => x.address === free.address)?.created_ms ?? 0; // nomor terminal bisa dipakai ulang
            if (j?.text && j.at * 1000 >= born && asksBack(j.text)) {
              if (!t.held) { t.held = true; changed = true; }
              note(t, `Ditahan: ${name(free)} lagi nanya. Jawab dulu, atau klik KIRIM AJA`);
              continue;
            }
          }
          if (t.held) { delete t.held; changed = true; }
          const pre = [t.model && `/model ${t.model}`, t.effort && `/effort ${t.effort}`].filter(Boolean);
          if (free && isClaude(free) && (t.preIdx ?? 0) < pre.length) {
            if (!t.prevSaved) {
              // catat setelan staf sebelum diubah, buat dikembalikan setelah task kelar
              const L = labelsOf(free.address), pm = modelAlias(L["agent.model"] ?? L["claude.model"]), pe = L["agent.effort"] ?? L["claude.effort"];
              if (t.model && pm && pm !== t.model) t.prevModel = pm;
              if (t.effort && pe && pe !== t.effort) t.prevEffort = pe;
              t.prevSaved = true; changed = true;
            }
            const cmd = pre[t.preIdx ?? 0];
            const r = await hc(["send", free.address, cmd]).catch(() => null);
            if (r && r.code === 0) { t.preIdx = (t.preIdx ?? 0) + 1; t.agent = free.address; t.tries = 0; claimed.add(free.address); note(t, `${name(free)}: ${cmd}`); changed = true; }
            else missed(t, "Gagal atur model/effort");
          } else if (free) {
            const m = meterOf(free.address);
            const r = await hc(["send", free.address, textOf(t)]).catch(() => null);
            if (r && r.code === 0) {
              t.agent = free.address; t.sentAt = now; t.seen = false; t.tries = 0; t.costStart = m.cost ?? 0; t.tokStart = m.tok ?? 0;
              claimed.add(free.address); note(t, `Dikirim ke ${name(free)}`); changed = true;
            } else missed(t, "Gagal kirim");
          } else if (staged) note(t, `Nunggu ${name(staged)} kosong…`);
          else if (want) note(t, `Nunggu ${name(want)} kosong…`);
          else if (newTab) {
            run("tab.new", { space: t.space, name: t.title.slice(0, 40), argv: newAgentArgv(t), task: textOf(t) });
            t.sentAt = now; t.byTab = t.title.slice(0, 40); note(t, "Buka agent Claude baru"); changed = true;
          } else note(t, "Nunggu staf di space ini kosong…");
          continue;
        }
        const a = t.agent ? ag.find((x) => x.address === t.agent) : ag.find((x) => x.space === t.space && x.tab_name === t.byTab);
        if (a && !t.agent) { t.agent = a.address; t.costStart = 0; t.tokStart = 0; claimed.add(a.address); changed = true; } // sesi baru: mulai dari 0
        if (!a) {
          if (t.seen) fail(t, "Staf ilang sebelum kelar");
          else if (now - t.sentAt > 60000) fail(t, t.byTab ? "Agent baru gak muncul" : "Staf ilang");
          continue;
        }
        trackMeter(t);
        if (t.asking) {
          // staf nanya balik: tunggu sampai dia kerja lagi (kamu udah jawab), atau udah ada balasan yang lebih baru
          // (jawaban yang dikerjakan kilat, di antara dua putaran mesin). Waktu nunggu ini gak dihitung ke batas waktu.
          const j = a.status === "working" ? null : await this.state(lastOf(a.address), 10000);
          if (a.status === "working" || (j?.at && j.at > (t.resultAt ?? 0))) {
            delete t.asking; t.askedMs = (t.askedMs ?? 0) + Math.max(0, now - (t.askingSince ?? now)); delete t.askingSince; changed = true;
          } else { note(t, `${name(a)} nanya balik, nunggu jawaban kamu`); continue; }
        }
        if (t.limitMin && !t.overdue && now - t.sentAt - (t.askedMs ?? 0) > t.limitMin * 60000) {
          t.overdue = true; changed = true;
          if (t.limitStop) {
            await stopTask(t, a, `Dihentikan: lewat batas ${t.limitMin} mnt`);
            try { notify({ title: "Task dihentikan", body: `${t.title} lewat batas ${t.limitMin} mnt`, level: "warning", timeout: 15000 }); } catch {}
            continue;
          }
          try { notify({ title: "Task lewat batas waktu", body: `${t.title} udah jalan ${fmtDur(now - t.sentAt - (t.askedMs ?? 0))} (batas ${t.limitMin} mnt)`, level: "warning", timeout: 15000 }); } catch {}
        }
        if (a.status === "working") { if (!t.seen) { t.seen = true; changed = true; } note(t, `${name(a)} lagi ngerjain…`); }
        else if (a.status === "blocked") note(t, `${name(a)} nunggu jawaban kamu`);
        else if (t.seen || now - t.sentAt > 120000) {
          // notifikasi "kelar" nunggu hasilnya dibaca: kalau ternyata pertanyaan, yang muncul "nanya balik"
          t.column = "done"; t.finishedAt = now; t.resultWanted = true; t.notifyDone = true; note(t, `Kelar oleh ${name(a)}`); changed = true;
          const back = backOf(t);
          if (back.length) t.restore = back;
        }
      }

      for (const t of d.tasks) {
        // hasil kerja: pesan terakhir agent, ditulis hook Stop ke ~/.local/state/pixel-hq/last/<terminal>.json
        if (t.resultWanted && t.agent) {
          trackMeter(t);
          const j = await this.state(lastOf(t.agent));
          const fresh = j?.text && (t.resultAt != null ? j.at > t.resultAt : j.at * 1000 >= (t.sentAt ?? 0) - 5000);
          if (fresh) {
            t.result = String(j.text).slice(0, 4000); t.resultAt = j.at; delete t.resultWanted; changed = true;
            const text = t.result.trim();
            if (AGENT_ERROR.test(text)) { delete t.notifyDone; t.column = "doing"; fail(t, `Agent error: ${text.split("\n")[0].slice(0, 80)}`); }
            else if (asksBack(text)) {
              delete t.notifyDone; delete t.finishedAt; t.column = "doing"; t.asking = true; t.askingSince = now;
              const a = ag.find((x) => x.address === t.agent);
              note(t, `${a ? name(a) : "Staf"} nanya balik, nunggu jawaban kamu`);
              try { notify({ title: "Staf nanya balik", body: `${t.title}: ${lastLine(text).slice(0, 140)}`, level: "warning", timeout: 20000, action: { name: "mod.open", args: { name: "company-kanban" } } }); } catch {}
            }
          } else if (now - (t.finishedAt ?? now) > 60000) { delete t.resultWanted; changed = true; }
        }
        if (t.notifyDone && !t.resultWanted) {
          delete t.notifyDone; changed = true;
          if (t.column === "done") {
            const cost = typeof t.cost === "number" && t.cost > 0 ? ` · $${t.cost.toFixed(2)}` : "";
            try { notify({ title: "Task kelar", body: `${t.title} · ${fmtDur((t.finishedAt ?? now) - (t.sentAt ?? now))}${cost}`, level: "info" }); } catch {}
          }
        }
        // kembalikan model/effort staf, satu perintah per putaran, hanya saat stafnya nganggur (dan gak lagi nunggu jawaban)
        if (t.restore?.length && !t.asking) {
          const a = t.agent ? ag.find((x) => x.address === t.agent) : null;
          if (!a) { delete t.restore; changed = true; }
          else if (isFree(a) && !d.tasks.some((o) => o !== t && o.agent === a.address && o.column === "doing" && !o.failed && o.sentAt)) {
            const r = await hc(["send", a.address, t.restore[0]]).catch(() => null);
            if (r && r.code === 0) { t.restore.shift(); if (!t.restore.length) { delete t.restore; delete t.prevModel; delete t.prevEffort; } changed = true; }
          }
        }
      }

      // task dari terminal: diambil sesudah putaran kirim, jadi baru dikirim di putaran berikutnya (setelah tersimpan)
      const inbox = await readJson(inboxFile());
      if (inbox) {
        let sps = [], pns = [];
        try { sps = spaces(); pns = panes(); } catch {}
        if (importInbox(d, Array.isArray(inbox) ? inbox : inbox.tasks, sps, pns, now) || JSON.stringify(d.imported ?? []) !== importedBefore) changed = true;
      }

      this.counts = {
        todo: d.tasks.filter((x) => x.column === "todo").length,
        doing: d.tasks.filter((x) => x.column === "doing" && !x.failed).length,
        failed: d.tasks.filter((x) => x.failed && !x.stopped).length,
        asking: d.tasks.filter((x) => x.asking && !x.failed).length,
        held: d.tasks.filter((x) => x.held && !x.failed).length,
      };
      if (changed) await this.save(raw, d, before);
      return changed;
    } finally { this.busy = false; }
  }

  // Simpan hasil satu putaran. Kalau file udah diubah dialog kanban sejak dibaca (writeTextFile menolak),
  // baca ulang dan terapkan lagi perubahan mesin di atasnya. Dulu perubahan itu dibuang, jadi task yang barusan
  // dikirim (hc send) kehilangan tanda `sentAt` dan dikirim lagi di putaran berikutnya.
  async save(raw, d, before) {
    const patches = [], added = d.tasks.filter((t) => !before.has(t.id));
    for (const t of d.tasks) {
      const b = before.get(t.id), patch = b && patchOf(b, t);
      if (patch) patches.push({ id: t.id, before: b, patch });
    }
    let text = JSON.stringify(d, null, 2), expected = raw ?? null;
    for (let i = 0; i < 5; i++) {
      try { await writeTextFile(file(), text, expected); return true; } catch {}
      expected = await readTextFile(file()).catch(() => null);
      let fresh = null; try { fresh = expected ? JSON.parse(expected) : { tasks: [] }; } catch {}
      if (!fresh || typeof fresh !== "object") return false;
      text = JSON.stringify(mergeInto(fresh, patches, added, d.imported), null, 2);
    }
    return false;
  }
}
