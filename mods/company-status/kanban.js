// Mesin kanban: tiap beberapa detik cek task yang ada di kolom "doing".
// Belum terkirim -> kirim ke agent yang nganggur di space-nya (hc send), atau buka agent baru kalau space itu belum punya.
// Sudah terkirim -> pantau; kalau agent-nya balik idle/done, task pindah ke "selesai".
import { agents, hc, run, appHome, readTextFile, writeTextFile, notify } from "herdr";

const file = () => `${appHome()}/pixel-hq-kanban.json`;
const staffName = (a) => {
  const tab = (a.tab_name ?? "").trim();
  if (tab && !/^\d+$/.test(tab)) return tab;
  const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
  return a.pane_name || clean(a.title) || a.program?.name || a.address;
};
const textOf = (t) => (t.detail ? `${t.title}\n\n${t.detail}` : t.title);

export class KanbanEngine {
  constructor() { this.busy = false; this.counts = { todo: 0, doing: 0 }; }

  async tick() {
    if (this.busy) return false;
    this.busy = true;
    try {
      const raw = await readTextFile(file()).catch(() => null);
      if (!raw) return false;
      let d; try { d = JSON.parse(raw); } catch { return false; }
      if (!Array.isArray(d.tasks)) return false;
      const now = Date.now(), ag = agents(), name = staffName;
      const claimed = new Set(d.tasks.filter((t) => t.column === "doing" && t.agent).map((t) => t.agent));
      let changed = false;
      const note = (t, n) => { if (t.note !== n) { t.note = n; changed = true; } };
      for (const t of d.tasks.filter((x) => x.column === "doing")) {
        if (!t.sentAt) {
          const want = t.target ? ag.find((a) => a.address === t.target && a.space === t.space) : null;
          if (t.target && !want) { delete t.target; delete t.targetName; note(t, "Staf pilihan udah ilang, pindah ke otomatis"); changed = true; }
          const ok = (a) => a.space === t.space && !claimed.has(a.address) && (a.status === "idle" || a.status === "done");
          const staged = t.agent ? ag.find((a) => a.address === t.agent) : null;
          const free = staged ? ((staged.status === "idle" || staged.status === "done") ? staged : null) : want ? (ok(want) ? want : null) : t.target ? null : ag.find(ok);
          const pre = [t.model && `/model ${t.model}`, t.effort && `/effort ${t.effort}`].filter(Boolean);
          const isClaude = (a) => /claude/i.test(`${a.app ?? ""} ${a.program?.name ?? ""}`);
          if (free && isClaude(free) && (t.preIdx ?? 0) < pre.length) {
            const cmd = pre[t.preIdx ?? 0];
            const r = await hc(["send", free.address, cmd]).catch(() => null);
            if (r && r.code === 0) { t.preIdx = (t.preIdx ?? 0) + 1; t.agent = free.address; claimed.add(free.address); note(t, `${name(free)}: ${cmd}`); changed = true; }
            else note(t, "Gagal atur model/effort, nyoba lagi…");
          } else if (free) {
            const r = await hc(["send", free.address, textOf(t)]).catch(() => null);
            if (r && r.code === 0) { t.agent = free.address; t.sentAt = now; t.seen = false; claimed.add(free.address); note(t, `Dikirim ke ${name(free)}`); changed = true; }
            else note(t, "Gagal kirim, nyoba lagi…");
          } else if (staged) note(t, `Nunggu ${name(staged)} kosong…`);
          else if (want) note(t, `Nunggu ${name(want)} kosong…`);
          else if (!ag.some((a) => a.space === t.space)) {
            run("tab.new", { space: t.space, name: t.title.slice(0, 40), argv: ["claude"], task: textOf(t) });
            t.sentAt = now; t.byTab = t.title.slice(0, 40); note(t, "Buka agent Claude baru"); changed = true;
          } else note(t, "Nunggu staf di space ini kosong…");
          continue;
        }
        const a = t.agent ? ag.find((x) => x.address === t.agent) : ag.find((x) => x.space === t.space && x.tab_name === t.byTab);
        if (a && !t.agent) { t.agent = a.address; claimed.add(a.address); changed = true; }
        if (!a) {
          if (now - t.sentAt > 30000) { t.column = "done"; t.finishedAt = now; note(t, "Staf udah ilang, dianggap kelar"); changed = true; }
          continue;
        }
        if (a.status === "working") { if (!t.seen) { t.seen = true; changed = true; } note(t, `${name(a)} lagi ngerjain…`); }
        else if (a.status === "blocked") note(t, `${name(a)} nunggu jawaban kamu`);
        else if (t.seen || now - t.sentAt > 120000) {
          t.column = "done"; t.finishedAt = now; note(t, `Kelar oleh ${name(a)}`); changed = true;
          try { notify({ title: "Task kelar", body: t.title, level: "info" }); } catch {}
        }
      }
      this.counts = { todo: d.tasks.filter((x) => x.column === "todo").length, doing: d.tasks.filter((x) => x.column === "doing").length };
      if (changed) await writeTextFile(file(), JSON.stringify(d, null, 2), raw).catch(() => {});
      return changed;
    } finally { this.busy = false; }
  }
}
