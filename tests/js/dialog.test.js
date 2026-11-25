// Tes dialog kanban (company-kanban/main.js): mutate() dan waitsFor(), diambil dari sumbernya. Jalankan: sh tests/run-js.sh
import { M, reset, readTextFile, writeTextFile } from "./mock.js";
import GLib from "gi://GLib";

const [okRead, bytes] = GLib.file_get_contents(ARGV[0]);
const src = new TextDecoder().decode(bytes);
const grab = (start, end) => { const a = src.indexOf(start); const b = src.indexOf(end, a); if (a < 0 || b < 0) throw new Error(`gak ketemu: ${start}`); return src.slice(a, b + end.length); };
const code = [grab("const waitsFor =", "\n};"), grab("async function mutate(fn) {", "\n}")].join("\n");
const mod = new Function("readTextFile", "writeTextFile", "file", `${code}\nreturn { waitsFor, mutate };`)(readTextFile, writeTextFile, () => "/cfg/k.json");

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

print(`${passed} lolos, ${failed} gagal`);
if (failed) imports.system.exit(1);
