// Pengganti modul "herdr" buat tes JS mod di gjs: tests/run-js.sh menyalin mod ke folder sementara dengan import "herdr" diganti ke file ini.
export const M = {
  files: new Map(),
  agents: [],
  labels: {},
  calls: [],      // panggilan hc
  runs: [],       // panggilan run()
  notes: [],      // notify()
  onHc: null,     // (args) => void, dipanggil sebelum hc selesai (buat simulasi dialog nulis di sela-sela)
  hcCode: 0,
  spaces: [{ id: "s1", name: "S1", active: true, tabs: [{ id: "tab1" }] }, { id: "s2", name: "Api", active: false, tabs: [{ id: "tab2" }] }],
  panes: [{ pane: "p9", terminal: "t9", tab: "tab2" }],
  screens: {},    // hc read <alamat> -> teks layar
  shared: {},     // shared()/setShared()
  onExec: null,   // (cmd, args, opts) => hasil exec selain wsl.exe (git, sh, curl, powershell)
  windowActive: false,
};
export const reset = () => {
  M.files.clear(); M.agents = []; M.labels = {}; M.calls = []; M.runs = []; M.notes = []; M.onHc = null; M.hcCode = 0;
  M.screens = {}; M.shared = {}; M.onExec = null; M.windowActive = false; M.execs = [];
  M.spaces = [{ id: "s1", name: "S1", active: true, tabs: [{ id: "tab1" }] }, { id: "s2", name: "Api", active: false, tabs: [{ id: "tab2" }] }];
  M.panes = [{ pane: "p9", terminal: "t9", tab: "tab2" }];
};
export const spaces = () => M.spaces;
export const panes = () => M.panes;
export const agents = () => M.agents;
export const terminals = () => M.agents.map((a) => ({ address: a.address, labels: M.labels[a.address] ?? {} }));
export const shared = (k) => M.shared[k];
export const setShared = (k, v) => { M.shared[k] = v; return null; };
export const appHome = () => "/cfg";
export const home = () => "/home";
export async function hc(args) {
  M.calls.push(args); if (M.onHc) M.onHc(args);
  if (args[0] === "read") return { code: 0, stdout: JSON.stringify({ text: M.screens[args[1]] ?? "" }), stderr: "" };
  return { code: M.hcCode, stdout: "", stderr: "" };
}
export const run = (name, args) => { M.runs.push([name, args]); return null; };
export const notify = (n) => { M.notes.push(n); return "n"; };
export async function readTextFile(p) { return M.files.has(p) ? M.files.get(p) : null; }
export async function writeTextFile(p, text, expected) {
  const cur = M.files.has(p) ? M.files.get(p) : null;
  if (cur !== expected) throw new Error("stale snapshot");
  M.files.set(p, text);
  return null;
}
// state.js (baca file state, di Windows juga dari WSL). wsl.exe tiruan:
//   --list --running --quiet -> M.wslRunning (UTF-16 kayak aslinya: NUL di sela huruf), atau gagal kalau M.noWsl
//   -d <distro> -e sh -c ... <rel> -> M.wsl["<distro>:<rel>"]
M.platform = "linux"; M.execs = []; M.wsl = {}; M.wslRunning = []; M.noWsl = false;
export const window = () => ({ platform: M.platform, active: M.windowActive, visible: true });
const utf16 = (t) => [...t].map((c) => c + "\u0000").join("");
export async function exec(cmd, args, opts) {
  M.execs.push([cmd, args, opts ?? {}]);
  if (cmd !== "wsl.exe" || (args[0] !== "--list" && args[0] !== "-d")) return M.onExec ? M.onExec(cmd, args, opts ?? {}) : { code: 1, stdout: "", stderr: "" };
  if (M.noWsl) throw new Error("wsl.exe gak ada");
  if (args[0] === "--list") return { code: 0, stdout: utf16("\uFEFF" + M.wslRunning.join("\r\n") + "\r\n") };
  const d = args[args.indexOf("-d") + 1], rel = args[args.length - 1], key = `${d}:${rel}`;
  return key in M.wsl ? { code: 0, stdout: M.wsl[key] } : { code: 1, stdout: "" };
}
