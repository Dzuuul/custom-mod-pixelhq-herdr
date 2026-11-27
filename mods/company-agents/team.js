// Logika "tim" (proyek yang pernah dikerjakan agent) dan laporan standup. Tanpa impor "herdr", jadi bisa dites langsung.

const MAX_TEAM = 20;
const SEEN_EVERY = 60000; // lastSeen cukup diperbarui tiap menit, biar file tim gak ditulis terus
export const MAX_HISTORY = 14;
const MAX_TOPICS = 5;

export const teamKey = (e) => `${e.distro ?? ""}|${String(e.cwd).replace(/(.)[\\/]+$/, "$1")}`;

// Nama distro dari terminal yang menjalankan wsl.exe. null = bukan WSL; "" = WSL distro bawaan.
export function wslDistro(terminal) {
  const argv = terminal?.foreground?.argv;
  if (!/(^|[\\/])wsl(\.exe)?$/i.test(String(argv?.[0] ?? terminal?.foreground?.name ?? ""))) return null;
  const i = (argv ?? []).findIndex((x) => x === "-d" || x === "--distribution");
  return i >= 0 ? String(argv[i + 1] ?? "") : "";
}

// Gabungkan proyek yang lagi aktif ke daftar tim. Hasil: daftar baru (terbaru dulu), atau null kalau gak perlu ditulis.
export function rememberTeam(team, live, now) {
  const byKey = new Map(team.map((e) => [teamKey(e), e]));
  let changed = false;
  for (const e of live) {
    const key = teamKey(e), old = byKey.get(key);
    if (old && now - old.lastSeen < SEEN_EVERY && (!e.title || e.title === old.title)) continue;
    byKey.set(key, { cwd: e.cwd, distro: e.distro ?? null, folder: e.folder, title: e.title || old?.title || null, lastSeen: now });
    changed = true;
  }
  return changed ? [...byKey.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, MAX_TEAM) : null;
}

// Argumen tab.new buat membuka Claude di sebuah proyek. Path gak pernah disisipkan ke teks perintah shell.
export function openSpec(entry, resume, platform) {
  const cmd = resume ? "claude --continue" : "claude";
  // shell login + interaktif, biar PATH (mis. nvm) sama dengan terminal biasa; sesudah Claude keluar, shell-nya tetap ada
  const bash = ["bash", "-lic", `${cmd}; exec bash -i`];
  if (platform !== "windows") return { folder: entry.cwd, argv: bash };
  if (!entry.cwd.startsWith("/")) return { folder: entry.cwd, argv: ["powershell.exe", "-NoExit", "-Command", cmd] };
  return { argv: ["wsl.exe", ...(entry.distro ? ["-d", entry.distro] : []), "--cd", entry.cwd, "-e", ...bash] };
}

export function addTopic(day, folder, topic) {
  if (!topic) return;
  day.topics ??= {};
  const list = (day.topics[folder] ??= []);
  if (!list.includes(topic)) day.topics[folder] = [...list, topic].slice(-MAX_TOPICS);
}

// Simpan hari yang sudah lewat. Hari kosong gak disimpan.
export function pushHistory(history, day) {
  if (!day?.day || !(day.workMs > 0)) return history;
  return [...history.filter((d) => d.day !== day.day), day].sort((a, b) => a.day.localeCompare(b.day)).slice(-MAX_HISTORY);
}

export const spent = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}j ${m % 60}m`; };

// Teks standup: hari kerja tersimpan terakhir sebelum hari ini, lalu hari ini.
export function standupText(today, history) {
  const before = [...history].reverse().find((d) => d.day < today.day);
  const section = (label, d) => {
    const rows = Object.entries(d.byFolder ?? {}).sort((a, b) => b[1] - a[1])
      .map(([name, ms]) => `- ${name} (${spent(ms)})${d.topics?.[name]?.length ? `: ${d.topics[name].join("; ")}` : ""}`);
    return [`${label} (${d.day})`, ...(rows.length ? rows : ["- belum ada"])].join("\n");
  };
  return [...(before ? [section("Sebelumnya", before)] : []), section("Hari ini", today), "(lama = waktu agent bekerja, bukan jam kerja)"].join("\n\n");
}
