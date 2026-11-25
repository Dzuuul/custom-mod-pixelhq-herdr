// Baca file di ~/.local/state/pixel-hq. Di Windows, Claude Code yang jalan di WSL menulisnya ke home WSL,
// bukan ke home Windows yang dibaca Herdr, jadi dibaca juga dari WSL dan diambil yang paling baru.
import { exec, window, home, readTextFile } from "herdr";

const stamp = (text) => {
  try {
    const x = JSON.parse(text);
    if (Array.isArray(x)) return Number(x[x.length - 1]?.[0]) || 0;
    return Number(x?.at) || 0;
  } catch { return -1; }
};

export async function readState(rel) {
  const local = await readTextFile(`${home()}/.local/state/pixel-hq/${rel}`).catch(() => null);
  if (window()?.platform !== "windows") return local;
  const wsl = await exec("wsl.exe", ["-e", "sh", "-c", 'cat "$HOME/.local/state/pixel-hq/$1" 2>/dev/null', "sh", rel], { timeout: 8000 })
    .then((r) => (r.code === 0 && r.stdout?.trim() ? r.stdout : null)).catch(() => null);
  if (!wsl) return local;
  if (!local) return wsl;
  return stamp(wsl) > stamp(local) ? wsl : local;
}
