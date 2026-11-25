// Tes fitur kanban 2.2: ditahan usage, nanya balik, biaya, batas = hentikan, inbox terminal, baca state dari WSL. Jalankan: sh tests/run-js.sh
import { M, reset } from "./mock.js";
import { KanbanEngine, asksBack, usageHold, importInbox, mergeInto, HOLD_AT } from "./kanban.js";
import { readState, resetStateCache, parseDistros } from "./state.js";

const FILE = "/cfg/pixel-hq-kanban.json", INBOX = "/cfg/pixel-hq-kanban-inbox.json", USAGE = "/home/.local/state/pixel-hq/claude-usage.json";
const LAST = (a) => `/home/.local/state/pixel-hq/last/${a}.json`;
let failed = 0, passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; print(`GAGAL: ${msg}`); } };
const board = () => JSON.parse(M.files.get(FILE));
const put = (tasks, extra = {}) => M.files.set(FILE, JSON.stringify({ tasks, ...extra }, null, 2));
const sends = (addr) => M.calls.filter((c) => c[0] === "send" && c[1] === addr);
const task = (o) => ({ id: "a", title: "Bikin tes", space: "s1", spaceName: "S1", column: "doing", created: 1, order: 1, startedAt: 1, ...o });
const claude = (o = {}) => ({ address: "t1", pane: "p1", space: "s1", status: "idle", app: "claude-code", program: { name: "Claude Code" }, ...o });
const nowS = () => Math.floor(Date.now() / 1000);

// asksBack
ok(asksBack("Udah aku cek.\n\nMau pakai cara A atau B?"), "pertanyaan biasa");
ok(asksBack("Pilih yang mana?**"), "pertanyaan dengan penutup markdown");
ok(asksBack("Lanjut？"), "tanda tanya lebar");
ok(!asksBack("Kenapa error? Karena path salah.\nUdah dibenerin."), "pertanyaan di tengah bukan nanya balik");
ok(!asksBack(""), "kosong");

// usageHold
{
  const n = Date.now(), r = n / 1000 + 3600;
  ok(usageHold({ session: { used: 96, resets: r } }, n)?.label === "sesi 5 jam", "sesi 96% ditahan");
  ok(usageHold({ session: { used: HOLD_AT - 1, resets: r } }, n) === null, "di bawah ambang gak ditahan");
  ok(usageHold({ session: { used: 99, resets: n / 1000 - 10 } }, n) === null, "udah lewat reset gak ditahan");
  ok(usageHold({ session: { used: 96, resets: r }, week: { used: 100, resets: r + 86400 } }, n)?.label === "minggu ini", "pilih reset paling lama");
}

// 1. Ditahan usage: gak kirim, notifikasi sekali, KIRIM AJA (noHold) jalan, lepas waktu usage turun
{
  reset();
  M.agents = [claude()];
  M.files.set(USAGE, JSON.stringify({ at: nowS(), session: { used: 97, resets: nowS() + 3600 } }));
  put([task({})]);
  const e = new KanbanEngine();
  await e.tick(); await e.tick();
  let t = board().tasks[0];
  ok(sends("t1").length === 0 && t.held === true, "task ditahan, gak dikirim");
  ok(M.notes.filter((n) => n.title === "Task ditahan").length === 1, "notifikasi ditahan cuma sekali");
  ok(e.counts.held === 1, "hitungan ditahan");
  const d = board(); d.tasks[0].noHold = true; M.files.set(FILE, JSON.stringify(d));
  await e.tick();
  t = board().tasks[0];
  ok(sends("t1").length === 1 && !t.held, "KIRIM AJA tetap mengirim");
  reset();
  M.agents = [claude()];
  M.files.set(USAGE, JSON.stringify({ at: nowS(), session: { used: 97, resets: nowS() + 3600 } }));
  put([task({})]);
  await e.tick();
  M.files.set(USAGE, JSON.stringify({ at: nowS(), session: { used: 3, resets: nowS() + 18000 } }));
  await e.tick();
  ok(sends("t1").length === 0, "usage di-cache 20 dtk");
  e.reads.clear(); // anggap 20 detik udah lewat
  await e.tick();
  ok(sends("t1").length === 1 && !board().tasks[0].held, "dikirim setelah usage reset");
  // agent non-Claude gak ditahan
  reset();
  M.agents = [claude({ app: "codex", program: { name: "Codex" } })];
  M.files.set(USAGE, JSON.stringify({ at: nowS(), session: { used: 99, resets: nowS() + 3600 } }));
  put([task({})]);
  await e.tick();
  ok(sends("t1").length === 1, "agent non-Claude gak ditahan");
}

// 2. Nanya balik: kelar -> hasil pertanyaan -> balik ke jalan, gak notifikasi "kelar", dependen nunggu, model gak dikembalikan dulu
{
  reset();
  M.agents = [claude({ status: "working" })];
  put([task({ sentAt: Date.now() - 5000, agent: "t1", seen: true, prevModel: "opus", costStart: 0, tokStart: 0 }),
    task({ id: "b", title: "Sesudahnya", column: "doing", created: 2, order: 2, after: "a" })]);
  const e = new KanbanEngine();
  M.agents[0].status = "idle";
  M.files.set(LAST("t1"), JSON.stringify({ at: nowS(), text: "Udah aku lihat.\nMau pakai Postgres atau SQLite?" }));
  await e.tick();
  let [a, b] = board().tasks;
  ok(a.column === "doing" && a.asking === true && !a.finishedAt, "balik ke jalan dengan tanda nanya balik");
  ok(!M.notes.some((n) => n.title === "Task kelar") && M.notes.some((n) => n.title === "Staf nanya balik"), "notifikasi nanya balik, bukan kelar");
  ok(!sends("t1").some((c) => c[2] === "Sesudahnya"), "task dependen gak keburu dikirim");
  ok(!sends("t1").some((c) => c[2] === "/model opus"), "model gak dikembalikan selama nunggu jawaban");
  ok(e.counts.asking === 1, "hitungan nanya balik");
  await e.tick();
  ok(board().tasks[0].asking === true, "tetap nunggu selama staf diam");
  // kamu jawab -> staf kerja -> kelar dengan balasan biasa
  M.agents[0].status = "working"; await e.tick();
  ok(!board().tasks[0].asking, "tanda nanya balik hilang waktu staf kerja lagi");
  M.agents[0].status = "idle";
  M.files.set(LAST("t1"), JSON.stringify({ at: nowS() + 5, text: "Pakai SQLite, udah jadi." }));
  await e.tick();
  [a, b] = board().tasks;
  ok(a.column === "done" && a.result === "Pakai SQLite, udah jadi.", "kelar setelah dijawab");
  ok(M.notes.some((n) => n.title === "Task kelar"), "notifikasi kelar muncul");
  await e.tick(); await e.tick();
  ok(sends("t1").some((c) => c[2] === "/model opus"), "model dikembalikan setelah kelar");
}

// 3. Dijawab kilat (staf gak pernah kelihatan kerja): balasan baru tetap bikin kartu jalan lagi
{
  reset();
  M.agents = [claude()];
  put([task({ sentAt: Date.now() - 5000, agent: "t1", seen: true, asking: true, resultAt: nowS() - 10, result: "Yang mana?" })]);
  M.files.set(LAST("t1"), JSON.stringify({ at: nowS(), text: "Oke, udah." }));
  const e = new KanbanEngine();
  await e.tick();
  const t = board().tasks[0];
  ok(t.column === "done" && t.result === "Oke, udah." && !t.asking, "jawaban kilat tetap terdeteksi");
}

// 4. Biaya per task
{
  reset();
  M.agents = [claude()];
  M.labels.t1 = { "agent.cost": "1.5000", "agent.tokens": "10000" };
  put([task({})]);
  const e = new KanbanEngine();
  await e.tick();
  let t = board().tasks[0];
  ok(t.costStart === 1.5 && t.tokStart === 10000, "angka awal dicatat waktu dikirim");
  M.agents[0].status = "working"; M.labels.t1 = { "agent.cost": "1.9200", "agent.tokens": "22000" };
  await e.tick();
  t = board().tasks[0];
  ok(t.cost === 0.42 && t.tokens === 12000, `biaya jalan ${t.cost} / ${t.tokens}`);
  M.agents[0].status = "idle"; M.labels.t1 = { "agent.cost": "2.0000", "agent.tokens": "25000" };
  M.files.set(LAST("t1"), JSON.stringify({ at: nowS() + 1, text: "Selesai." }));
  await e.tick();
  t = board().tasks[0];
  ok(t.column === "done" && t.cost === 0.5 && t.tokens === 15000, "biaya akhir");
  ok(M.notes.some((n) => n.title === "Task kelar" && n.body.includes("$0.50")), "biaya di notifikasi");
}

// 5. Batas waktu = hentikan
{
  reset();
  M.agents = [claude({ status: "working" })];
  put([task({ sentAt: Date.now() - 11 * 60000, agent: "t1", seen: true, limitMin: 10, limitStop: true })]);
  await new KanbanEngine().tick();
  const t = board().tasks[0];
  ok(M.calls.some((c) => c[0] === "interrupt") && t.stopped && t.failed.includes("lewat batas"), "lewat batas = dihentikan");
  ok(M.notes.some((n) => n.title === "Task dihentikan"), "notifikasi dihentikan");
  // tanpa limitStop cuma diingatkan
  reset();
  M.agents = [claude({ status: "working" })];
  put([task({ sentAt: Date.now() - 11 * 60000, agent: "t1", seen: true, limitMin: 10 })]);
  await new KanbanEngine().tick();
  ok(!M.calls.some((c) => c[0] === "interrupt") && board().tasks[0].overdue && !board().tasks[0].failed, "tanpa hentikan cuma ditandai");
}

// 6. Inbox terminal
{
  reset();
  // papan belum ada sama sekali
  M.files.set(INBOX, JSON.stringify([
    { id: "c1", title: "Dari terminal", column: "todo", created: Date.now() },
    { id: "c2", title: "Ke space Api", spaceName: "api", model: "sonnet", priority: "tinggi", limitMin: 30, limitStop: true, column: "doing" },
    { id: "c3", title: "Dari terminal t9", fromTerminal: "t9" },
    { id: "c4", title: "Space salah", spaceName: "nggak-ada" },
    { id: "c5", title: "" },
    { id: "../x", title: "id aneh" },
    { id: "c6", title: "model aneh", model: "gpt", effort: "ultra", limitMin: -3 },
  ]));
  const e = new KanbanEngine();
  await e.tick();
  const d = board(), by = Object.fromEntries(d.tasks.map((t) => [t.id, t]));
  ok(d.tasks.length === 5, `jumlah task diambil ${d.tasks.length}`);
  ok(by.c1.column === "todo" && by.c1.space === "s1" && by.c1.source === "terminal", "default: antrean, space aktif");
  ok(by.c2.space === "s2" && by.c2.column === "doing" && by.c2.model === "sonnet" && by.c2.priority === "tinggi" && by.c2.limitStop && by.c2.startedAt, "space lewat nama (huruf besar/kecil bebas) dan pilihan");
  ok(by.c3.space === "s2", "space dari terminal pemanggil");
  ok(by.c4.space === "s1" && by.c4.note.includes("gak ada"), "space salah dicatat");
  ok(!by.c6.model && !by.c6.effort && !by.c6.limitMin, "pilihan gak valid dibuang");
  ok(d.imported.includes("c5") && !d.imported.includes("../x"), "id kosong tetap dicatat, id aneh ditolak");
  ok(M.calls.length === 0, "task dari terminal gak dikirim di putaran yang sama");
  // dihapus dari papan: gak muncul lagi
  const d2 = board(); d2.tasks = d2.tasks.filter((t) => t.id !== "c1"); M.files.set(FILE, JSON.stringify(d2));
  await e.tick();
  ok(!board().tasks.some((t) => t.id === "c1"), "task yang dihapus gak diambil lagi");
}

// 7. Inbox + dialog nulis di saat yang sama: task dari terminal gak hilang
{
  reset();
  M.agents = [claude()];
  put([task({})]);
  M.files.set(INBOX, JSON.stringify([{ id: "c9", title: "Baru" }]));
  M.onHc = () => {
    const d = board(); d.tasks.push({ id: "u1", title: "Dari dialog", space: "s1", column: "todo", created: 3, order: 3 });
    M.files.set(FILE, JSON.stringify(d, null, 2)); M.onHc = null;
  };
  await new KanbanEngine().tick();
  const ids = board().tasks.map((t) => t.id).sort().join(",");
  ok(ids === "a,c9,u1", `task dari terminal dan dialog sama-sama ada (${ids})`);
  ok(board().imported?.includes("c9"), "imported ikut tersimpan");
  ok(sends("t1").length === 1, "tetap sekali kirim");
}

// mergeInto dengan task baru
{
  const fresh = { tasks: [{ id: "x" }], imported: ["old"] };
  mergeInto(fresh, [], [{ id: "y" }, { id: "x" }], ["y"]);
  ok(fresh.tasks.length === 2 && fresh.imported.join() === "old,y", "merge task baru dan imported");
}

// 8. Waktu nunggu jawaban gak dihitung ke batas; STOP waktu nanya balik gak menekan tombol stop
{
  reset();
  M.agents = [claude({ status: "working" })];
  // jalan 12 mnt, 5 mnt di antaranya nunggu jawaban: kerja 7 mnt < batas 10
  put([task({ sentAt: Date.now() - 12 * 60000, agent: "t1", seen: true, limitMin: 10, limitStop: true, askedMs: 5 * 60000 })]);
  await new KanbanEngine().tick();
  ok(!board().tasks[0].failed && !board().tasks[0].overdue && !M.calls.some((c) => c[0] === "interrupt"), "waktu nunggu jawaban gak dihitung");
  reset();
  M.agents = [claude()];
  put([task({ sentAt: Date.now() - 60 * 60000, agent: "t1", seen: true, limitMin: 10, limitStop: true, asking: true, askingSince: Date.now() - 50 * 60000, resultAt: nowS() })]);
  await new KanbanEngine().tick();
  ok(!board().tasks[0].failed && board().tasks[0].asking, "selama nanya balik batas gak jalan");
  // dijawab: waktu nunggu dicatat
  M.agents[0].status = "working";
  await new KanbanEngine().tick();
  const t = board().tasks[0];
  ok(!t.asking && t.askedMs >= 50 * 60000 - 1000 && !t.failed, `waktu nunggu dicatat (${t.askedMs})`);
  reset();
  M.agents = [claude()];
  put([task({ sentAt: Date.now() - 5000, agent: "t1", seen: true, asking: true, stopWanted: true, resultAt: nowS() })]);
  await new KanbanEngine().tick();
  ok(board().tasks[0].stopped && !M.calls.some((c) => c[0] === "interrupt"), "STOP saat nanya balik gak menekan stop");
}

// 9. entri inbox yang udah seminggu gak diambil
{
  reset();
  M.files.set(INBOX, JSON.stringify([{ id: "lama1", title: "Lama", created: Date.now() - 8 * 86400000 }, { id: "baru1", title: "Baru", created: Date.now() }]));
  await new KanbanEngine().tick();
  ok(board().tasks.map((t) => t.id).join() === "baru1", "entri lama dilewati");
}

// 10. Windows + Claude Code di WSL: usage dan hasil kerja dibaca dari WSL, wsl.exe gak dipanggil tiap putaran
{
  reset(); resetStateCache(); M.platform = "windows"; M.execs = []; M.wsl = {}; M.wslRunning = ["Ubuntu"];
  M.agents = [claude()];
  M.wsl["Ubuntu:claude-usage.json"] = JSON.stringify({ at: nowS(), session: { used: 99, resets: nowS() + 3600 } });
  put([task({})]);
  const e = new KanbanEngine();
  await e.tick(); await e.tick(); await e.tick();
  ok(sends("t1").length === 0 && board().tasks[0].held, "usage dari WSL bikin task ditahan");
  ok(M.execs.filter((x) => x[1].at(-1) === "claude-usage.json").length === 1, "usage WSL dibaca sekali per 20 dtk");
  // hasil kerja dari WSL
  reset(); resetStateCache(); M.platform = "windows"; M.execs = []; M.wsl = {}; M.wslRunning = ["Ubuntu"];
  M.agents = [claude()];
  put([task({ sentAt: Date.now() - 5000, agent: "t1", seen: true })]);
  M.wsl["Ubuntu:last/t1.json"] = JSON.stringify({ at: nowS(), text: "Mau lanjut ke langkah 2?" });
  const e2 = new KanbanEngine();
  await e2.tick();
  ok(board().tasks[0].asking === true, "hasil kerja dari WSL kebaca (nanya balik)");
  const n = M.execs.length;
  await e2.tick(); await e2.tick();
  ok(M.execs.length - n <= 1, `selama nunggu jawaban wsl.exe gak dipanggil terus (${M.execs.length - n})`);
  M.platform = "linux";
}

// 11. state.js: WSL cuma dibaca dari distro yang lagi jalan
{
  const W = (o) => { reset(); resetStateCache(); M.platform = "windows"; M.execs = []; M.wsl = {}; M.wslRunning = []; M.noWsl = false; Object.assign(M, o); };
  const cats = () => M.execs.filter((x) => x[1][0] === "-d");
  const lists = () => M.execs.filter((x) => x[1][0] === "--list");
  ok(parseDistros("U\u0000b\u0000u\u0000n\u0000t\u0000u\u0000\r\u0000\n\u0000").join() === "Ubuntu", "nama distro dari keluaran UTF-16");
  ok(parseDistros("There are no running distributions.\r\n").length === 0, "pesan 'gak ada yang jalan' dibuang");
  ok(parseDistros("docker-desktop\nUbuntu-22.04\n").join() === "Ubuntu-22.04", "docker-desktop dilewati");

  W({ wslRunning: [] });
  M.files.set("/home/.local/state/pixel-hq/claude-usage.json", '{"at": 5}');
  ok(await readState("claude-usage.json") === '{"at": 5}' && cats().length === 0, "gak ada distro jalan: WSL gak dinyalakan");
  await readState("claude-usage.json");
  ok(lists().length === 1, "daftar distro dicek sekali per menit");

  W({ wslRunning: ["docker-desktop", "Ubuntu"], wsl: { "Ubuntu:claude-usage.json": '{"at": 9}' } });
  M.files.set("/home/.local/state/pixel-hq/claude-usage.json", '{"at": 5}');
  ok(await readState("claude-usage.json") === '{"at": 9}', "yang dari WSL lebih baru, dipakai");
  ok(cats().length === 1 && cats()[0][1][1] === "Ubuntu", "cuma distro Claude yang dibaca, pakai -d");
  // status bar dan mesin kanban dalam 15 detik: satu bacaan
  await Promise.all([readState("claude-usage.json"), readState("claude-usage.json")]);
  ok(cats().length === 1, "bacaan dibagi dalam 15 dtk");
  ok((await readState("claude-usage.json", 0)) === '{"at": 9}' && cats().length === 2, "maxAge 0 baca ulang");
  // distro mati: nilai terakhir tetap dipakai, tanpa menyalakan WSL
  M.wslRunning = []; resetStateCache(true);
  ok(await readState("claude-usage.json", 0) === '{"at": 9}' && cats().length === 2, "distro mati: nilai terakhir diingat, WSL gak dinyalakan");

  W({ noWsl: true });
  M.files.set("/home/.local/state/pixel-hq/claude-usage.json", '{"at": 5}');
  ok(await readState("claude-usage.json") === '{"at": 5}', "WSL gak ada: pakai file lokal");
  await readState("claude-usage.json", 0);
  ok(M.execs.length === 1, "WSL gak ada: wsl.exe gak dicoba lagi selama 10 mnt");

  W({ platform: "linux", wslRunning: ["Ubuntu"] });
  await readState("claude-usage.json");
  ok(M.execs.length === 0, "Linux gak pernah manggil wsl.exe");
  M.platform = "linux";
}

print(`${passed} lolos, ${failed} gagal`);
if (failed) imports.system.exit(1);
