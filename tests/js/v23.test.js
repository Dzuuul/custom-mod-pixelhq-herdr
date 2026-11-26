// Tes fitur kanban 2.3: CEK otomatis, batas biaya, bawa hasil, jawaban cepat, jadwal, worktree dan diff,
// HASIL dari layar, space di mesin lain, notifikasi HP, riwayat rekap, dan pilihan baru dari terminal. Jalankan: sh tests/run-js.sh
import { M, reset } from "./mock.js";
import {
  KanbanEngine, answerChoices, promptOf, screenText, parseClock, nextRun, runCopy, slugOf, gitStart, gitDiff, makeWorktree,
  pushArgs, historyEntry, addHistory, importInbox, checkCommand, termOf, tailOf, CHECK_FIXES, HISTORY_DAYS,
} from "./kanban.js";

const FILE = "/cfg/pixel-hq-kanban.json", HIST = "/cfg/pixel-hq-kanban-history.json";
const LAST = (a) => `/home/.local/state/pixel-hq/last/${a}.json`;
let failed = 0, passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; print(`GAGAL: ${msg}`); } };
const board = () => JSON.parse(M.files.get(FILE));
const put = (tasks, extra = {}) => M.files.set(FILE, JSON.stringify({ tasks, ...extra }, null, 2));
const sends = (addr) => M.calls.filter((c) => c[0] === "send" && c[1] === addr);
const task = (o) => ({ id: "a", title: "Bikin tes", space: "s1", spaceName: "S1", column: "doing", created: 1, order: 1, startedAt: 1, ...o });
const claude = (o = {}) => ({ address: "t1", pane: "p1", space: "s1", status: "idle", app: "claude-code", program: { name: "Claude Code" }, ...o });
const nowS = () => Math.floor(Date.now() / 1000);
const flush = async () => { for (let i = 0; i < 10; i++) await null; };
const hist = () => (M.files.has(HIST) ? JSON.parse(M.files.get(HIST)).runs : []);

// --- jawaban cepat ---
{
  ok(JSON.stringify(answerChoices("Udah aku lihat.\nMau pakai Postgres atau SQLite?")) === '["Postgres","SQLite"]', `atau: ${JSON.stringify(answerChoices("Mau pakai Postgres atau SQLite?"))}`);
  ok(JSON.stringify(answerChoices("Mau lanjut ke langkah 2 atau berhenti dulu?")) === '["lanjut ke langkah 2","berhenti dulu"]', "atau dengan kata kerja");
  ok(JSON.stringify(answerChoices("Mau pakai Postgres, MySQL, atau SQLite?")) === '["Postgres","MySQL","SQLite"]', "daftar koma");
  ok(JSON.stringify(answerChoices("Should I use tabs or spaces?")) === '["tabs","spaces"]', "or (Inggris)");
  ok(JSON.stringify(answerChoices("Udah aku cek. Mau lanjut?")) === '["Ya, lanjut","Gak usah"]', "ya/gak");
  ok(answerChoices("Ada lagi yang bisa dibantu?").length === 0, "basa-basi gak dikasih tombol");
  const list = answerChoices("Ada dua cara:\n1. **Refactor** modulnya\n2. Tambal cepat\n\nPilih yang mana?");
  ok(JSON.stringify(list) === '["1. Refactor modulnya","2. Tambal cepat"]', `daftar bernomor: ${JSON.stringify(list)}`);
  ok(JSON.stringify(answerChoices("Yang udah:\n1. Fix A\n2. Fix B\nMau aku commit?")) === '["Ya, lanjut","Gak usah"]', "daftar ringkasan + pertanyaan ya/gak bukan pilihan");
}

// --- bawa hasil ---
{
  const dep = { id: "d", title: "Rencana", result: "Langkah 1, langkah 2" };
  const by = new Map([["d", dep]]);
  ok(promptOf({ title: "Kerjakan", after: "d", carry: true }, by).includes('Hasil task sebelumnya ("Rencana"):\n\nLangkah 1, langkah 2'), "hasil ditempel");
  ok(promptOf({ title: "Kerjakan", after: "d" }, by) === "Kerjakan", "tanpa carry gak ditempel");
}

// bawa hasil lewat mesin: task kedua dikirim dengan hasil task pertama
{
  reset();
  M.agents = [claude()];
  put([task({ id: "p", title: "Rencana", column: "done", sentAt: 5, finishedAt: 9, result: "Rencananya: A lalu B", logged: true }),
    task({ id: "q", title: "Kerjakan", after: "p", carry: true })]);
  await new KanbanEngine().tick();
  ok(sends("t1").some((c) => c[2].startsWith("Kerjakan\n\nHasil task sebelumnya") && c[2].endsWith("Rencananya: A lalu B")), "mesin mengirim hasil task sebelumnya");
}

// --- CEK otomatis: gagal -> disuruh benerin -> lolos -> kelar ---
{
  reset();
  M.agents = [claude({ status: "working" })];
  M.labels.t1 = { "agent.cwd": "/repo" };
  let checkCode = 1;
  M.onExec = (cmd, args, o) => (cmd === "sh" && args[1] === "npm test" ? { code: checkCode, stdout: `tes ${checkCode ? "gagal: expected 2 got 3" : "lolos"}`, stderr: "", cwd: o.cwd } : { code: 1, stdout: "", stderr: "" });
  put([task({ sentAt: Date.now() - 5000, agent: "t1", seen: true, check: "npm test", costStart: 0, tokStart: 0 })]);
  const e = new KanbanEngine();
  M.agents[0].status = "idle";
  M.files.set(LAST("t1"), JSON.stringify({ at: nowS(), text: "Udah aku benerin." }));
  await e.tick();
  let t = board().tasks[0];
  ok(t.column === "doing" && !t.finishedAt && t.result === "Udah aku benerin.", "agent berhenti: hasil dibaca, belum kelar");
  await e.tick(); // mulai cek
  t = board().tasks[0];
  ok(t.checking === true, "cek jalan");
  const run1 = M.execs.find((x) => x[0] === "sh" && x[1][1] === "npm test");
  ok(run1 && run1[2].cwd === "/repo", "cek jalan di folder agent");
  await flush(); await e.tick();
  t = board().tasks[0];
  ok(t.checkRounds === 1 && t.column === "doing" && !t.checking, "cek gagal dicatat");
  const fix = sends("t1").find((c) => c[2].startsWith("Cek otomatis `npm test` gagal"));
  ok(fix && fix[2].includes("expected 2 got 3"), "output cek dikirim ke agent");
  ok(t.checkLog.includes("expected 2 got 3"), "output cek disimpan di kartu");
  // agent benerin
  M.agents[0].status = "working"; await e.tick();
  M.agents[0].status = "idle"; checkCode = 0;
  M.files.set(LAST("t1"), JSON.stringify({ at: nowS() + 2, text: "Udah lolos." }));
  await e.tick(); await e.tick(); await flush(); await e.tick();
  t = board().tasks[0];
  ok(t.column === "done" && t.checkOk === true && t.result === "Udah lolos.", "cek lolos: kelar");
  ok(M.notes.some((n) => n.title === "Task kelar" && n.body.includes("cek lolos")), "notifikasi kelar menyebut cek");
  ok(e.counts.checking === 0, "hitungan dicek kosong lagi");
  const h = hist();
  ok(h.length === 1 && h[0].outcome === "kelar" && h[0].check === "lolos" && h[0].fixes === 1, "riwayat mencatat cek");
}

// CEK gagal terus: gagal setelah CHECK_FIXES kali
{
  reset();
  M.agents = [claude()];
  M.onExec = (cmd) => (cmd === "sh" ? { code: 2, stdout: "", stderr: "rusak" } : { code: 1, stdout: "" });
  put([task({ sentAt: Date.now() - 5000, agent: "t1", seen: true, check: "make", checkRounds: CHECK_FIXES, resultAt: nowS() - 50, prevModel: "opus" })]);
  const e = new KanbanEngine();
  M.files.set(LAST("t1"), JSON.stringify({ at: nowS(), text: "Coba lagi udah." }));
  await e.tick(); await e.tick(); await flush(); await e.tick();
  const t = board().tasks[0];
  ok(t.failed && t.failed.includes(`${CHECK_FIXES}x`) && !t.stopped, `gagal setelah ${CHECK_FIXES}x: ${t.failed}`);
  ok(sends("t1").some((c) => c[2] === "/model opus") && !t.restore, "model dikembalikan setelah cek gagal");
  ok(hist()[0]?.outcome === "gagal" && hist()[0].check === "gagal", "riwayat gagal");
}

// CEK gak bisa jalan (exec ditolak): langsung gagal, agent gak disuruh benerin
{
  reset();
  M.agents = [claude()];
  M.onExec = () => { throw new Error("sh gak ada"); };
  put([task({ sentAt: Date.now() - 5000, agent: "t1", seen: true, check: "npm test", checking: true })]);
  const e = new KanbanEngine();
  await e.tick(); await flush(); await e.tick();
  const t = board().tasks[0];
  ok(t.failed?.startsWith("Cek gak bisa dijalankan") && !sends("t1").length, "exec ditolak: gagal tanpa nyuruh agent");
}

// CEK dibatalin kalau agent kerja lagi; Herdr restart di tengah cek = cek diulang
{
  reset();
  M.agents = [claude({ status: "working" })];
  put([task({ sentAt: Date.now() - 5000, agent: "t1", seen: true, check: "npm test", checking: true })]);
  await new KanbanEngine().tick();
  let t = board().tasks[0];
  ok(!t.checking && t.column === "doing", "agent kerja lagi: cek dibatalin");
  reset();
  M.agents = [claude()];
  M.onExec = (cmd) => (cmd === "sh" ? { code: 0, stdout: "ok" } : { code: 1, stdout: "" });
  put([task({ sentAt: Date.now() - 5000, agent: "t1", seen: true, check: "npm test", checking: true })]);
  const e = new KanbanEngine();
  await e.tick(); await flush(); await e.tick();
  t = board().tasks[0];
  ok(t.column === "done" && t.checkOk, "cek yang terputus diulang");
}

// checkCommand
{
  ok(JSON.stringify(checkCommand("npm test", "/r", "linux", null)) === JSON.stringify({ cmd: "sh", args: ["-c", "npm test"], cwd: "/r" }), "linux: sh");
  ok(checkCommand("npm test", "C:/r", "windows", null).cmd === "powershell.exe", "windows: powershell");
  const w = checkCommand("npm test", "/home/u/r", "windows", null);
  ok(w.cmd === "wsl.exe" && w.args.join(" ") === "--cd /home/u/r -e sh -c npm test" && w.cwd === null, "windows + folder WSL: lewat wsl.exe");
  ok(checkCommand("x", "/r", "windows", "vps").cmd === "sh", "mesin lain: sh");
  ok(tailOf("a\nb\nc", 2) === "b\nc" && tailOf("x".repeat(50), 60, 10).length === 11, "tailOf");
}

// --- batas biaya ---
{
  reset();
  M.agents = [claude({ status: "working" })];
  M.labels.t1 = { "agent.cost": "1.6", "agent.tokens": "100" };
  put([task({ sentAt: Date.now() - 5000, agent: "t1", seen: true, costStart: 0.5, tokStart: 0, costMax: 1 })]);
  await new KanbanEngine().tick();
  let t = board().tasks[0];
  ok(t.overCost && !t.failed && M.notes.some((n) => n.title === "Task lewat batas biaya"), "lewat batas biaya: diingatkan");
  reset();
  M.agents = [claude({ status: "working" })];
  M.labels.t1 = { "agent.cost": "2.5" };
  put([task({ sentAt: Date.now() - 5000, agent: "t1", seen: true, costStart: 0, tokStart: 0, costMax: 2, limitStop: true })]);
  await new KanbanEngine().tick();
  t = board().tasks[0];
  ok(t.stopped && t.failed.includes("biaya") && M.calls.some((c) => c[0] === "interrupt"), "lewat batas biaya + hentikan: agent disetop");
}

// --- jadwal ---
{
  ok(parseClock("9:05") === "09:05" && parseClock("22.30") === "22:30" && parseClock("24:00") === null && parseClock("jam 9") === null, "parseClock");
  const fri = new Date(2026, 10, 27, 10, 0).getTime(); // Jumat 27 Nov 2026 10:00
  const n1 = new Date(nextRun("09:00", "kerja", fri));
  ok(n1.getDay() === 1 && n1.getHours() === 9 && n1.getDate() === 30, `hari kerja: Jumat 10:00 -> Senin 09:00 (${n1})`);
  const n2 = new Date(nextRun("11:00", undefined, fri));
  ok(n2.getDate() === 27 && n2.getHours() === 11, "sekali: hari ini kalau jamnya belum lewat");
  const n3 = new Date(nextRun("09:00", "harian", fri));
  ok(n3.getDate() === 28, "tiap hari: besok");
  ok(slugOf("Perbaiki Tés gagal!!") === "perbaiki-tes-gagal" && slugOf("???") === "task", "slugOf");

  reset();
  M.agents = [claude()];
  const past = Date.now() - 1000;
  put([task({ id: "s1", column: "todo", startAt: past, atTime: "09:00" }),
    task({ id: "r1", title: "Cek dependensi", column: "todo", startAt: past, atTime: "09:00", repeat: "harian", model: "haiku" }),
    task({ id: "f1", title: "Nanti", column: "todo", startAt: Date.now() + 3600000, atTime: "23:59" })]);
  const e = new KanbanEngine();
  await e.tick();
  const d = board(), by = Object.fromEntries(d.tasks.map((t) => [t.id, t]));
  ok(by.s1.column === "doing" && !by.s1.startAt && by.s1.startedAt, "jadwal sekali: pindah ke jalan");
  ok(by.r1.column === "todo" && by.r1.startAt > Date.now() && by.r1.lastRun, "jadwal berulang tetap di antrean, maju ke berikutnya");
  const copy = d.tasks.find((t) => t.fromRepeat === "r1");
  ok(copy && copy.column === "doing" && copy.model === "haiku" && copy.title === "Cek dependensi" && !copy.repeat, "salinan jadwal dijalankan");
  ok(by.f1.column === "todo", "jadwal yang belum tiba gak disentuh");
  // JALANKAN SEKARANG
  const d2 = board(); d2.tasks.find((t) => t.id === "r1").runNow = true; M.files.set(FILE, JSON.stringify(d2));
  await e.tick();
  ok(board().tasks.filter((t) => t.fromRepeat === "r1").length === 2 && !board().tasks.find((t) => t.id === "r1").runNow, "jalankan sekarang: salinan kedua");
  ok(runCopy({ id: "x", title: "T", repeat: "kerja", atTime: "08:00", target: "t1" }, 5).target === "t1", "runCopy membawa pilihan");
}

// --- git: titik awal dan diff ---
const fakeGit = (o = {}) => (cmd, args, opt) => {
  if (cmd !== "git") return { code: 1, stdout: "" };
  const a = args.join(" ");
  M.gitLog = [...(M.gitLog ?? []), [a, opt]];
  if (a === "rev-parse --show-toplevel") return opt.cwd?.startsWith("/repo") || opt.cwd?.startsWith("/.worktrees") ? { code: 0, stdout: "/repo\n" } : { code: 128, stdout: "" };
  if (a === "rev-parse HEAD") return { code: 0, stdout: "abc123\n" };
  if (a === "stash create") return { code: 0, stdout: o.dirty ? "snap999\n" : "" };
  if (a === "ls-files --others --exclude-standard") return { code: 0, stdout: o.untracked ?? "" };
  if (a.startsWith("diff --shortstat")) return { code: 0, stdout: " 3 files changed, 120 insertions(+), 14 deletions(-)\n" };
  if (a === "worktree list --porcelain") return { code: 0, stdout: o.listed ?? "worktree /repo\n" };
  if (a.startsWith("rev-parse --verify")) return { code: 1, stdout: "" };
  if (a.startsWith("worktree add")) return o.addFails ? { code: 128, stdout: "", stderr: "fatal: gagal\n" } : { code: 0, stdout: "" };
  return { code: 1, stdout: "" };
};
{
  reset();
  M.onExec = fakeGit({ dirty: true, untracked: "a.txt\n" });
  const g = await gitStart("/repo/src", null);
  ok(g && g.top === "/repo" && g.base === "snap999" && g.untracked === 1, "gitStart: perubahan lama dipotret (stash create)");
  M.onExec = fakeGit({ untracked: "a.txt\nb.txt\nc.txt\n" });
  const df = await gitDiff(g, null);
  ok(df && df.files === 3 && df.add === 120 && df.del === 14 && df.fresh === 2, `gitDiff ${JSON.stringify(df)}`);
  ok(await gitStart("/bukan-repo", null) === null && await gitStart(null, null) === null, "bukan repo: null");
  M.onExec = fakeGit({});
  ok((await gitStart("/repo", null)).base === "abc123", "bersih: base = HEAD");
}

// kirim ke staf: posisi git dicatat, diff masuk kartu waktu kelar
{
  reset();
  M.agents = [claude()];
  M.labels.t1 = { "agent.cwd": "/repo", "agent.model": "Opus 5.5" };
  M.onExec = fakeGit({});
  put([task({})]);
  const e = new KanbanEngine();
  await e.tick();
  let t = board().tasks[0];
  ok(t.git?.base === "abc123" && t.agentName && t.ranModel === "opus", "git, nama staf, dan model dicatat waktu kirim");
  M.agents[0].status = "working"; await e.tick();
  M.agents[0].status = "idle";
  M.files.set(LAST("t1"), JSON.stringify({ at: nowS() + 1, text: "Beres." }));
  await e.tick();
  t = board().tasks[0];
  ok(t.column === "done" && t.diff?.files === 3 && t.diff.add === 120, "diff di kartu");
  ok(M.notes.some((n) => n.title === "Task kelar" && n.body.includes("3 file diubah")), "notifikasi menyebut file diubah");
  ok(hist()[0]?.diff?.files === 3 && hist()[0].staff && hist()[0].model === "opus", "riwayat bawa diff, staf, model");
}

// --- worktree ---
{
  reset();
  M.agents = [claude({ space: "s2" })]; // ada staf nganggur di space lain, bukan di s1
  M.spaces[0].folder = "/repo";
  M.onExec = fakeGit({});
  put([task({ id: "kabc1234", title: "Fitur login", worktree: true })]);
  await new KanbanEngine().tick();
  const t = board().tasks[0];
  const r = M.runs.find((x) => x[0] === "tab.new");
  ok(t.wtBranch === "kanban/fitur-login-1234" && t.wtPath === "/.worktrees/repo-kanban-fitur-login-1234", `worktree dibuat: ${t.wtPath}`);
  ok(r && r[1].folder === t.wtPath && r[1].task === "Fitur login", "agent baru dibuka di worktree");
  ok(M.gitLog.some(([a]) => a === "worktree add -b kanban/fitur-login-1234 /.worktrees/repo-kanban-fitur-login-1234"), "git worktree add -b");
  // staf nganggur di space yang sama tetap gak dipakai: worktree selalu agent baru
  reset();
  M.agents = [claude()];
  M.spaces[0].folder = "/repo";
  M.onExec = fakeGit({});
  put([task({ id: "kabc1234", title: "Fitur login", worktree: true })]);
  await new KanbanEngine().tick();
  ok(!sends("t1").length && M.runs.some((x) => x[0] === "tab.new"), "worktree gak dikirim ke staf yang udah ada");
  // diulang: worktree yang sama dipakai lagi
  M.onExec = fakeGit({ listed: "worktree /repo\nworktree /.worktrees/repo-kanban-fitur-login-1234\n" });
  M.gitLog = [];
  const w = await makeWorktree("/repo", { id: "kabc1234", title: "x", wtBranch: "kanban/fitur-login-1234", wtPath: "/.worktrees/repo-kanban-fitur-login-1234" }, null);
  ok(w.reused && !M.gitLog.some(([a]) => a.startsWith("worktree add")), "worktree dipakai ulang");
  // bukan repo / git gagal: task gagal dengan alasannya
  reset();
  M.spaces[0].folder = "/bukan-repo";
  M.onExec = fakeGit({});
  put([task({ worktree: true })]);
  await new KanbanEngine().tick();
  ok(board().tasks[0].failed?.includes("bukan repo git") && !M.runs.length, "worktree di folder bukan repo: gagal");
  reset();
  M.spaces[0].folder = "/repo";
  M.onExec = fakeGit({ addFails: true });
  put([task({ worktree: true })]);
  await new KanbanEngine().tick();
  ok(board().tasks[0].failed === "Worktree gagal: fatal: gagal", "pesan git ditampilkan");
}

// --- HASIL dari layar buat agent selain Claude ---
{
  ok(screenText("╭────╮\n│ hi │\n╰────╯\n\nHasil A\n   \nHasil B   \n────") === "│ hi │\nHasil A\nHasil B", "screenText membuang bingkai dan baris kosong");
  reset();
  M.agents = [{ address: "t3", pane: "p3", space: "s1", status: "idle", app: "codex", program: { name: "Codex" } }];
  M.screens.t3 = "› kerjain\n\nUdah aku ubah 2 file.\nMau lanjut?\n";
  put([task({ sentAt: Date.now() - 5000, agent: "t3", seen: true })]);
  await new KanbanEngine().tick();
  const t = board().tasks[0];
  ok(t.column === "done" && t.resultFrom === "layar" && t.result.includes("Udah aku ubah 2 file."), "hasil Codex dari layar");
  ok(!t.asking, "hasil dari layar gak dipakai buat deteksi nanya balik");
  ok(M.calls.some((c) => c[0] === "read" && c[1] === "t3"), "hc read dipanggil");
  // Claude: hook dulu, layar cuma kalau hook diam 20 detik
  reset();
  M.agents = [claude()];
  M.screens.t1 = "Dari layar";
  put([task({ sentAt: Date.now() - 50000, agent: "t1", seen: true, column: "done", finishedAt: Date.now() - 1000, resultWanted: true, notifyDone: true })]);
  await new KanbanEngine().tick();
  ok(board().tasks[0].resultWanted && !M.calls.some((c) => c[0] === "read"), "Claude: layar belum dibaca selama nunggu hook");
  const d = board(); d.tasks[0].finishedAt = Date.now() - 25000; M.files.set(FILE, JSON.stringify(d));
  await new KanbanEngine().tick();
  ok(board().tasks[0].result === "Dari layar" && board().tasks[0].resultFrom === "layar", "Claude tanpa hook: pakai layar setelah 20 dtk");
}

// --- space di mesin lain ---
{
  ok(termOf("vps/t7") === "t7" && termOf("t7") === "t7" && termOf("a/b/t2") === "t2", "termOf");
  reset();
  M.spaces.push({ id: "vps/s9", name: "Server", machine: "vps", tabs: [{ id: "vps/tab9" }] });
  M.agents = [claude({ address: "vps/t7", pane: "vps/p7", space: "vps/s9" })];
  M.onExec = (cmd, args, o) => (cmd === "sh" && o.on === "vps" && args[args.length - 1] === "last/t7.json"
    ? { code: 0, stdout: JSON.stringify({ at: nowS(), text: "Kelar di VPS. Mau aku deploy?" }) } : { code: 1, stdout: "" });
  put([task({ space: "vps/s9", spaceName: "Server", sentAt: Date.now() - 5000, agent: "vps/t7", seen: true })]);
  await new KanbanEngine().tick();
  const t = board().tasks[0];
  ok(t.asking && t.result === "Kelar di VPS. Mau aku deploy?", "hasil dari hook di mesin lain (nanya balik)");
  ok(JSON.stringify(t.choices) === '["Ya, lanjut","Gak usah"]', "tombol jawaban cepat disiapkan");
  ok(M.execs.some((x) => x[0] === "sh" && x[2].on === "vps"), "dibaca lewat exec di mesin itu");
  ok(!M.files.has(LAST("vps/t7")) && !M.execs.some((x) => x[0] === "sh" && !x[2].on), "gak dibaca dari komputer ini");
}

// --- notifikasi HP ---
{
  const n = { title: "Task kelar", body: "Bikin tes · 2 mnt", level: "info" };
  const a = pushArgs("https://ntfy.sh/topikku", n);
  ok(a[a.length - 1] === "https://ntfy.sh/topikku?title=Task%20kelar&priority=default&tags=white_check_mark" && a.includes("Bikin tes · 2 mnt"), "ntfy: judul lewat query, isi apa adanya");
  ok(pushArgs("https://ntfy.sh/x?auth=k", { ...n, level: "error" }).at(-1).startsWith("https://ntfy.sh/x?auth=k&title="), "ntfy dengan query lama");
  const dc = pushArgs("https://discord.com/api/webhooks/1/abc", n);
  ok(JSON.parse(dc[dc.indexOf("--data-raw") + 1]).content === "**Task kelar**\nBikin tes · 2 mnt", "discord");
  ok(/^[\x00-\x7e]*$/.test(dc[dc.indexOf("--data-raw") + 1]) && dc[dc.indexOf("--data-raw") + 1].includes("\\u00b7"), "JSON webhook ASCII semua");
  const sl = pushArgs("https://hooks.slack.com/services/x", n);
  ok(JSON.parse(sl[sl.indexOf("--data-raw") + 1]).text.startsWith("*Task kelar*"), "slack");
  const tg = pushArgs("https://api.telegram.org/bot123:abc/sendMessage?chat_id=-100%2042", n);
  ok(tg.at(-1) === "https://api.telegram.org/bot123:abc/sendMessage" && JSON.parse(tg[tg.indexOf("--data-raw") + 1]).chat_id === "-100 42", "telegram");

  const curls = () => M.execs.filter((x) => x[0] === "curl");
  const finish = async (setup) => {
    reset(); setup();
    M.agents = [claude()];
    M.onExec = () => ({ code: 0, stdout: "" });
    put([task({ sentAt: Date.now() - 5000, agent: "t1", seen: true })]);
    M.files.set(LAST("t1"), JSON.stringify({ at: nowS(), text: "Selesai." }));
    await new KanbanEngine().tick();
  };
  await finish(() => {});
  ok(curls().length === 0, "tanpa alamat: gak ngirim");
  await finish(() => { M.shared["pixel-hq.push"] = { url: "https://ntfy.sh/t" }; });
  ok(curls().length === 1 && curls()[0][1].at(-1).includes("title=Task%20kelar"), "jendela gak dilihat: kirim ke HP");
  await finish(() => { M.shared["pixel-hq.push"] = { url: "https://ntfy.sh/t" }; M.windowActive = true; });
  ok(curls().length === 0, "jendela lagi dilihat: gak ngirim");
  await finish(() => { M.shared["pixel-hq.push"] = { url: "https://ntfy.sh/t", mode: "always" }; M.windowActive = true; });
  ok(curls().length === 1, "mode selalu: tetap ngirim");
  await finish(() => { M.shared["pixel-hq.push"] = { url: "file:///etc/passwd" }; });
  ok(curls().length === 0, "alamat bukan http(s) ditolak");
  // tes dari dialog
  reset();
  M.shared["pixel-hq.push"] = { url: "https://ntfy.sh/t" }; M.shared["pixel-hq.push-test"] = Date.now(); M.windowActive = true;
  M.onExec = () => ({ code: 22, stdout: "", stderr: "curl: (22) The requested URL returned error: 403\n" });
  const e = new KanbanEngine();
  await e.tick(); await flush();
  ok(curls().length === 1 && M.shared["pixel-hq.push-result"]?.ok === false && M.shared["pixel-hq.push-result"].msg.includes("403"), "tes: hasilnya dilaporkan ke dialog");
  await e.tick();
  ok(curls().length === 1, "tes cuma sekali");
}

// --- riwayat ---
{
  const e1 = historyEntry({ id: "a", title: "T", spaceName: "S", sentAt: 1000, finishedAt: 61000, askedMs: 10000, cost: 0.5, tokens: 10, agentName: "Luna", ranModel: "opus" }, "kelar", 99);
  ok(e1.ms === 50000 && e1.staff === "Luna" && e1.model === "opus" && e1.run === 1000, "historyEntry: durasi tanpa waktu nunggu jawaban");
  const now = Date.now();
  const h = addHistory({ runs: [{ id: "old", run: 1, at: now - (HISTORY_DAYS + 1) * 86400000 }, { id: "a", run: 1000, at: now }] }, [{ id: "a", run: 1000, at: now }, { id: "b", run: 5, at: now }], now);
  ok(h.runs.length === 2 && h.runs.map((r) => r.id).join() === "a,b", "addHistory: dobel dan yang kelamaan dibuang");
  // gagal dan dihentikan tercatat sekali
  reset();
  M.agents = [claude({ status: "working" })];
  put([task({ sentAt: Date.now() - 5000, agent: "t1", seen: true, stopWanted: true })]);
  const e = new KanbanEngine();
  await e.tick(); await e.tick();
  ok(hist().length === 1 && hist()[0].outcome === "dihentikan" && board().tasks[0].logged, "dihentikan tercatat sekali");
  // diulang: kali jalan baru tercatat lagi
  const d = board(); const t = d.tasks[0];
  for (const k of ["sentAt", "agent", "seen", "failed", "failedAt", "stopped", "logged"]) delete t[k];
  M.files.set(FILE, JSON.stringify(d));
  M.agents[0].status = "idle";
  await e.tick();
  M.agents[0].status = "working"; await e.tick();
  M.agents[0].status = "idle";
  M.files.set(LAST("t1"), JSON.stringify({ at: nowS() + 3, text: "Udah." }));
  await e.tick();
  ok(hist().length === 2 && hist()[1].outcome === "kelar", "kali jalan kedua tercatat");
  // KELAR ✓ dari dialog (gak lewat mesin) tetap tercatat
  reset();
  put([task({ column: "done", sentAt: Date.now() - 9000, finishedAt: Date.now() - 1000 })]);
  await new KanbanEngine().tick();
  ok(hist().length === 1 && board().tasks[0].logged, "kelar manual tercatat");
}

// --- pilihan baru dari terminal ---
{
  const d = { tasks: [] };
  const sps = [{ id: "s1", name: "S1", active: true, tabs: [] }];
  importInbox(d, [
    { id: "n1", title: "Cek", check: "npm test", costMax: 1.234, limitStop: true, worktree: true },
    { id: "n2", title: "Jadwal", atTime: "7:30", repeat: "kerja", column: "doing" },
    { id: "n3", title: "Aneh", costMax: -1, limitStop: true, atTime: "99:00", repeat: "kadang" },
  ], sps, [], Date.now());
  const by = Object.fromEntries(d.tasks.map((t) => [t.id, t]));
  ok(by.n1.check === "npm test" && by.n1.costMax === 1.23 && by.n1.limitStop && by.n1.worktree, "cek, biaya, hentikan, worktree dari terminal");
  ok(by.n2.column === "todo" && by.n2.atTime === "07:30" && by.n2.repeat === "kerja" && by.n2.startAt > Date.now() && by.n2.note.includes("hari kerja"), "jadwal dari terminal masuk antrean");
  ok(!by.n3.costMax && !by.n3.limitStop && !by.n3.atTime && !by.n3.repeat, "pilihan gak valid dibuang");
}

print(`${passed} lolos, ${failed} gagal`);
if (failed) imports.system.exit(1);
