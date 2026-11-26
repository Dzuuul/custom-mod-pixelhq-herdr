// Mesin kanban: tiap beberapa detik cek task yang ada di kolom "doing".
// Belum terkirim -> kirim ke agent yang nganggur di space-nya (hc send), atau buka agent baru kalau space itu belum punya.
// Sudah terkirim -> pantau; kalau agent-nya balik idle/done, task pindah ke "selesai".
// Tambahan: urutan prioritas, task yang nunggu task lain, batas waktu (bisa sekalian menghentikan), status gagal,
// hasil kerja dari hook Stop (claude-activity.py), dan model/effort staf dikembalikan ke setelan sebelumnya.
// Tombol STOP di kartu cuma menandai `stopWanted`; mesin ini yang menekan tombol stop agent (hc interrupt),
// supaya gak balapan dengan pengecekan "staf udah nganggur = task kelar".
// Juga: task ditahan kalau usage Claude hampir habis, balasan yang berupa pertanyaan bikin kartu nunggu jawaban,
// biaya/token per task dari label statusline, dan task dari terminal (pixel-hq-task) lewat pixel-hq-kanban-inbox.json.
// Versi 2.3: CEK otomatis setelah agent berhenti (gagal = agent disuruh benerin), batas biaya, bawa hasil task
// sebelumnya, jadwal (jam mulai, tiap hari, hari kerja), worktree per task dan ringkasan diff, HASIL dari layar buat
// agent selain Claude, space di mesin lain (hc machine), notifikasi ke HP, dan riwayat buat rekap di dialog Usage.
import { agents, terminals, spaces, panes, shared, setShared, hc, run, exec, window, appHome, readTextFile, writeTextFile, notify } from "herdr";
import { readState } from "./state.js";

const file = () => `${appHome()}/pixel-hq-kanban.json`;
// Ditulis cuma oleh pixel-hq-task (mods/company-kanban/pixel-hq-task.*); mesin ini cuma membacanya.
const inboxFile = () => `${appHome()}/pixel-hq-kanban-inbox.json`;
// Riwayat task yang udah kelar/gagal, buat rekap di dialog Usage. Cuma mesin ini yang menulisnya.
export const historyFile = () => `${appHome()}/pixel-hq-kanban-history.json`;
// File di ~/.local/state/pixel-hq (ditulis statusline dan hook Claude Code), dibaca lewat readState: di Windows
// juga dari WSL, tempat Claude Code-nya bisa jalan (cuma dari distro yang lagi jalan). Itu manggil wsl.exe, jadi
// yang dicek terus-terusan di-cache, di sini dan di state.js (dibagi dengan status bar).
const USAGE = "claude-usage.json";
// Terminal di mesin lain alamatnya "mesin/t7"; hook di mesin itu menulis pakai id terminal di sana (t7).
export const termOf = (addr) => { const s = String(addr ?? ""); return s.slice(s.lastIndexOf("/") + 1); };
const lastOf = (addr) => `last/${termOf(addr)}.json`;
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
// Pilihan exec tanpa kunci kosong (on: null = komputer ini, cwd: null = folder home).
const opts = (o) => { const x = {}; for (const [k, v] of Object.entries(o)) if (v != null && v !== "") x[k] = v; return x; };

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

// Tombol jawaban cepat buat kartu PERLU JAWABAN, dari pertanyaan agent. [] = gak ada yang jelas (kotak isian tetap ada).
//  1. pilihan bernomor/berhuruf tepat sebelum pertanyaan yang minta milih ("1. ...", "B) ...", "- **A.** ...")
//  2. "X atau Y?" / "X or Y?" (juga "A, B, atau C?") di kalimat terakhir
//  3. pertanyaan ya/gak ("Mau lanjut?", "Should I commit?")
const plain = (s) => String(s ?? "").replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
const ASK_LEAD = /^(?:(?:jadi|oke|ok|terus|nah|kalau gitu|kalau begitu|so|then)[, ]+)?(?:kamu |anda |lo |lu )?(?:mau|maunya|apakah|boleh|perlu|sebaiknya|enaknya|lebih baik|lebih suka|prefer|should i|do you want(?: me)? to|would you like(?: me)? to|would you prefer|shall i|want me to|do you prefer)\s+/i;
const PICK_LEAD = /^(?:pakai|pake|pilih|ambil|use|go with)\s+/i;
const PICKS = /pilih|yang mana|mana yang|opsi|nomor|which|option|prefer/i;
const YES_NO = /^(?:mau|apakah|boleh|perlu|lanjut|bisa|oke|setuju|should|do you|shall|want|would you|can i|may i|is it ok|is that ok|ready|siap)\b/i;
export function answerChoices(text) {
  const lines = String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const last = plain(lines[lines.length - 1]).replace(/[?？\s]+$/u, "");
  if (PICKS.test(last)) {
    const opts = [];
    for (const l of lines.slice(-13, -1)) {
      const m = /^(?:[-*•]\s+)?(?:\*\*|__)?(?:opsi |option |pilihan )?([1-9]|[A-Ea-e])(?:\*\*|__)?[.):](?:\*\*|__)?\s+(.+)$/i.exec(l);
      if (m) opts.push(`${m[1]}. ${plain(m[2])}`.slice(0, 300));
    }
    if (opts.length >= 2) return opts.slice(-5);
  }
  const sentence = last.split(/[.!:;]\s+/).pop() ?? "";
  const parts = sentence.replace(ASK_LEAD, "").split(/\s+(?:atau|or)\s+/i);
  if (parts.length >= 2 && parts.length <= 4 && parts[0]) {
    const list = parts[0].split(/,\s*/); // "A, B, atau C"
    const head = list[0].replace(PICK_LEAD, ""), words = head.split(/\s+/);
    const n = Math.max(1, Math.min(4, parts[1].split(/\s+/).length));
    const first = words.length > 6 ? words.slice(-n).join(" ") : head;
    const all = [first, ...list.slice(1), ...parts.slice(1)].map((s) => s.replace(PICK_LEAD, "").replace(/^[,\s]+|[,\s]+$/g, "")).filter(Boolean);
    if (all.length >= 2 && all.every((s) => s.length <= 60)) return all.slice(0, 5);
  }
  if (YES_NO.test(sentence)) return ["Ya, lanjut", "Gak usah"];
  return [];
}

// HASIL buat agent yang gak punya hook Stop (Codex, dll., atau Claude tanpa hook): baris terakhir layarnya (hc read).
// Garis bingkai dan baris kosong dibuang. Gak dipakai buat deteksi nanya balik/error: isinya bisa kecampur prompt.
const BORDER = /^[\s─━│┃╭╮╰╯┌┐└┘├┤┬┴┼═║╔╗╚╝▀▄█░▒▓▔▁·•=~_-]+$/u;
const SCREEN_AFTER = 20000; // Claude: tunggu hook-nya selama ini sebelum pakai layar
export function screenText(raw) {
  const lines = String(raw ?? "").replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() && !BORDER.test(l));
  return lines.slice(-40).join("\n").slice(-4000).trim();
}

// Isi yang dikirim ke agent. "Bawa hasil" (carry): hasil task yang ditunggu (SETELAH) ditempel di bawahnya.
export function promptOf(t, byId) {
  const dep = t.carry && t.after ? byId.get(t.after) : null;
  const res = String(dep?.result ?? "").trim();
  return res ? `${textOf(t)}\n\nHasil task sebelumnya ("${String(dep.title).slice(0, 80)}"):\n\n${res}` : textOf(t);
}

// CEK otomatis: perintah (mis. `npm test`) yang dijalankan di folder agent setelah dia berhenti.
// Lolos (kode 0) = kelar. Gagal = output-nya dikirim balik ke agent buat dibenerin, paling banyak CHECK_FIXES kali.
export const CHECK_FIXES = 3;
const CHECK_TIMEOUT = 600000; // 10 menit, batas exec Herdr
export const tailOf = (text, lines = 60, chars = 3000) => {
  const s = String(text ?? "").replace(/\r/g, "").split("\n").slice(-lines).join("\n").trim();
  return s.length > chars ? `…${s.slice(-chars)}` : s;
};
// Cara menjalankan perintah cek: sh di Linux/macOS dan di mesin lain; di Windows PowerShell, atau WSL kalau folder
// agent-nya jalur WSL (Claude Code jalan di WSL).
export function checkCommand(cmd, cwd, platform, machine) {
  if (machine || platform !== "windows") return { cmd: "sh", args: ["-c", cmd], cwd };
  if (cwd && cwd.startsWith("/")) return { cmd: "wsl.exe", args: ["--cd", cwd, "-e", "sh", "-c", cmd], cwd: null };
  return { cmd: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", cmd], cwd };
}
export const fixPrompt = (t, r) => `Cek otomatis \`${t.check}\` gagal (kode ${r.code}). Perbaiki sampai cek itu lolos. Output terakhirnya:\n\n\`\`\`\n${tailOf(`${r.stdout ?? ""}\n${r.stderr ?? ""}`)}\n\`\`\``;

// Jadwal: task di Antrean dengan `startAt` pindah sendiri ke "Sedang dikerjakan" waktu jamnya tiba.
// Dengan `repeat`, task itu jadi jadwal: tiap jamnya tiba, salinannya dijalankan dan jadwalnya maju ke hari berikutnya.
export const REPEATS = { harian: "tiap hari", kerja: "hari kerja" };
export function parseClock(s) {
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(String(s ?? ""));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}
// Waktu (ms) berikutnya setelah `fromMs` dengan jam `atTime` ("HH:MM", waktu lokal). Hari kerja = Senin sampai Jumat.
export function nextRun(atTime, repeat, fromMs) {
  const [h, m] = String(atTime).split(":").map(Number);
  const d = new Date(fromMs);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= fromMs) d.setDate(d.getDate() + 1);
  if (repeat === "kerja") while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0); // pergantian jam musim panas
  return d.getTime();
}
const COPY = ["title", "detail", "space", "spaceName", "model", "effort", "priority", "limitMin", "limitStop", "costMax", "check", "worktree", "target", "targetName"];
export function runCopy(t, at) {
  const c = { id: `k${at.toString(36)}${Math.random().toString(36).slice(2, 5)}`, column: "doing", created: at, order: at, startedAt: at, fromRepeat: t.id,
    note: `Dari jadwal ${REPEATS[t.repeat] ?? ""} ${t.atTime ?? ""}, nunggu dikirim…`.replace(/\s+/g, " ") };
  for (const k of COPY) if (t[k] !== undefined) c[k] = t[k];
  return c;
}

// Git: posisi repo waktu task dikirim (buat diff di kartu), dan worktree sendiri buat task yang memintanya.
const git = (cwd, args, on, timeout = 15000) => exec("git", args, opts({ cwd, on, timeout })).then((r) => (r.code === 0 ? r.stdout : null), () => null);
const countLines = (s) => String(s ?? "").split("\n").filter(Boolean).length;
export const slugOf = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 32).replace(/-+$/, "") || "task";
// Worktree buat task: <repo>/../.worktrees/<repo>-kanban-<judul>-<id>, branch kanban/<judul>-<id> dari HEAD repo
// (sama dengan worktree crew di company-agents/crew.js). Diulang = worktree yang sama dipakai lagi.
export async function makeWorktree(repoCwd, t, on) {
  const top = (await git(repoCwd, ["rev-parse", "--show-toplevel"], on))?.trim();
  if (!top) throw new Error("folder space ini bukan repo git");
  const branch = t.wtBranch ?? `kanban/${slugOf(t.title)}-${String(t.id).slice(-4)}`;
  const cut = top.lastIndexOf("/");
  const path = t.wtPath ?? `${top.slice(0, cut)}/.worktrees/${top.slice(cut + 1)}-${branch.replace(/\//g, "-")}`;
  const listed = (await git(top, ["worktree", "list", "--porcelain"], on)) ?? "";
  if (listed.split("\n").includes(`worktree ${path}`)) return { path, branch, reused: true };
  const exists = (await git(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], on)) !== null;
  const r = await exec("git", exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path], opts({ cwd: top, on, timeout: 60000 }))
    .catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
  if (r.code !== 0) throw new Error((r.stderr || "git worktree add gagal").trim().split("\n").pop());
  return { path, branch, reused: false };
}
// Titik awal diff: `git stash create` memotret perubahan yang belum di-commit jadi commit tanpa menyentuh apa pun
// (gak ada ref, working tree, atau index yang berubah), jadi diff nanti cuma berisi kerjaan task ini.
export async function gitStart(cwd, on) {
  if (!cwd) return null;
  const top = (await git(cwd, ["rev-parse", "--show-toplevel"], on))?.trim();
  if (!top) return null;
  const head = (await git(top, ["rev-parse", "HEAD"], on))?.trim();
  if (!head) return null; // repo tanpa commit
  const snap = (await git(top, ["stash", "create"], on))?.trim();
  return { top, base: snap || head, untracked: countLines(await git(top, ["ls-files", "--others", "--exclude-standard"], on)) };
}
export async function gitDiff(g, on) {
  if (!g?.top || !g.base) return null;
  const stat = await git(g.top, ["diff", "--shortstat", g.base], on);
  if (stat == null) return null;
  const n = (re) => Number((re.exec(stat) ?? [])[1] ?? 0);
  const fresh = Math.max(0, countLines(await git(g.top, ["ls-files", "--others", "--exclude-standard"], on)) - (g.untracked ?? 0));
  return { files: n(/(\d+) files? changed/), add: n(/(\d+) insertions?/), del: n(/(\d+) deletions?/), fresh };
}

// Notifikasi ke HP: shared("pixel-hq.push") = { url, mode: "away" (bawaan: cuma kalau jendela Herdr gak dilihat) | "always" }.
// Lewat curl (ada di Linux, macOS, dan Windows 10+). Format dari alamatnya: Discord, Slack, Telegram, selain itu ntfy.
export function pushArgs(url, n) {
  const u = String(url ?? "").trim(), title = String(n?.title ?? "Pixel HQ").slice(0, 200), body = String(n?.body ?? "").slice(0, 1500);
  const base = ["-fsS", "-m", "10", "-X", "POST"];
  // JSON-nya ASCII semua (\uXXXX): curl Windows yang lama membaca argumen pakai code page, huruf non-ASCII bisa rusak
  const ascii = (x) => JSON.stringify(x).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const json = (obj, to) => [...base, "-H", "Content-Type: application/json", "--data-raw", ascii(obj), to];
  if (/^https:\/\/(?:[\w-]+\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(u)) return json({ content: `**${title}**\n${body}`.slice(0, 1900) }, u);
  if (/^https:\/\/hooks\.slack\.com\//i.test(u)) return json({ text: `*${title}*\n${body}` }, u);
  const tg = /^(https:\/\/api\.telegram\.org\/bot[^/?#]+\/sendMessage)\?(?:[^#]*&)?chat_id=([^&#]+)/i.exec(u);
  if (tg) return json({ chat_id: decodeURIComponent(tg[2]), text: `${title}\n${body}` }, tg[1]);
  const tag = n?.level === "error" ? "x" : n?.level === "warning" ? "warning" : "white_check_mark";
  const sep = u.includes("?") ? "&" : "?";
  return [...base, "-H", "Content-Type: text/plain; charset=utf-8", "--data-raw", body || title,
    `${u}${sep}title=${encodeURIComponent(title)}&priority=${n?.level === "error" ? "high" : "default"}&tags=${tag}`];
}

// Riwayat (rekap): satu entri per kali jalan (id + waktu kirim), disimpan 90 hari, dijaga di bawah 1 MiB (batas readTextFile).
export const HISTORY_DAYS = 90;
const HISTORY_MAX = 2000, HISTORY_BYTES = 900000;
export function historyEntry(t, outcome, now) {
  const end = t.finishedAt ?? t.failedAt ?? now;
  const e = { id: t.id, run: t.sentAt ?? t.startedAt ?? end, at: end, title: String(t.title ?? "").slice(0, 100), space: t.spaceName ?? "", outcome };
  if (t.sentAt) e.ms = Math.max(0, end - t.sentAt - (t.askedMs ?? 0));
  if (t.agentName) e.staff = t.agentName;
  const model = t.ranModel ?? t.model;
  if (model) e.model = model;
  if (typeof t.cost === "number") e.cost = t.cost;
  if (typeof t.tokens === "number") e.tokens = t.tokens;
  if (t.check) { e.check = t.checkOk ? "lolos" : "gagal"; if (t.checkRounds) e.fixes = t.checkRounds; }
  if (t.source) e.source = t.source;
  if (t.diff) e.diff = t.diff;
  return e;
}
export function addHistory(h, entries, now) {
  const runs = Array.isArray(h?.runs) ? h.runs.filter((r) => r && typeof r === "object") : [];
  const seen = new Set(runs.map((r) => `${r.id}:${r.run}`));
  for (const e of entries) { const k = `${e.id}:${e.run}`; if (!seen.has(k)) { runs.push(e); seen.add(k); } }
  const cut = now - HISTORY_DAYS * 86400000;
  let out = runs.filter((r) => (r.at ?? 0) >= cut).slice(-HISTORY_MAX);
  while (out.length > 10 && JSON.stringify(out).length > HISTORY_BYTES) out = out.slice(Math.ceil(out.length / 10));
  return { v: 1, runs: out };
}

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
    if (Number.isInteger(e.limitMin) && e.limitMin > 0 && e.limitMin <= 1440) t.limitMin = e.limitMin;
    if (typeof e.costMax === "number" && e.costMax > 0 && e.costMax <= 1000) t.costMax = Math.round(e.costMax * 100) / 100;
    if (e.limitStop === true && (t.limitMin || t.costMax)) t.limitStop = true;
    const check = str(e.check, 500);
    if (check) t.check = check;
    if (e.worktree === true) t.worktree = true;
    const clock = parseClock(e.atTime);
    if (clock) { t.atTime = clock; if (REPEATS[e.repeat]) t.repeat = e.repeat; t.startAt = nextRun(clock, t.repeat, now); t.column = "todo"; }
    const missed = where.missed ? ` (space "${str(e.spaceName, 60)}" gak ada, masuk ke ${where.sp.name})` : "";
    if (t.column === "doing") { t.startedAt = at; t.note = `Dari terminal, nunggu dikirim ke agent…${missed}`; }
    else if (t.startAt) t.note = `Dijadwalkan dari terminal: ${t.repeat ? `${REPEATS[t.repeat]} ${t.atTime}` : fmtClock(t.startAt / 1000, now)}${missed}`;
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
// Task baru dari mesin (dari terminal, salinan jadwal) ditambahkan kalau belum ada, dan daftar `imported` digabung.
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
  constructor() {
    this.busy = false; this.counts = { todo: 0, doing: 0, failed: 0, asking: 0, held: 0, checking: 0 }; this.reads = new Map();
    this.checks = new Map(); // cek yang lagi jalan: `${id}:${sentAt}:${putaran}` -> { at, done, result }
    this.testedPush = 0;
  }

  // Isi file state (JSON), dibaca ulang paling cepat tiap `maxAge` ms. 0 = selalu baca.
  // `machine`: dari mesin lain (space di `hc machine`), lewat exec di sana.
  async state(rel, maxAge = 0, machine = null) {
    const key = `${machine ?? ""}\n${rel}`, c = this.reads.get(key), now = Date.now();
    if (maxAge && c && now - c.at < maxAge) return c.value;
    const value = parse(machine ? await this.remote(machine, rel) : await readState(rel, maxAge).catch(() => null));
    this.reads.set(key, { at: now, value });
    if (this.reads.size > 200) this.reads.delete(this.reads.keys().next().value);
    return value;
  }

  async remote(machine, rel) {
    const r = await exec("sh", ["-c", 'cat "$HOME/.local/state/pixel-hq/$1" 2>/dev/null', "sh", rel], { on: machine, timeout: 8000 }).catch(() => null);
    return r && r.code === 0 && r.stdout?.trim() ? r.stdout : null;
  }

  // Layar terminal (hc read), buat HASIL agent yang gak punya hook. "" kalau gak kebaca.
  async screen(addr) {
    const r = await hc(["read", addr, "--json", "--lines", "80"]).catch(() => null);
    if (!r || r.code !== 0 || !r.stdout) return "";
    let text = r.stdout;
    try { const j = JSON.parse(r.stdout); if (typeof j?.text === "string") text = j.text; } catch {}
    return screenText(text);
  }

  // Kirim notifikasi ke HP kalau diatur. `force`: tes dari dialog (abaikan mode, laporkan hasilnya).
  phone(n, force = false) {
    let cfg = null;
    try { cfg = shared("pixel-hq.push"); } catch {}
    const url = typeof cfg?.url === "string" ? cfg.url.trim() : "";
    if (!/^https?:\/\//i.test(url)) return null;
    if (!force && cfg.mode !== "always") {
      let w = null;
      try { w = window(); } catch {}
      if (w?.active && w.visible !== false) return null; // jendela Herdr lagi kamu lihat
    }
    return exec("curl", pushArgs(url, n), { timeout: 15000 }).then((r) => r, (e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }))
      .then((r) => {
        if (force) try { setShared("pixel-hq.push-result", { at: Date.now(), ok: r.code === 0, msg: String(r.stderr ?? "").trim().split("\n").pop().slice(0, 160) }); } catch {}
        return r;
      });
  }

  startCheck(key, t, cwd, machine) {
    const job = { at: Date.now(), done: false, result: null };
    this.checks.set(key, job);
    const c = checkCommand(t.check, cwd, window()?.platform, machine);
    exec(c.cmd, c.args, opts({ cwd: c.cwd, on: machine, timeout: CHECK_TIMEOUT }))
      .then((r) => r, (e) => ({ code: null, stdout: "", stderr: String(e?.message ?? e) }))
      .then((r) => { job.done = true; job.result = r; });
    return job;
  }

  async writeHistory(entries, now) {
    for (let i = 0; i < 3; i++) {
      const raw = await readTextFile(historyFile()).catch(() => null);
      try { await writeTextFile(historyFile(), JSON.stringify(addHistory(parse(raw), entries, now)), raw); return true; } catch {}
    }
    return false;
  }

  async tick() {
    if (this.busy) return false;
    this.busy = true;
    try {
      // tes notifikasi HP dari dialog kanban (tombol TES)
      try {
        const want = shared("pixel-hq.push-test");
        if (typeof want === "number" && want > this.testedPush && Date.now() - want < 60000) {
          this.testedPush = want;
          this.phone({ title: "Tes notifikasi Pixel HQ", body: "Kalau ini muncul di HP, notifikasi kanban udah nyambung.", level: "info" }, true);
        }
      } catch {}
      const raw = await readTextFile(file()).catch(() => null);
      let d;
      if (raw) { try { d = JSON.parse(raw); } catch { return false; } } // file rusak: jangan ditimpa
      else d = { tasks: [] }; // belum ada papan: bisa jadi dibuat kalau ada task dari terminal
      if (!Array.isArray(d.tasks)) return false;
      const before = new Map(raw ? JSON.parse(raw).tasks.map((t) => [t?.id, t]) : []); // salinan buat tahu apa yang diubah mesin
      const importedBefore = JSON.stringify(d.imported ?? []);
      const now = Date.now(), ag = agents(), name = staffName;
      let sps = [], pns = [];
      try { sps = spaces(); pns = panes(); } catch {}
      const byId = new Map(d.tasks.map((t) => [t.id, t]));
      const hold = usageHold(await this.state(USAGE, 20000), now);
      // staf yang lagi dipakai: task jalan yang sudah pegang staf, atau yang masih nunggu model/effort-nya dikembalikan
      const claimed = new Set(d.tasks.filter((t) => t.agent && ((t.column === "doing" && !t.failed) || t.restore?.length)).map((t) => t.agent));
      let changed = false;
      const note = (t, n) => { if (t.note !== n) { t.note = n; changed = true; } };
      const tell = (n) => { try { notify(n); } catch {} this.phone(n); };
      const fail = (t, why) => {
        t.failed = why; t.failedAt = now; note(t, why); changed = true;
        tell({ title: "Task gagal", body: `${t.title}: ${why}`, level: "error", timeout: 15000 });
      };
      const missed = (t, why) => { t.tries = (t.tries ?? 0) + 1; changed = true; if (t.tries >= MAX_TRIES) fail(t, `${why} (${MAX_TRIES}x)`); else note(t, `${why}, nyoba lagi…`); };
      // mesin tempat space task itu (null = komputer ini), atau dari alamat terminalnya ("mesin/t7")
      const machineOf = (t, addr = t.agent) => {
        const m = sps.find((s) => s.id === t.space)?.machine;
        if (m) return m;
        const a = String(addr ?? "");
        return a.includes("/") ? a.slice(0, a.lastIndexOf("/")) : null;
      };
      // folder kerja staf: label statusline (agent.cwd), lalu folder panel-nya
      const cwdOf = (addr) => {
        const a = ag.find((x) => x.address === addr);
        return labelsOf(addr)["agent.cwd"] || (a && pns.find((p) => p.pane === a.pane)?.cwd) || null;
      };
      // folder space: tempat terminal barunya mulai, atau folder terminal pertamanya
      const spaceCwd = (t) => {
        const s = sps.find((x) => x.id === t.space);
        if (s?.folder) return s.folder;
        const tabs = new Set((s?.tabs ?? []).map((x) => x.id));
        return pns.find((p) => tabs.has(p.tab) && p.cwd)?.cwd ?? null;
      };
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
        t.failed = why; t.stopped = true; t.failedAt = now; delete t.asking; delete t.held; delete t.checking; delete t.checkWanted; changed = true;
        note(t, a ? `${why}, ${name(a)} disuruh berhenti` : why);
        const back = backOf(t);
        if (a && back.length) t.restore = back;
      };
      const done = (t, a, why) => {
        t.column = "done"; t.finishedAt = now; t.notifyDone = true; note(t, why); changed = true;
        const back = backOf(t);
        if (back.length) t.restore = back;
      };
      // dikirim ke staf: catat siapa dan model apa (buat rekap), dan posisi git-nya (buat diff di kartu)
      const sentTo = async (t, a) => {
        const L = labelsOf(a.address);
        t.agentName = name(a);
        const model = t.model ?? modelAlias(L["agent.model"] ?? L["claude.model"]) ?? (isClaude(a) ? null : (a.program?.name ?? a.app ?? null));
        if (model) t.ranModel = model;
        const g = await gitStart(cwdOf(a.address), machineOf(t, a.address));
        if (g) t.git = g;
      };

      // jadwal: yang jamnya tiba pindah ke "Sedang dikerjakan"; jadwal berulang menjalankan salinannya
      let copies = 0;
      for (const t of d.tasks.filter((x) => x.column === "todo")) {
        const due = typeof t.startAt === "number" && t.startAt <= now;
        if (t.repeat && t.atTime && (due || t.runNow)) {
          const c = runCopy(t, now + copies++);
          d.tasks.push(c); byId.set(c.id, c); changed = true;
          if (due) { t.startAt = nextRun(t.atTime, t.repeat, now); t.lastRun = now; }
          delete t.runNow;
        } else if (due) {
          t.column = "doing"; t.startedAt = now; delete t.startAt; delete t.atTime; delete t.repeat; delete t.runNow;
          note(t, "Mulai sesuai jadwal, nunggu dikirim…"); changed = true;
        }
      }

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
          // worktree: selalu agent baru di worktree-nya (staf yang udah ada gak bisa pindah folder)
          const wt = Boolean(t.worktree);
          const want = !wt && t.target ? ag.find((a) => a.address === t.target && a.space === t.space) : null;
          if (!wt && t.target && !want) { delete t.target; delete t.targetName; note(t, "Staf pilihan udah ilang, pindah ke otomatis"); changed = true; }
          const ok = (a) => a.space === t.space && !claimed.has(a.address) && isFree(a);
          const staged = !wt && t.agent ? ag.find((a) => a.address === t.agent) : null;
          const free = wt ? null : staged ? (isFree(staged) ? staged : null) : want ? (ok(want) ? want : null) : t.target ? null : ag.find(ok);
          const newTab = wt || (!free && !staged && !want && !ag.some((a) => a.space === t.space));
          // usage Claude hampir habis: jangan kirim dulu (kecuali kamu klik KIRIM AJA di kartunya)
          if (hold && !t.noHold && (free ? isClaude(free) : newTab)) {
            if (!t.held) {
              t.held = true; changed = true;
              try { notify({ title: "Task ditahan", body: `${t.title}: usage ${hold.label} ${hold.used}%, dikirim setelah reset ${fmtClock(hold.resets, now)}`, level: "warning", timeout: 15000 }); } catch {}
            }
            note(t, `Ditahan: usage ${hold.label} ${hold.used}%, dikirim setelah reset ${fmtClock(hold.resets, now)}`);
            continue;
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
            const r = await hc(["send", free.address, promptOf(t, byId)]).catch(() => null);
            if (r && r.code === 0) {
              t.agent = free.address; t.sentAt = now; t.seen = false; t.tries = 0; t.costStart = m.cost ?? 0; t.tokStart = m.tok ?? 0;
              claimed.add(free.address); note(t, `Dikirim ke ${name(free)}`); changed = true;
              await sentTo(t, free);
            } else missed(t, "Gagal kirim");
          } else if (staged) note(t, `Nunggu ${name(staged)} kosong…`);
          else if (want) note(t, `Nunggu ${name(want)} kosong…`);
          else if (newTab) {
            let folder = null;
            if (wt) {
              try {
                const w = await makeWorktree(spaceCwd(t), t, machineOf(t));
                t.wtPath = w.path; t.wtBranch = w.branch; folder = w.path; changed = true;
              } catch (e) { fail(t, `Worktree gagal: ${e?.message ?? e}`); continue; }
            }
            run("tab.new", { space: t.space, name: t.title.slice(0, 40), argv: newAgentArgv(t), task: promptOf(t, byId), ...(folder ? { folder } : {}) });
            t.sentAt = now; t.byTab = t.title.slice(0, 40); note(t, wt ? `Buka agent Claude baru di worktree ${t.wtBranch}` : "Buka agent Claude baru"); changed = true;
            const g = await gitStart(folder ?? spaceCwd(t), machineOf(t));
            if (g) t.git = g;
          } else note(t, "Nunggu staf di space ini kosong…");
          continue;
        }
        const a = t.agent ? ag.find((x) => x.address === t.agent) : ag.find((x) => x.space === t.space && x.tab_name === t.byTab);
        if (a && !t.agent) {
          // sesi baru: biaya mulai dari 0
          t.agent = a.address; t.costStart = 0; t.tokStart = 0; t.agentName = name(a); claimed.add(a.address); changed = true;
          const model = t.model ?? modelAlias(labelsOf(a.address)["agent.model"]);
          if (model) t.ranModel = model;
        }
        if (!a) {
          if (t.seen) fail(t, "Staf ilang sebelum kelar");
          else if (now - t.sentAt > 60000) fail(t, t.byTab ? "Agent baru gak muncul" : "Staf ilang");
          continue;
        }
        trackMeter(t);
        if (t.asking) {
          // staf nanya balik: tunggu sampai dia kerja lagi (kamu udah jawab), atau udah ada balasan yang lebih baru
          // (jawaban yang dikerjakan kilat, di antara dua putaran mesin). Waktu nunggu ini gak dihitung ke batas waktu.
          const j = a.status === "working" ? null : await this.state(lastOf(a.address), 10000, machineOf(t));
          if (a.status === "working" || (j?.at && j.at > (t.resultAt ?? 0))) {
            delete t.asking; delete t.choices; t.askedMs = (t.askedMs ?? 0) + Math.max(0, now - (t.askingSince ?? now)); delete t.askingSince; changed = true;
          } else { note(t, `${name(a)} nanya balik, nunggu jawaban kamu`); continue; }
        }
        if (t.checkWanted || t.checking) {
          // agent kerja lagi (kamu nyuruh sesuatu): cek dibatalin, nanti dicek lagi waktu dia berhenti
          if (a.status === "working") {
            delete t.checkWanted; delete t.checking; delete t.resultWanted; delete t.idleAt; t.seen = true; changed = true;
            note(t, `${name(a)} lagi ngerjain…`);
            continue;
          }
          if (t.resultWanted) { note(t, `${name(a)} berhenti, baca hasilnya dulu sebelum dicek…`); continue; }
          if (t.checkWanted) { delete t.checkWanted; t.checking = true; t.checkAt = now; changed = true; }
          const key = `${t.id}:${t.sentAt}:${t.checkRounds ?? 0}`;
          const job = this.checks.get(key) ?? this.startCheck(key, t, t.wtPath ?? cwdOf(a.address) ?? t.git?.top ?? spaceCwd(t), machineOf(t, a.address));
          if (!job.done) { note(t, `Ngecek: ${t.check.slice(0, 60)} (${fmtDur(now - job.at)})`); continue; }
          this.checks.delete(key);
          const r = job.result, out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
          delete t.checking; changed = true;
          if (r.code === 0) { t.checkOk = true; t.checkLog = tailOf(out, 12, 800); done(t, a, `Kelar oleh ${name(a)}, cek lolos`); continue; }
          t.checkLog = tailOf(out, 30, 2000);
          const back = backOf(t);
          if (typeof r.code !== "number") {
            fail(t, `Cek gak bisa dijalankan (atau lewat 10 menit): ${String(r.stderr ?? "").trim().split("\n").pop().slice(0, 100)}`);
            if (back.length) t.restore = back;
            continue;
          }
          t.checkRounds = (t.checkRounds ?? 0) + 1;
          if (t.checkRounds > CHECK_FIXES) {
            fail(t, `Cek masih gagal setelah ${CHECK_FIXES}x dibenerin (kode ${r.code})`);
            if (back.length) t.restore = back;
            continue;
          }
          const s = await hc(["send", a.address, fixPrompt(t, r)]).catch(() => null);
          if (!s || s.code !== 0) { fail(t, "Gagal kirim hasil cek ke agent"); continue; }
          t.seen = false; t.fixAt = now;
          note(t, `Cek gagal (kode ${r.code}), ${name(a)} disuruh benerin (${t.checkRounds}/${CHECK_FIXES})`);
          continue;
        }
        if (t.limitMin && !t.overdue && now - t.sentAt - (t.askedMs ?? 0) > t.limitMin * 60000) {
          t.overdue = true; changed = true;
          if (t.limitStop) {
            await stopTask(t, a, `Dihentikan: lewat batas ${t.limitMin} mnt`);
            tell({ title: "Task dihentikan", body: `${t.title} lewat batas ${t.limitMin} mnt`, level: "warning", timeout: 15000 });
            continue;
          }
          tell({ title: "Task lewat batas waktu", body: `${t.title} udah jalan ${fmtDur(now - t.sentAt - (t.askedMs ?? 0))} (batas ${t.limitMin} mnt)`, level: "warning", timeout: 15000 });
        }
        if (t.costMax && !t.overCost && typeof t.cost === "number" && t.cost >= t.costMax) {
          t.overCost = true; changed = true;
          const body = `${t.title} udah $${t.cost.toFixed(2)} (batas $${t.costMax})`;
          if (t.limitStop) {
            await stopTask(t, a, `Dihentikan: lewat batas biaya $${t.costMax}`);
            tell({ title: "Task dihentikan", body, level: "warning", timeout: 15000 });
            continue;
          }
          tell({ title: "Task lewat batas biaya", body, level: "warning", timeout: 15000 });
        }
        if (a.status === "working") { if (!t.seen) { t.seen = true; changed = true; } note(t, `${name(a)} lagi ngerjain…`); }
        else if (a.status === "blocked") note(t, `${name(a)} nunggu jawaban kamu`);
        else if (t.seen || now - (t.fixAt ?? t.sentAt) > 120000) {
          if (t.check) {
            // belum kelar: baca hasilnya dulu (bisa jadi pertanyaan), baru jalankan cek
            t.checkWanted = true; t.resultWanted = true; t.idleAt = now; changed = true;
            note(t, `${name(a)} berhenti, baca hasilnya dulu sebelum dicek…`);
          } else {
            // notifikasi "kelar" nunggu hasilnya dibaca: kalau ternyata pertanyaan, yang muncul "nanya balik"
            t.resultWanted = true;
            done(t, a, `Kelar oleh ${name(a)}`);
          }
        }
      }

      for (const t of d.tasks) {
        // hasil kerja: pesan terakhir agent, ditulis hook Stop ke ~/.local/state/pixel-hq/last/<terminal>.json.
        // Agent tanpa hook (bukan Claude, atau Claude yang hook-nya gak kebaca 20 detik): baris terakhir layarnya.
        if (t.resultWanted && t.agent) {
          trackMeter(t);
          const a = ag.find((x) => x.address === t.agent), m = machineOf(t);
          const since = t.finishedAt ?? t.idleAt ?? now;
          const hook = !a || isClaude(a);
          const j = hook ? await this.state(lastOf(t.agent), m ? 5000 : 0, m) : null;
          const fresh = j?.text && (t.resultAt != null ? j.at > t.resultAt : j.at * 1000 >= (t.sentAt ?? 0) - 5000);
          if (fresh) {
            t.result = String(j.text).slice(0, 4000); t.resultAt = j.at; delete t.resultWanted; delete t.resultFrom; changed = true;
            const text = t.result.trim();
            if (AGENT_ERROR.test(text)) { delete t.notifyDone; delete t.checkWanted; t.column = "doing"; fail(t, `Agent error: ${text.split("\n")[0].slice(0, 80)}`); }
            else if (asksBack(text)) {
              delete t.notifyDone; delete t.finishedAt; delete t.checkWanted; delete t.idleAt; t.column = "doing"; t.asking = true; t.askingSince = now;
              t.choices = answerChoices(text);
              note(t, `${a ? name(a) : "Staf"} nanya balik, nunggu jawaban kamu`);
              tell({ title: "Staf nanya balik", body: `${t.title}: ${lastLine(text).slice(0, 140)}`, level: "warning", timeout: 20000, action: { name: "mod.open", args: { name: "company-kanban" } } });
            }
          } else if (a && (!hook || now - since > SCREEN_AFTER)) {
            const text = await this.screen(t.agent);
            if (text) { t.result = text; t.resultFrom = "layar"; t.resultAt = Math.floor(now / 1000); delete t.resultWanted; changed = true; }
            else if (now - since > 60000) { delete t.resultWanted; changed = true; }
          } else if (now - since > 60000) { delete t.resultWanted; changed = true; }
        }
        if (t.notifyDone && !t.resultWanted) {
          delete t.notifyDone; changed = true;
          if (t.column === "done") {
            if (t.git) { const df = await gitDiff(t.git, machineOf(t)); if (df) t.diff = df; }
            const cost = typeof t.cost === "number" && t.cost > 0 ? ` · $${t.cost.toFixed(2)}` : "";
            const extra = `${t.checkOk ? " · cek lolos" : ""}${t.diff?.files ? ` · ${t.diff.files} file diubah` : ""}`;
            tell({ title: "Task kelar", body: `${t.title} · ${fmtDur((t.finishedAt ?? now) - (t.sentAt ?? now))}${cost}${extra}`, level: "info" });
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

      // riwayat buat rekap: task yang kelar (sekali per kali jalan) dan yang gagal/dihentikan
      const logs = [];
      for (const t of d.tasks) {
        if (t.logged) continue;
        if (t.column === "done" && t.sentAt && !t.resultWanted && !t.notifyDone) logs.push([t, historyEntry(t, "kelar", now)]);
        else if (t.failed) logs.push([t, historyEntry(t, t.stopped ? "dihentikan" : "gagal", now)]);
      }
      if (logs.length && await this.writeHistory(logs.map((x) => x[1]), now)) {
        for (const [t] of logs) t.logged = true;
        changed = true;
      }

      // task dari terminal: diambil sesudah putaran kirim, jadi baru dikirim di putaran berikutnya (setelah tersimpan)
      const inbox = await readJson(inboxFile());
      if (inbox) {
        if (importInbox(d, Array.isArray(inbox) ? inbox : inbox.tasks, sps, pns, now) || JSON.stringify(d.imported ?? []) !== importedBefore) changed = true;
      }

      // cek yang task-nya udah gak ngecek (dihentikan, dihapus, dipindah): lupakan hasilnya
      for (const k of [...this.checks.keys()]) if (!d.tasks.some((t) => t.checking && k.startsWith(`${t.id}:${t.sentAt}:`))) this.checks.delete(k);
      const live = (x) => x.column === "doing" && !x.failed;
      this.counts = {
        todo: d.tasks.filter((x) => x.column === "todo").length,
        doing: d.tasks.filter(live).length,
        failed: d.tasks.filter((x) => x.failed && !x.stopped).length,
        asking: d.tasks.filter((x) => x.asking && !x.failed).length,
        held: d.tasks.filter((x) => x.held && !x.failed).length,
        checking: d.tasks.filter((x) => live(x) && (x.checking || x.checkWanted)).length,
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
