// Baca file di ~/.local/state/pixel-hq. Di Windows, Claude Code yang jalan di WSL menulisnya ke home WSL,
// bukan ke home Windows yang dibaca Herdr, jadi dibaca juga dari WSL dan diambil yang paling baru.
// WSL cuma dibaca dari distro yang memang lagi jalan: `wsl.exe --list --running` gak menyalakan WSL, sedangkan
// `wsl.exe -e ...` menyalakannya (dan bikin WSL gak pernah mati kalau dipanggil tiap 20 detik).
// Semua hasil di-cache di modul ini, jadi yang mengimpornya di mod yang sama (status bar dan mesin kanban) berbagi
// satu bacaan. Isi terakhir dari distro yang udah mati tetap diingat. File ini ada di company-status dan
// company-usage dengan isi yang sama (mod gak bisa impor dari folder mod lain).
import { exec, window, home, readTextFile } from "herdr";

const RUNNING_TTL = 60000;         // daftar distro yang jalan dicek ulang paling cepat tiap 1 menit
const NO_WSL_TTL = 10 * 60000;     // wsl.exe gak ada / error: coba lagi 10 menit kemudian
const FILE_TTL = 15000;            // isi file dari WSL dibaca ulang paling cepat tiap 15 detik (bawaan)
const MAX_FILES = 300;
const SKIP_DISTRO = /^docker-desktop/i; // distro bawaan Docker, bukan tempat Claude Code

const stamp = (text) => {
  try {
    const x = JSON.parse(text);
    if (Array.isArray(x)) return Number(x[x.length - 1]?.[0]) || 0;
    return Number(x?.at) || 0;
  } catch { return -1; }
};

let running = { at: 0, ttl: 0, list: [], pending: null };
const files = new Map(); // `${distro}\n${rel}` -> { at, text, pending }

// Buat tes: lupakan cache (`keepFiles`: isi file yang udah kebaca tetap diingat, cuma daftar distro yang dilupakan).
export function resetStateCache(keepFiles = false) { running = { at: 0, ttl: 0, list: [], pending: null }; if (!keepFiles) files.clear(); }

// Keluaran wsl.exe --list itu UTF-16; dibaca sebagai teks biasa jadinya ada NUL di sela hurufnya.
// Nama distro gak boleh ada spasi, jadi pesan seperti "There are no running distributions." ikut terbuang.
export const parseDistros = (out) => String(out ?? "").replace(/\u0000/g, "").replace(/\uFEFF/g, "")
  .split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[\w.-]+$/.test(l) && !SKIP_DISTRO.test(l));

function runningDistros() {
  if (running.pending) return running.pending;
  if (Date.now() - running.at < running.ttl) return Promise.resolve(running.list);
  running.pending = exec("wsl.exe", ["--list", "--running", "--quiet"], { timeout: 5000 })
    .then((r) => ({ ok: true, list: r.code === 0 ? parseDistros(r.stdout) : [] }), () => ({ ok: false, list: [] }))
    .then(({ ok, list }) => { running = { at: Date.now(), ttl: ok ? RUNNING_TTL : NO_WSL_TTL, list, pending: null }; return list; });
  return running.pending;
}

function readWsl(distro, rel, maxAge) {
  const key = `${distro}\n${rel}`;
  let c = files.get(key);
  if (!c) {
    if (files.size >= MAX_FILES) files.delete(files.keys().next().value);
    c = { at: 0, text: null, pending: null };
    files.set(key, c);
  }
  if (c.pending) return c.pending;
  if (Date.now() - c.at < maxAge) return Promise.resolve(c.text);
  c.pending = exec("wsl.exe", ["-d", distro, "-e", "sh", "-c", 'cat "$HOME/.local/state/pixel-hq/$1" 2>/dev/null', "sh", rel], { timeout: 8000 })
    .then((r) => (r.code === 0 && r.stdout?.trim() ? r.stdout : null), () => null)
    .then((text) => { c.at = Date.now(); c.pending = null; if (text) c.text = text; return c.text; });
  return c.pending;
}

// `maxAge`: isi dari WSL boleh setua ini (ms) sebelum dibaca ulang. 0 = baca sekarang.
export async function readState(rel, maxAge = FILE_TTL) {
  const local = await readTextFile(`${home()}/.local/state/pixel-hq/${rel}`).catch(() => null);
  if (window()?.platform !== "windows") return local;
  for (const d of await runningDistros()) await readWsl(d, rel, maxAge);
  let best = local;
  for (const [key, c] of files) {
    if (c.text && key.endsWith(`\n${rel}`) && (best == null || stamp(c.text) > stamp(best))) best = c.text;
  }
  return best;
}
