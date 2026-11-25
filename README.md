# custom-mod-pixelhq-herdr

Versi custom dari layout **[Pixel HQ](https://github.com/bnhan2710/pixel-hq)** untuk **Herdr**:
antarmuka berbahasa Indonesia santai, papan kanban yang bisa menyuruh agent kerja, dan chip usage Claude Code
di status bar.

> Dasarnya Pixel HQ commit `1e09cc1` (MIT). Lihat [NOTICE.md](NOTICE.md).

## Apa yang beda dari Pixel HQ asli

| Perubahan | Di mana |
| --- | --- |
| **Bahasa Indonesia santai/gaul** untuk status bar, sidebar, panel, form rekrut, tooltip, dll. | `company-status`, `-spaces`, `-pane`, `-brand`, `-tabs`, `-switcher`, `-toast`, `-agents` |
| **Chip usage Claude Code** di status bar: `SESI` (5 jam) dan `MINGGU`, dengan bar dan tooltip waktu reset | `company-status`, `company-agents/claude-statusline.sh` |
| **Papan Kanban** (dialog 3 kolom + panel kanan) dan mesin yang mengirim task ke staf | `company-kanban`, `company-status/kanban.js`, `layouts/pixel-hq.json` |
| Tombol **KANBAN** di bar atas dan status bar | `company-tabs`, `company-status` |
| **MusicBox dihapus** (tombol, hotkey, mod) | `company-status`, `company-agents`, `company-hotkeys` |

Yang **masih bahasa Inggris**: editor figur, lembar hotkey, jendela updater, nama jabatan ("Staff Engineer"),
dan kata kunci pencarian.

## Syarat

- [Herdr](https://herdr.dev) terpasang dan **sudah pernah dijalankan** (supaya `~/.config/herdr-app` ada).
- `python3` dan `sh`.
- Opsional: Claude Code (`~/.claude`) untuk chip usage dan animasi aktivitas.

## Pasang

```sh
git clone https://github.com/Dzuuul/custom-mod-pixelhq-herdr.git
cd custom-mod-pixelhq-herdr
sh install.sh
herdr-app do layout.switch '{"name":"pixel-hq"}'
herdr-app status        # "errors" harus kosong
```

`install.sh` melakukan ini, berurutan:

1. **Backup** kondisi lama ke `~/backups/herdr/sebelum-custom-pixelhq-<waktu>.tar.gz`
   (isi `~/.config/herdr-app` dan `~/.claude/settings.json`).
2. Menyalin `layouts/pixel-hq.json`, `themes/pixel-hq.json`, dan semua mod `company-*`
   ke `~/.config/herdr-app`. Mod `company-*` yang sudah ada **ditimpa**, file lain tidak disentuh.
3. Kalau `~/.claude` ada:
   - menyalin `pixel-hq-statusline.sh` dan menambahkan `statusLine` ke `settings.json`
     **hanya kalau belum ada** (punyamu tidak ditimpa),
   - memasang hook aktivitas lewat `claude-activity.py install` (hook lain dipertahankan).

Folder konfigurasi lain bisa dipakai lewat `HERDR_APP_HOME=/path sh install.sh`.

### Dipasang ke Claude Code, bukan cuma Herdr

Dua hal ini mengubah `~/.claude/settings.json`: `statusLine` (menulis data usage ke
`~/.local/state/pixel-hq/claude-usage.json`) dan hook aktivitas (menulis label terminal Herdr).
Backup `settings.json` ada di langkah 1, dan `python3 ~/.config/herdr-app/mods/company-agents/claude-activity.py uninstall`
mencabut hanya hook milik Pixel HQ.

## Cara pakai Kanban

Buka lewat tombol **KANBAN** (bar atas = panel kanan, status bar = dialog lebar) atau palet perintah "Papan kanban".

1. Isi judul (dan detail), lalu pilih:
   - **SPACE**: sesi/space yang mengerjakan,
   - **STAF**: sesi terminal di space itu (nama tab, mis. `infra`, `backend`), atau `otomatis`,
   - **MODEL** (opus/sonnet/haiku/fable) dan **EFFORT** (low…max), atau `bawaan`.
2. **+ TAMBAH** → masuk kolom **Antrean**.
3. **KERJAKAN ▶** → pindah ke **Sedang dikerjakan**. Mesin (jalan tiap 3 detik selama Herdr terbuka):
   - mengirim `/model` dan `/effort` bila dipilih (hanya ke sesi Claude Code), lalu task-nya, lewat `hc send`,
   - menunggu kalau stafnya sibuk,
   - membuka tab Claude baru bila space itu belum punya agent,
   - memindahkan kartu ke **Selesai** dan memunculkan notifikasi saat staf kembali nganggur.

Data task ada di `~/.config/herdr-app/pixel-hq-kanban.json` (per komputer, tidak ikut repo).

**Catatan:** `/model` dan `/effort` mengubah sesi itu seterusnya, tidak dikembalikan setelah task selesai.
Jalur pengiriman model/effort bergantung pada versi Claude Code kamu; coba dulu dengan task kecil.

## Susunan repo

```
layouts/pixel-hq.json     layout (sudah ada blok `kanban` di panel kanan)
themes/pixel-hq.json      tema
mods/company-*/           mod Pixel HQ + perubahan lokal
install.sh                pemasang
```

## Memulihkan / mencopot

- Pulihkan dari backup yang dibuat installer: `tar xzf ~/backups/herdr/sebelum-custom-pixelhq-*.tar.gz -C ~`
- Kembali ke Pixel HQ asli: pasang ulang dari <https://github.com/bnhan2710/pixel-hq>.

## Peringatan

- Tombol **Update now** dari updater Pixel HQ menimpa semua perubahan di repo ini.
  Kalau muncul "Update installed", jangan restart Herdr sebelum yakin.
- Hanya diuji di Linux (WSL2). Pesan `MESA/EGL` di WSL itu noise GPU, bukan error.

## Lisensi

MIT, hak cipta asli bnhan2710 dipertahankan di [LICENSE](LICENSE). Lihat [NOTICE.md](NOTICE.md).
