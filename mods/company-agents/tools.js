// Logika alat bantu kantor: cek Git, daftar server dev, prompt tersimpan, peringatan konteks.
// Tanpa impor "herdr", jadi bisa dites langsung.

// ---- Git (cuma baca). fsmonitor dimatikan: itu program yang bisa ditentukan config repo dan jalan waktu "git status".
const SAFE = ["-c", "core.fsmonitor=false", "--no-optional-locks"];
export const GIT_STATUS = [...SAFE, "status", "--porcelain=v2", "--branch"];
// commit di cabang lokal mana pun yang belum ada di remote mana pun (termasuk cabang tanpa upstream)
export const GIT_UNPUSHED = [...SAFE, "rev-list", "--count", "--branches", "--not", "--remotes"];
export const GIT_REMOTES = [...SAFE, "remote"];
export const GIT_FETCH = [...SAFE, "-c", "credential.interactive=false", "fetch", "--all", "--quiet"];

// Perintah git buat satu proyek. Path selalu jadi argumen sendiri, gak lewat shell.
export function gitCommand(entry, args, platform) {
  if (platform === "windows" && entry.cwd.startsWith("/"))
    return ["wsl.exe", [...(entry.distro ? ["-d", entry.distro] : []), "-e", "git", "-C", entry.cwd, ...args]];
  return ["git", ["-C", entry.cwd, ...args]];
}

export function parseGitStatus(out) {
  const r = { branch: "?", upstream: null, behind: 0, changed: 0, untracked: 0 };
  for (const line of String(out ?? "").split("\n")) {
    if (line.startsWith("# branch.head ")) r.branch = line.slice(14).trim();
    else if (line.startsWith("# branch.upstream ")) r.upstream = line.slice(18).trim();
    else if (line.startsWith("# branch.ab ")) r.behind = Number(/-(\d+)/.exec(line)?.[1] ?? 0);
    else if (/^[12u] /.test(line)) r.changed++;
    else if (line.startsWith("? ")) r.untracked++;
  }
  return r;
}

// Ringkasan satu proyek: dirty = ada yang bakal ketinggalan kalau pindah komputer.
export function gitSummary(s, unpushed, hasRemote) {
  const parts = [];
  if (s.changed) parts.push(`${s.changed} file belum commit`);
  if (s.untracked) parts.push(`${s.untracked} file baru belum dilacak`);
  if (!hasRemote) parts.push("gak punya remote");
  else if (unpushed > 0) parts.push(`${unpushed} commit belum di-push`);
  const dirty = parts.length > 0;
  if (s.behind) parts.push(`${s.behind} commit ketinggalan dari remote`);
  return { dirty, text: parts.length ? parts.join(" · ") : "aman, semua udah di-push" };
}

// ---- Server dev: keluaran "ss -ltnpH". pid/nama cuma kelihatan buat proses milik sendiri.
export function parseListeners(out) {
  const byPort = new Map();
  for (const line of String(out ?? "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f[0] !== "LISTEN" || !f[3]) continue;
    const m = /^(.*):(\d+)$/.exec(f[3]);
    if (!m) continue;
    const host = m[1].replace(/%.*$/, ""), port = Number(m[2]);
    // cuma alamat yang bisa dibuka lewat localhost; port 53 itu DNS
    if (!["0.0.0.0", "127.0.0.1", "*", "[::]", "[::1]"].includes(host) || port === 53 || port < 1 || port > 65535) continue;
    const who = /\(\("([^"]*)",pid=(\d+)/.exec(line);
    const cur = byPort.get(port);
    if (!cur || (!cur.pid && who)) byPort.set(port, { port, name: who?.[1] ?? null, pid: who ? Number(who[2]) : null });
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export const openUrlCommand = (port, platform) => {
  const url = `http://localhost:${Math.trunc(Number(port))}`;
  return platform === "windows" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] : ["xdg-open", [url]];
};

// ---- Prompt tersimpan
export const MAX_PROMPTS = 30;
export const DEFAULT_PROMPTS = [
  "Cek dulu apakah perubahan ini aman, lalu jalankan tesnya dan laporkan hasilnya apa adanya.",
  "Jelaskan apa saja yang barusan kamu ubah, singkat saja.",
  "Commit dan push perubahan ini.",
];
// Satu baris, tanpa karakter kontrol: teks yang ditempel gak boleh bisa menekan Enter atau menyelipkan escape sequence.
export const cleanPrompt = (s) => String(s ?? "").replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 2000);
export function parsePrompts(raw) {
  if (raw == null) return [...DEFAULT_PROMPTS];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map(cleanPrompt).filter(Boolean).slice(0, MAX_PROMPTS) : null; } catch { return null; }
}

// ---- Peringatan konteks: sekali tiap melewati WARN, siap lagi setelah turun di bawah REARM (mis. sehabis /compact).
export const CONTEXT_WARN = 85, CONTEXT_REARM = 70;
export function contextAlerts(warned, items) {
  const alerts = [], seen = new Set();
  for (const { address, pct } of items) {
    seen.add(address);
    if (!Number.isFinite(pct)) continue;
    if (pct >= CONTEXT_WARN && !warned.has(address)) { warned.add(address); alerts.push({ address, pct }); }
    else if (pct < CONTEXT_REARM) warned.delete(address);
  }
  for (const address of warned) if (!seen.has(address)) warned.delete(address);
  return alerts;
}
