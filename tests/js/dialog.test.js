// Tes dialog kanban (company-kanban/main.js): mutate() dan waitsFor(), diambil dari sumbernya. Jalankan: sh tests/run-js.sh
import { M, reset, readTextFile, writeTextFile } from "./mock.js";
import GLib from "gi://GLib";

const [okRead, bytes] = GLib.file_get_contents(ARGV[0]);
const src = new TextDecoder().decode(bytes);
const grab = (start, end) => { const a = src.indexOf(start); const b = src.indexOf(end, a); if (a < 0 || b < 0) throw new Error(`gak ketemu: ${start}`); return src.slice(a, b + end.length); };
const code = [grab("const waitsFor =", "\n};"), grab("async function mutate(fn) {", "\n}"), grab("function parseClock(s) {", "\n}"), grab("function nextRun(atTime, repeat, fromMs) {", "\n}")].join("\n");
const mod = new Function("readTextFile", "writeTextFile", "file", `${code}\nreturn { waitsFor, mutate, parseClock, nextRun };`)(readTextFile, writeTextFile, () => "/cfg/k.json");
const engine = await import("./kanban.js");

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; print(`GAGAL: ${m}`); } };

// waitsFor: rantai a <- b <- c
const T = [{ id: "a" }, { id: "b", after: "a" }, { id: "c", after: "b" }, { id: "d" }];
const byId = new Map(T.map((x) => [x.id, x]));
ok(mod.waitsFor(T[2], "a", byId) === true, "c nunggu a lewat b");
ok(mod.waitsFor(T[1], "a", byId) === true, "b nunggu a");
ok(mod.waitsFor(T[3], "a", byId) === false, "d gak nunggu a");
ok(mod.waitsFor(T[0], "c", byId) === false, "a gak nunggu c");
const loop = new Map([["x", { id: "x", after: "y" }], ["y", { id: "y", after: "x" }]]);
ok(mod.waitsFor(loop.get("x"), "z", loop) === false, "rantai melingkar gak bikin macet");

// mutate: mesin nulis di sela baca dan tulis -> diulang di atas isi baru
reset();
M.files.set("/cfg/k.json", JSON.stringify({ tasks: [{ id: "a", title: "x" }] }));
let first = true;
const d = await mod.mutate((d) => {
  if (first) { first = false; M.files.set("/cfg/k.json", JSON.stringify({ tasks: [{ id: "a", title: "x", sentAt: 5 }] })); }
  d.tasks.push({ id: "b" });
});
const saved = JSON.parse(M.files.get("/cfg/k.json")).tasks;
ok(saved.length === 2 && saved[0].sentAt === 5 && saved[1].id === "b", "klik dialog gak hilang dan tulisan mesin gak ketimpa");
ok(d.tasks.length === 2, "mutate mengembalikan isi yang disimpan");

// jam mulai: dialog dan mesin menghitung sama persis
for (const x of ["9:05", "22.30", "24:00", "", "7:3", "23:59"]) ok(mod.parseClock(x) === engine.parseClock(x), `parseClock("${x}") sama`);
const base = new Date(2026, 10, 27, 10, 0).getTime();
for (const [at, rep] of [["09:00", "kerja"], ["11:00", undefined], ["09:00", "harian"], ["00:00", "kerja"], ["23:59", ""]]) {
  for (const from of [base, base + 2 * 86400000, base + 13 * 3600000]) ok(mod.nextRun(at, rep, from) === engine.nextRun(at, rep, from), `nextRun(${at}, ${rep}) sama`);
}

print(`${passed} lolos, ${failed} gagal`);
if (failed) imports.system.exit(1);
