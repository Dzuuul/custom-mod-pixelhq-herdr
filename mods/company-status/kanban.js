// Mesin kanban: tiap beberapa detik cek task yang ada di kolom "doing".
// Belum terkirim -> kirim ke agent yang nganggur di space-nya (hc send), atau buka agent baru kalau space itu belum punya.
// Sudah terkirim -> pantau; kalau agent-nya balik idle/done, task pindah ke "selesai".
// Tambahan: urutan prioritas, task yang nunggu task lain, batas waktu, status gagal, hasil kerja dari hook Stop
// (claude-activity.py), dan model/effort staf dikembalikan ke setelan sebelumnya setelah task kelar.
// Tombol STOP di kartu cuma menandai `stopWanted`; mesin ini yang menekan tombol stop agent (hc interrupt),
// supaya gak balapan dengan pengecekan "staf udah nganggur = task kelar".
import { agents, terminals, shared, hc, run, appHome, home, readTextFile, writeTextFile, notify } from "herdr";

const file = () => `${appHome()}/pixel-hq-kanban.json`;
const lastFile = (addr) => `${home()}/.local/state/pixel-hq/last/${addr}.json`;
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
const ALIASES = ["opus", "sonnet", "haiku", "fable"];
// Label agent.model berisi nama tampilan ("Opus 5.5"); /model butuh alias ("opus").
const modelAlias = (display) => { const w = String(display ?? "").trim().toLowerCase().split(/\s+/)[0]; return ALIASES.includes(w) ? w : null; };
const labelsOf = (addr) => { try { return terminals().find((x) => x.address === addr)?.labels ?? {}; } catch { return {}; } };
const isFree = (a) => a.status === "idle" || a.status === "done";
// Jawaban yang jelas-jelas error dari Claude Code, bukan hasil kerja.
const AGENT_ERROR = /^(API Error|Claude AI usage limit reached|.*usage limit reached)/i;
// Perintah buat ngembaliin model/effort staf ke setelan sebelum task.
const backOf = (t) => [t.prevModel && `/model ${t.prevModel}`, t.prevEffort && `/effort ${t.prevEffort}`].filter(Boolean);
// Agent baru buat space yang belum punya staf: model/effort langsung lewat argumen claude (--model, --effort).
export const newAgentArgv = (t) => ["claude", ...(t.model ? ["--model", t.model] : []), ...(t.effort ? ["--effort", t.effort] : [])];

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
export function mergeInto(fresh, patches) {
  for (const { id, before, patch } of patches) {
    const cur = fresh.tasks.find((x) => x.id === id);
    if (!cur || cur.column !== before.column || cur.startedAt !== before.startedAt) continue;
    for (const k of patch.del) delete cur[k];
    Object.assign(cur, patch.set);
  }
  return fresh;
}

export class KanbanEngine {
  constructor() { this.busy = false; this.counts = { todo: 0, doing: 0, failed: 0 }; }

  async tick() {
    if (this.busy) return false;
    this.busy = true;
    try {
      const raw = await readTextFile(file()).catch(() => null);
      if (!raw) return false;
      let d; try { d = JSON.parse(raw); } catch { return false; }
      if (!Array.isArray(d.tasks)) return false;
      const before = new Map(JSON.parse(raw).tasks.map((t) => [t?.id, t])); // salinan buat tahu apa yang diubah mesin
      const now = Date.now(), ag = agents(), name = staffName;
      const byId = new Map(d.tasks.map((t) => [t.id, t]));
      // staf yang lagi dipakai: task jalan yang sudah pegang staf, atau yang masih nunggu model/effort-nya dikembalikan
      const claimed = new Set(d.tasks.filter((t) => t.agent && ((t.column === "doing" && !t.failed) || t.restore?.length)).map((t) => t.agent));
      let changed = false;
      const note = (t, n) => { if (t.note !== n) { t.note = n; changed = true; } };
      const fail = (t, why) => {
        t.failed = why; t.failedAt = now; note(t, why); changed = true;
        try { notify({ title: "Task gagal", body: `${t.title}: ${why}`, level: "error", timeout: 15000 }); } catch {}
      };
      const missed = (t, why) => { t.tries = (t.tries ?? 0) + 1; changed = true; if (t.tries >= MAX_TRIES) fail(t, `${why} (${MAX_TRIES}x)`); else note(t, `${why}, nyoba lagi…`); };

      for (const t of d.tasks.filter((x) => x.column === "doing" && !x.failed).sort(sortTasks)) {
        if (t.stopWanted) {
          // diminta berhenti dari tombol STOP: tekan tombol stop agent kalau task-nya udah dikirim
          delete t.stopWanted;
          const a = t.agent ? ag.find((x) => x.address === t.agent) : null;
          if (a && t.sentAt) await hc(["interrupt", a.address]).catch(() => null);
          t.failed = "Dihentikan"; t.stopped = true; t.failedAt = now; changed = true;
          note(t, a ? `Dihentikan, ${name(a)} disuruh berhenti` : "Dihentikan");
          const back = backOf(t);
          if (a && back.length) t.restore = back;
          continue;
        }
        if (!t.sentAt) {
          if (t.after) {
            const dep = byId.get(t.after);
            if (dep && dep.column !== "done") { note(t, dep.failed ? `Nunggu "${dep.title.slice(0, 30)}" (${dep.stopped ? "dihentikan" : "gagal"}, ulangi dulu)` : `Nunggu "${dep.title.slice(0, 30)}" kelar dulu`); continue; }
          }
          const want = t.target ? ag.find((a) => a.address === t.target && a.space === t.space) : null;
          if (t.target && !want) { delete t.target; delete t.targetName; note(t, "Staf pilihan udah ilang, pindah ke otomatis"); changed = true; }
          const ok = (a) => a.space === t.space && !claimed.has(a.address) && isFree(a);
          const staged = t.agent ? ag.find((a) => a.address === t.agent) : null;
          const free = staged ? (isFree(staged) ? staged : null) : want ? (ok(want) ? want : null) : t.target ? null : ag.find(ok);
          const pre = [t.model && `/model ${t.model}`, t.effort && `/effort ${t.effort}`].filter(Boolean);
          const isClaude = (a) => /claude/i.test(`${a.app ?? ""} ${a.program?.name ?? ""}`);
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
            const r = await hc(["send", free.address, textOf(t)]).catch(() => null);
            if (r && r.code === 0) { t.agent = free.address; t.sentAt = now; t.seen = false; t.tries = 0; claimed.add(free.address); note(t, `Dikirim ke ${name(free)}`); changed = true; }
            else missed(t, "Gagal kirim");
          } else if (staged) note(t, `Nunggu ${name(staged)} kosong…`);
          else if (want) note(t, `Nunggu ${name(want)} kosong…`);
          else if (!ag.some((a) => a.space === t.space)) {
            run("tab.new", { space: t.space, name: t.title.slice(0, 40), argv: newAgentArgv(t), task: textOf(t) });
            t.sentAt = now; t.byTab = t.title.slice(0, 40); note(t, "Buka agent Claude baru"); changed = true;
          } else note(t, "Nunggu staf di space ini kosong…");
          continue;
        }
        const a = t.agent ? ag.find((x) => x.address === t.agent) : ag.find((x) => x.space === t.space && x.tab_name === t.byTab);
        if (a && !t.agent) { t.agent = a.address; claimed.add(a.address); changed = true; }
        if (!a) {
          if (t.seen) fail(t, "Staf ilang sebelum kelar");
          else if (now - t.sentAt > 60000) fail(t, t.byTab ? "Agent baru gak muncul" : "Staf ilang");
          continue;
        }
        if (t.limitMin && !t.overdue && now - t.sentAt > t.limitMin * 60000) {
          t.overdue = true; changed = true;
          try { notify({ title: "Task lewat batas waktu", body: `${t.title} udah jalan ${fmtDur(now - t.sentAt)} (batas ${t.limitMin} mnt)`, level: "warning", timeout: 15000 }); } catch {}
        }
        if (a.status === "working") { if (!t.seen) { t.seen = true; changed = true; } note(t, `${name(a)} lagi ngerjain…`); }
        else if (a.status === "blocked") note(t, `${name(a)} nunggu jawaban kamu`);
        else if (t.seen || now - t.sentAt > 120000) {
          t.column = "done"; t.finishedAt = now; t.resultWanted = true; note(t, `Kelar oleh ${name(a)}`); changed = true;
          const back = backOf(t);
          if (back.length) t.restore = back;
          try { notify({ title: "Task kelar", body: `${t.title} · ${fmtDur(now - t.sentAt)}`, level: "info" }); } catch {}
        }
      }

      for (const t of d.tasks) {
        // hasil kerja: pesan terakhir agent, ditulis hook Stop ke ~/.local/state/pixel-hq/last/<terminal>.json
        if (t.resultWanted && t.agent) {
          const r = await readTextFile(lastFile(t.agent)).catch(() => null);
          let j = null; try { j = r ? JSON.parse(r) : null; } catch {}
          if (j?.text && j.at * 1000 >= (t.sentAt ?? 0) - 5000) {
            t.result = String(j.text).slice(0, 4000); delete t.resultWanted; changed = true;
            if (AGENT_ERROR.test(t.result.trim())) { t.column = "doing"; fail(t, `Agent error: ${t.result.trim().split("\n")[0].slice(0, 80)}`); }
          } else if (now - (t.finishedAt ?? now) > 60000) { delete t.resultWanted; changed = true; }
        }
        // kembalikan model/effort staf, satu perintah per putaran, hanya saat stafnya nganggur
        if (t.restore?.length) {
          const a = t.agent ? ag.find((x) => x.address === t.agent) : null;
          if (!a) { delete t.restore; changed = true; }
          else if (isFree(a) && !d.tasks.some((o) => o !== t && o.agent === a.address && o.column === "doing" && !o.failed && o.sentAt)) {
            const r = await hc(["send", a.address, t.restore[0]]).catch(() => null);
            if (r && r.code === 0) { t.restore.shift(); if (!t.restore.length) { delete t.restore; delete t.prevModel; delete t.prevEffort; } changed = true; }
          }
        }
      }

      this.counts = {
        todo: d.tasks.filter((x) => x.column === "todo").length,
        doing: d.tasks.filter((x) => x.column === "doing" && !x.failed).length,
        failed: d.tasks.filter((x) => x.failed && !x.stopped).length,
      };
      if (changed) await this.save(raw, d, before);
      return changed;
    } finally { this.busy = false; }
  }

  // Simpan hasil satu putaran. Kalau file udah diubah dialog kanban sejak dibaca (writeTextFile menolak),
  // baca ulang dan terapkan lagi perubahan mesin di atasnya. Dulu perubahan itu dibuang, jadi task yang barusan
  // dikirim (hc send) kehilangan tanda `sentAt` dan dikirim lagi di putaran berikutnya.
  async save(raw, d, before) {
    const patches = [];
    for (const t of d.tasks) {
      const b = before.get(t.id), patch = b && patchOf(b, t);
      if (patch) patches.push({ id: t.id, before: b, patch });
    }
    let text = JSON.stringify(d, null, 2), expected = raw;
    for (let i = 0; i < 5; i++) {
      try { await writeTextFile(file(), text, expected); return true; } catch {}
      expected = await readTextFile(file()).catch(() => null);
      let fresh = null; try { fresh = expected ? JSON.parse(expected) : null; } catch {}
      if (!Array.isArray(fresh?.tasks)) return false;
      text = JSON.stringify(mergeInto(fresh, patches), null, 2);
    }
    return false;
  }
}
