// Tes alat bantu kantor (company-agents/tools.js) dan penahan antrean kanban. Jalankan: sh tests/run-js.sh
import { M, reset } from "./mock.js";
import { KanbanEngine } from "./kanban.js";
import { gitCommand, GIT_STATUS, parseGitStatus, gitSummary, parseListeners, openUrlCommand, cleanPrompt, parsePrompts, DEFAULT_PROMPTS, contextAlerts } from "./tools.js";

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; print(`GAGAL: ${m}`); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Git
const evil = "/p/a'; rm -rf ~";
const [cmd, args] = gitCommand({ cwd: evil, distro: "Ubuntu" }, GIT_STATUS, "windows");
ok(cmd === "wsl.exe" && same(args.slice(0, 6), ["-d", "Ubuntu", "-e", "git", "-C", evil]), "WSL: tanpa shell, path utuh");
ok(args.includes("core.fsmonitor=false") && args.includes("--no-optional-locks"), "fsmonitor mati, gak ngunci index");
ok(gitCommand({ cwd: "D:\\x" }, GIT_STATUS, "windows")[0] === "git" && gitCommand({ cwd: "/p" }, GIT_STATUS, "linux")[0] === "git", "git asli");
const s = parseGitStatus("# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n1 .M N... a\n2 R. N... b\nu UU c\n? d\n");
ok(s.branch === "main" && s.changed === 3 && s.untracked === 1 && s.behind === 3, "baca porcelain v2");
ok(gitSummary(s, 2, true).dirty && gitSummary(s, 2, true).text.includes("2 commit belum di-push"), "kotor");
const clean = parseGitStatus("# branch.head main\n# branch.ab +0 -4\n");
ok(!gitSummary(clean, 0, true).dirty && gitSummary(clean, 0, true).text.includes("4 commit ketinggalan"), "ketinggalan bukan berarti ada yang belum disimpan");
ok(gitSummary(parseGitStatus(""), 5, false).text === "gak punya remote", "tanpa remote");

// Server
const ss = `LISTEN 0 4096 127.0.0.1:8787 0.0.0.0:* users:(("proxy",pid=793,fd=15))
LISTEN 0 1000 10.255.255.254:53 0.0.0.0:*
LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*
LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*
LISTEN 0 4096 [::]:3000 [::]:*
LISTEN 0 511 *:3002 *:* users:(("next-server (v1",pid=13176,fd=21))
LISTEN 0 100 192.168.1.5:9000 0.0.0.0:*`;
ok(same(parseListeners(ss), [{ port: 3000, name: null, pid: null }, { port: 3002, name: "next-server (v1", pid: 13176 }, { port: 8787, name: "proxy", pid: 793 }]), "port unik, cuma yang bisa lewat localhost");
ok(same(openUrlCommand("3000", "windows")[1], ["url.dll,FileProtocolHandler", "http://localhost:3000"]) && openUrlCommand(3000, "linux")[0] === "xdg-open", "buka browser");

// Prompt
ok(cleanPrompt(" a\r\nb\u001b[201~\u0007 ") === "a b[201~", "satu baris tanpa karakter kontrol");
ok(same(parsePrompts(null), DEFAULT_PROMPTS) && parsePrompts("{rusak") === null && parsePrompts("{}") === null, "file rusak gak ditimpa");
ok(same(parsePrompts('["x","","y\\nz"]'), ["x", "y z"]), "daftar dibersihkan");

// Konteks
const warned = new Set(), at = (pct) => contextAlerts(warned, [{ address: "t1", pct }]).length;
ok(at(80) === 0 && at(86) === 1 && at(90) === 0 && at(75) === 0 && at(88) === 0 && at(20) === 0 && at(85) === 1, "sekali per lewat batas");
contextAlerts(warned, []);
ok(warned.size === 0, "staf yang pergi dilupakan");

// Kanban: staf yang lagi nanya gak dikirimi task antrean
{
  reset();
  M.agents = [{ address: "t1", pane: "p1", space: "s1", status: "done", app: "claude-code", program: { name: "Claude Code" } }];
  M.files.set("/home/.local/state/pixel-hq/last/t1.json", JSON.stringify({ at: 100, text: "Mau saya hapus file lama?" }));
  const FILE = "/cfg/pixel-hq-kanban.json";
  M.files.set(FILE, JSON.stringify({ tasks: [{ id: "a", title: "Tugas antrean", space: "s1", column: "doing", created: 1, order: 1, startedAt: 1 }] }, null, 2));
  const sent = () => M.calls.filter((c) => c[0] === "send").length;
  await new KanbanEngine().tick();
  let t = JSON.parse(M.files.get(FILE)).tasks[0];
  ok(sent() === 0 && t.held && /lagi nanya/.test(t.note), "ditahan waktu staf nanya");
  const d = JSON.parse(M.files.get(FILE)); d.tasks[0].noHold = true; M.files.set(FILE, JSON.stringify(d, null, 2));
  await new KanbanEngine().tick();
  t = JSON.parse(M.files.get(FILE)).tasks[0];
  ok(sent() === 1 && !t.held && t.sentAt, "KIRIM AJA tetap mengirim");
}

print(`${passed} lolos, ${failed} gagal`);
if (failed) imports.system.exit(1);
