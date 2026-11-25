// Nama staf otomatis: tiap terminal (panel) yang belum punya nama dikasih nama orang/binatang/peliharaan acak.
// Nama gak boleh kembar antar staf. Disimpan di pixel-hq-names.json (kunci = id panel), file yang sama dengan
// nama dan jabatan yang diubah lewat header panel (company-pane), jadi nama bikinan kamu tetap menang.
// Entri otomatis ditandai `auto: true`; kalau panelnya udah lama ilang, entri itu dibuang biar namanya bisa dipakai lagi.

export const NAMES = [
  // orang
  "Budi", "Siti", "Agus", "Dewi", "Rina", "Joko", "Wati", "Eko", "Sari", "Tono", "Lina", "Dimas", "Putri", "Bayu", "Citra",
  "Fajar", "Mega", "Rizki", "Nadia", "Hendra", "Yuni", "Andi", "Maya", "Rudi", "Intan", "Galih", "Tika", "Wawan", "Bagas", "Ayu",
  "Danu", "Sinta", "Gilang", "Lestari", "Ucok", "Made", "Wayan", "Tiara", "Rama", "Nina", "Aldi", "Vina", "Kiki", "Reza", "Dian",
  "Farhan", "Salsa", "Yoga", "Mira", "Teguh",
  // binatang
  "Kancil", "Komodo", "Harimau", "Elang", "Badak", "Bekantan", "Musang", "Tapir", "Jalak", "Murai", "Kakaktua", "Penyu",
  "Gajah", "Banteng", "Rusa", "Luwak", "Bunglon", "Cenderawasih", "Trenggiling", "Rangkong", "Pesut", "Anoa", "Lutung",
  "Kukang", "Walet", "Belibis", "Ikan Koi", "Kumbang", "Capung", "Kunang",
  // peliharaan
  "Mochi", "Kopi", "Bubu", "Oreo", "Cimol", "Pudding", "Boba", "Nugget", "Tempe", "Bakpao", "Cilok", "Donat", "Kiwi", "Momo",
  "Ciko", "Belang", "Manis", "Miko", "Coklat", "Tuyul", "Pelangi", "Cemong", "Gembul", "Si Pus", "Molly", "Bruno", "Luna",
  "Simba", "Nala", "Tobi",
];

const GONE_MS = 5 * 60 * 1000;

// cur: isi pixel-hq-names.json ({ [pane]: { name?, role?, auto? } }); paneIds: panel terminal yang hidup sekarang;
// missing: Map pane -> kapan pertama kali gak kelihatan (dipegang pemanggil antar-panggilan); rnd: buat uji.
// Mengembalikan { names, changed }; `cur` gak diubah.
export function assignNames(cur, paneIds, now, missing, rnd = Math.random) {
  const names = { ...cur };
  let changed = false;
  const live = new Set(paneIds);
  for (const [pane, v] of Object.entries(names)) {
    if (live.has(pane)) { missing.delete(pane); continue; }
    if (v && v.auto && !v.role) {
      const since = missing.get(pane) ?? now;
      missing.set(pane, since);
      if (now - since > GONE_MS) { delete names[pane]; missing.delete(pane); changed = true; }
    }
  }
  const used = new Set(Object.values(names).map((v) => String(v?.name ?? "").trim().toLowerCase()).filter(Boolean));
  for (const pane of paneIds) {
    if (names[pane]?.name) continue;
    const free = NAMES.filter((n) => !used.has(n.toLowerCase()));
    let name;
    if (free.length) name = free[Math.floor(rnd() * free.length)];
    else {
      // semua nama dasar kepakai: tambah angka biar tetap beda
      const base = NAMES[Math.floor(rnd() * NAMES.length)];
      let i = 2;
      while (used.has(`${base} ${i}`.toLowerCase())) i++;
      name = `${base} ${i}`;
    }
    names[pane] = { ...(names[pane] ?? {}), name, auto: true };
    used.add(name.toLowerCase());
    changed = true;
  }
  return { names, changed };
}

// Nama yang dipilih orang (lewat header panel) juga gak boleh kembar: kalau udah dipakai staf lain, tambah angka.
export function uniqueName(names, pane, wanted) {
  const taken = new Set(Object.entries(names).filter(([p]) => p !== pane).map(([, v]) => String(v?.name ?? "").trim().toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  let i = 2;
  while (taken.has(`${wanted} ${i}`.toLowerCase())) i++;
  return `${wanted} ${i}`;
}
