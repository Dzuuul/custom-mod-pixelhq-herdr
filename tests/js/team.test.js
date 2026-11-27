// Tes daftar tim dan laporan standup (company-agents/team.js). Jalankan: sh tests/run-js.sh
import { teamKey, wslDistro, rememberTeam, openSpec, addTopic, pushHistory, standupText, MAX_HISTORY } from "./team.js";

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; print(`GAGAL: ${m}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

ok(wslDistro({ foreground: { argv: ["C:\\WINDOWS\\system32\\wsl.exe", "-d", "Ubuntu"] } }) === "Ubuntu", "distro dari argv");
ok(wslDistro({ foreground: { argv: ["wsl.exe"] } }) === "", "wsl tanpa -d");
ok(wslDistro({ foreground: { argv: ["claude"] } }) === null && wslDistro(undefined) === null, "bukan wsl");

const e = { cwd: "/p/indolakto", distro: "Ubuntu", folder: "Indolakto", title: "A" };
let team = rememberTeam([], [e], 1000);
ok(team.length === 1 && team[0].lastSeen === 1000, "proyek baru dicatat");
ok(rememberTeam(team, [e], 2000) === null, "belum semenit: gak ditulis");
ok(rememberTeam(team, [{ ...e, cwd: "/p/indolakto/", title: null }], 90000)[0].title === "A", "garis miring akhir = proyek sama, judul lama dipertahankan");
ok(rememberTeam(team, [{ ...e, title: "B" }], 2000)[0].title === "B", "judul berubah: ditulis");
team = rememberTeam(team, Array.from({ length: 30 }, (_, i) => ({ cwd: `/p/${i}`, folder: `P${i}` })), 5000);
ok(team.length === 20, "dibatasi 20");
ok(teamKey({ cwd: "/" }) === "|/", "root tetap utuh");

const evil = "/p/x'; rm -rf ~ #";
const w = openSpec({ cwd: evil, distro: "Ubuntu" }, true, "windows");
ok(same(w.argv, ["wsl.exe", "-d", "Ubuntu", "--cd", evil, "-e", "bash", "-lic", "claude --continue; exec bash -i"]) && !w.folder, "WSL: path jadi argumen sendiri");
ok(same(openSpec({ cwd: "/p/a", distro: "" }, false, "windows").argv.slice(0, 3), ["wsl.exe", "--cd", "/p/a"]), "WSL distro bawaan");
ok(same(openSpec({ cwd: "D:\\kerja" }, false, "windows"), { folder: "D:\\kerja", argv: ["powershell.exe", "-NoExit", "-Command", "claude"] }), "Windows asli");
ok(same(openSpec({ cwd: evil }, true, "linux"), { folder: evil, argv: ["bash", "-lic", "claude --continue; exec bash -i"] }), "Linux: path lewat folder");

const day = { day: "2026-11-27", workMs: 5400000, byFolder: { Goodday: 1800000, Indolakto: 3600000 } };
for (let i = 0; i < 8; i++) addTopic(day, "Goodday", `t${i}`);
addTopic(day, "Goodday", "t7"); addTopic(day, "Goodday", null);
ok(same(day.topics.Goodday, ["t3", "t4", "t5", "t6", "t7"]), "judul unik, maksimal 5");
ok(same(pushHistory([], { day: "2026-11-20", workMs: 0 }), []), "hari kosong gak disimpan");
let h = [];
for (let i = 1; i <= 20; i++) h = pushHistory(h, { day: `2026-11-${String(i).padStart(2, "0")}`, workMs: 60000, byFolder: { Sukro: 60000 } });
ok(h.length === MAX_HISTORY && h[h.length - 1].day === "2026-11-20", "riwayat dibatasi");
const text = standupText(day, h);
ok(text.indexOf("Sebelumnya (2026-11-20)\n- Sukro (1m)") === 0, "hari kerja sebelumnya");
ok(text.includes("Hari ini (2026-11-27)\n- Indolakto (1j 0m)\n- Goodday (30m): t3; t4; t5; t6; t7"), "urut dari yang terlama");
ok(standupText({ day: "2026-11-27", byFolder: {} }, []).startsWith("Hari ini (2026-11-27)\n- belum ada"), "laporan kosong");

print(`${passed} lolos, ${failed} gagal`);
if (failed) imports.system.exit(1);
