// Tes mesin kanban (company-status/kanban.js): kirim sekali, STOP, model/effort, gabung tulisan dialog. Jalankan: sh tests/run-js.sh
import { M, reset } from "./mock.js";
import { KanbanEngine, patchOf, mergeInto, newAgentArgv } from "./kanban.js";

const FILE = "/cfg/pixel-hq-kanban.json";
let failed = 0, passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; print(`GAGAL: ${msg}`); } };
const board = () => JSON.parse(M.files.get(FILE)).tasks;
const put = (tasks) => M.files.set(FILE, JSON.stringify({ tasks }, null, 2));
const sends = (addr) => M.calls.filter((c) => c[0] === "send" && c[1] === addr);
const task = (o) => ({ id: "a", title: "Bikin tes", space: "s1", spaceName: "S1", column: "doing", created: 1, order: 1, startedAt: 1, ...o });

// 1. patchOf / mergeInto
{
  const p = patchOf({ a: 1, b: 2, c: 3 }, { a: 1, b: 5, d: 4 });
  ok(JSON.stringify(p) === JSON.stringify({ set: { b: 5, d: 4 }, del: ["c"] }), "patchOf set/del");
  ok(patchOf({ a: 1 }, { a: 1 }) === null, "patchOf sama = null");
  const fresh = { tasks: [{ id: "x", column: "doing", startedAt: 1, priority: "tinggi", c: 3 }, { id: "y", column: "todo" }] };
  mergeInto(fresh, [{ id: "x", before: { id: "x", column: "doing", startedAt: 1, c: 3 }, patch: { set: { sentAt: 9 }, del: ["c"] } },
    { id: "y", before: { id: "y", column: "doing" }, patch: { set: { sentAt: 9 }, del: [] } },
    { id: "z", before: { id: "z", column: "doing" }, patch: { set: { sentAt: 9 }, del: [] } }]);
  ok(fresh.tasks[0].sentAt === 9 && fresh.tasks[0].priority === "tinggi" && !("c" in fresh.tasks[0]), "merge: kunci mesin masuk, perubahan dialog tetap");
  ok(!("sentAt" in fresh.tasks[1]), "merge: task yang dipindah kolom dilewati");
}

// 2. newAgentArgv
ok(JSON.stringify(newAgentArgv({ model: "opus", effort: "high" })) === JSON.stringify(["claude", "--model", "opus", "--effort", "high"]), "argv model+effort");
ok(JSON.stringify(newAgentArgv({})) === JSON.stringify(["claude"]), "argv bawaan");

// 3. Dialog nulis waktu hc send jalan: dulu task dikirim dua kali
{
  reset();
  M.agents = [{ address: "t1", pane: "p1", space: "s1", status: "idle", app: "claude-code", program: { name: "Claude Code" }, tab_name: "Luna" }];
  put([task({})]);
  M.onHc = (args) => {
    if (args[0] !== "send") return;
    const d = JSON.parse(M.files.get(FILE));
    d.tasks.push({ id: "b", title: "Task baru dari dialog", space: "s1", column: "todo", created: 2, order: 2 });
    d.tasks[0].priority = "tinggi"; // dialog juga ganti prioritas task yang lagi dikirim
    M.files.set(FILE, JSON.stringify(d, null, 2));
    M.onHc = null;
  };
  const e = new KanbanEngine();
  await e.tick();
  let t = board();
  ok(t.length === 2, "task tambahan dari dialog gak hilang");
  ok(typeof t[0].sentAt === "number" && t[0].agent === "t1", "tanda sentAt tersimpan walau file berubah");
  ok(t[0].priority === "tinggi", "prioritas dari dialog tetap");
  M.agents[0].status = "idle";
  await e.tick();
  ok(sends("t1").length === 1, `task dikirim sekali (kenyataannya ${sends("t1").length}x)`);
}

// 4. Dialog memindah task ke antrean waktu hc send jalan: pilihan dialog menang
{
  reset();
  M.agents = [{ address: "t1", pane: "p1", space: "s1", status: "idle", app: "claude-code", program: { name: "Claude Code" } }];
  put([task({})]);
  M.onHc = () => {
    const d = JSON.parse(M.files.get(FILE));
    d.tasks[0].column = "todo"; delete d.tasks[0].startedAt; d.tasks[0].note = "";
    M.files.set(FILE, JSON.stringify(d, null, 2));
    M.onHc = null;
  };
  await new KanbanEngine().tick();
  const t = board()[0];
  ok(t.column === "todo" && !t.sentAt && !t.agent, "task yang dipindah manual gak ditimpa mesin");
}

// 5. Space tanpa agent: tab baru bawa --model/--effort
{
  reset();
  put([task({ model: "sonnet", effort: "low" })]);
  await new KanbanEngine().tick();
  const r = M.runs.find((x) => x[0] === "tab.new");
  ok(r && JSON.stringify(r[1].argv) === JSON.stringify(["claude", "--model", "sonnet", "--effort", "low"]), "tab.new pakai --model/--effort");
  ok(board()[0].byTab === "Bikin tes", "byTab dicatat");
}

// 6. STOP: mesin menekan tombol stop, kartu ditandai dihentikan, model dikembalikan
{
  reset();
  M.agents = [{ address: "t1", pane: "p1", space: "s1", status: "working", app: "claude-code", program: { name: "Claude Code" } }];
  put([task({ sentAt: 100, agent: "t1", seen: true, prevModel: "opus", stopWanted: true })]);
  const e = new KanbanEngine();
  await e.tick();
  let t = board()[0];
  ok(M.calls.some((c) => c[0] === "interrupt" && c[1] === "t1"), "hc interrupt dipanggil");
  ok(t.failed === "Dihentikan" && t.stopped === true && !t.stopWanted, "task ditandai dihentikan");
  ok(t.column === "doing", "kartu tetap di kolom jalan");
  ok(JSON.stringify(t.restore) === JSON.stringify(["/model opus"]), "perintah pengembalian model disiapkan");
  ok(e.counts.failed === 0, "yang dihentikan gak dihitung gagal");
  M.agents[0].status = "idle";
  await e.tick();
  t = board()[0];
  ok(sends("t1").some((c) => c[2] === "/model opus") && !t.restore, "model dikembalikan setelah staf nganggur");
  ok(t.column === "doing" && t.failed === "Dihentikan", "task yang dihentikan gak pindah ke selesai");
}

// 7. STOP sebelum task terkirim (gak ada agent): gak ada interrupt
{
  reset();
  put([task({ stopWanted: true })]);
  await new KanbanEngine().tick();
  ok(!M.calls.some((c) => c[0] === "interrupt"), "gak interrupt kalau belum terkirim");
  ok(board()[0].stopped === true, "tetap ditandai dihentikan");
}

// 8. Alur normal tetap jalan: kirim, kerja, kelar
{
  reset();
  M.agents = [{ address: "t1", pane: "p1", space: "s1", status: "idle", app: "claude-code", program: { name: "Claude Code" } }];
  put([task({})]);
  const e = new KanbanEngine();
  await e.tick();
  M.agents[0].status = "working"; await e.tick();
  M.agents[0].status = "idle"; await e.tick();
  const t = board()[0];
  ok(t.column === "done" && t.finishedAt && sends("t1").length === 1, "alur normal: sekali kirim lalu selesai");
}

print(`${passed} lolos, ${failed} gagal`);
if (failed) imports.system.exit(1);
