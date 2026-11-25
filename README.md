# custom-mod-pixelhq-herdr

Versi custom dari layout **[Pixel HQ](https://github.com/bnhan2710/pixel-hq)** untuk **Herdr**:
antarmuka berbahasa Indonesia santai, papan kanban yang bisa menyuruh agent kerja, dan pemantau usage Claude Code.

> Dasarnya Pixel HQ commit `1e09cc1` (MIT). Lihat [NOTICE.md](NOTICE.md).

![Papan kanban](docs/kanban.png)

## Apa yang beda dari Pixel HQ asli

| Perubahan | Di mana |
| --- | --- |
| **Bahasa Indonesia santai/gaul** di semua tampilan: status bar, sidebar, panel, form rekrut, editor figur, lembar hotkey, notifikasi updater, nama jabatan | semua mod `company-*` |
| **Nama staf acak dan unik**: tiap terminal baru (staf baru / sesi baru) dapat nama orang, binatang, atau peliharaan yang belum dipakai staf lain | `company-agents/names.js`, `company-pane` |
| **Pencarian staf dua bahasa**: `ngetik`, `santai`, `kelar`, `nunggu` dan padanan Inggrisnya sama-sama jalan | `company-agents` |
| **Papan Kanban** (dialog 3 kolom + panel kanan) dan mesin yang mengirim task ke staf | `company-kanban`, `company-status/kanban.js`, `layouts/pixel-hq.json` |
| Tombol **KANBAN** di bar atas dan status bar (dengan jumlah task jalan dan gagal) | `company-tabs`, `company-status` |
| **Usage Claude Code**: chip `SESI`/`MINGGU` di status bar, notifikasi di 80% dan 95%, dialog riwayat dan pemakaian per staf | `company-status`, `company-usage`, `company-agents/claude-statusline.sh` |
| **Updater dari repo ini**, bukan dari Pixel HQ asli, jadi tombol update gak menimpa perubahan lokal | `company-agents/updater.js` |
| **`uninstall.sh`** untuk mencopot atau memulihkan dari backup | `uninstall.sh` |
| **MusicBox dihapus** (tombol, hotkey, mod) | `company-status`, `company-agents`, `company-hotkeys` |
| **Installer Windows** (PowerShell, tanpa Python/`sh`) + statusLine & hook aktivitas versi PowerShell | `install.cmd`, `install.ps1`, `company-agents/*.ps1` |

Yang sengaja tetap bahasa Inggris: perintah yang dikirim ke AI dari tombol "Rapikan pakai AI" di editor figur.

## Syarat

- [Herdr](https://herdr.dev) terpasang dan **sudah pernah dijalankan** (supaya `~/.config/herdr-app` ada).
- Linux/macOS: `python3` dan `sh`. Windows: cukup Windows PowerShell 5.1 (bawaan Windows 10/11),
  **tanpa** Python, `sh`, atau Git Bash.
- Opsional: Claude Code (`~/.claude`) untuk usage, hasil kerja di kanban, dan animasi aktivitas.

## Pasang (Linux/macOS)

```sh
git clone https://github.com/Dzuuul/custom-mod-pixelhq-herdr.git
cd custom-mod-pixelhq-herdr
sh install.sh
herdr-app do layout.switch '{"name":"pixel-hq"}'
herdr-app status        # "errors" harus kosong
```

`install.sh` melakukan ini, berurutan:

1. **Backup** kondisi lama ke `~/backups/herdr/sebelum-custom-pixelhq-<waktu>.tar.gz`
   (isi `~/.config/herdr-app` dan `~/.claude/settings.json`). Kalau backup gagal, pemasangan dibatalkan.
2. Menyalin `layouts/pixel-hq.json`, `themes/pixel-hq.json`, dan semua mod `company-*`
   ke `~/.config/herdr-app`. Mod `company-*` yang sudah ada **ditimpa**, file lain tidak disentuh.
3. Kalau `~/.claude` ada:
   - menyalin `pixel-hq-statusline.sh` dan menambahkan `statusLine` ke `settings.json`
     **hanya kalau belum ada** (punyamu tidak ditimpa),
   - memasang hook aktivitas lewat `claude-activity.py install` (hook lain dipertahankan).

Folder konfigurasi lain bisa dipakai lewat `HERDR_APP_HOME=/path sh install.sh`.
Setelah `git pull`, jalankan `sh install.sh` lagi untuk memasang versi terbaru.

## Pasang (Windows)

Clone repo ini di Windows, lalu **klik dua kali `install.cmd`**. Atau dari terminal (cmd/PowerShell):

```powershell
git clone https://github.com/Dzuuul/custom-mod-pixelhq-herdr.git
cd custom-mod-pixelhq-herdr
.\install.cmd
herdr-app do layout.switch --name pixel-hq
herdr-app status        # "errors" harus kosong
```

`install.cmd` hanya menjalankan `powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1`,
jadi ExecutionPolicy komputer tidak perlu diubah. Langkahnya sama dengan versi Linux:

1. **Backup** ke `%USERPROFILE%\backups\herdr\sebelum-custom-pixelhq-<waktu>.zip`
   (isi `%USERPROFILE%\.config\herdr-app` dan `.claude\settings.json`; socket `herdr-app.sock` dilewati).
2. Menyalin layout, tema, dan mod `company-*` ke `%USERPROFILE%\.config\herdr-app`
   (pakai `robocopy /MIR`, jadi isi mod disamakan persis dengan repo; file lain tidak disentuh).
3. Kalau `%USERPROFILE%\.claude` ada:
   - menyalin `claude-statusline.ps1` ke `.claude\pixel-hq-statusline.ps1` dan memasang `statusLine`
     kalau belum ada, atau kalau yang terpasang versi Pixel HQ lama (`sh ...pixel-hq-statusline.sh`, yang
     butuh Python). StatusLine milikmu sendiri tidak ditimpa,
   - memasang hook aktivitas lewat `claude-activity.ps1 install` (hook lain dipertahankan,
     `settings.json` di-backup ke `settings.json.pixel-hq.bak`).

Folder konfigurasi lain: `$env:HERDR_APP_HOME = "D:\herdr"; .\install.cmd`.

Bedanya dengan Linux, semuanya versi PowerShell (`mods/company-agents/*.ps1`), bukan `sh` + Python:

- **statusLine** (`claude-statusline.ps1`): isi dan label sama dengan `claude-statusline.sh`.
  Mod `company-agents` di Windows juga memakai skrip ini saat Herdr start, dengan perintah yang sama persis,
  jadi installer dan mod tidak saling timpa.
- **Hook aktivitas** (`claude-activity.ps1`): matcher-nya `Bash|PowerShell` (Claude Code di Windows punya
  dua tool shell). PowerShell butuh beberapa ratus ms untuk start, jadi hook yang jalan di sekitar setiap
  perintah, subagent, dan giliran dipasang **`"async": true`** (Claude Code tidak menunggunya);
  hanya `SessionStart`/`SessionEnd` yang sinkron.
- Perintahnya `powershell -NoProfile -ExecutionPolicy Bypass -File "C:/..."`, jalan baik saat Claude Code
  memakai Git Bash maupun PowerShell untuk hook.

### Dipasang ke Claude Code, bukan cuma Herdr

Dua hal ini mengubah `~/.claude/settings.json`:

- `statusLine`: menulis usage ke `~/.local/state/pixel-hq/claude-usage.json` (plus riwayatnya di
  `claude-usage-history.json`), dan label terminal Herdr (context, model, effort, token, biaya).
- hook aktivitas: label terminal untuk animasi, dan pesan terakhir agent di akhir tiap giliran
  (`~/.local/state/pixel-hq/last/<terminal>.json`) buat ditampilkan di kartu kanban.

Backup `settings.json` ada di langkah 1. `sh uninstall.sh` mencabut keduanya (lihat bawah). Di Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.config\herdr-app\mods\company-agents\claude-activity.ps1" uninstall
```

## Cara pakai Kanban

Buka lewat tombol **KANBAN** (bar atas = panel kanan, status bar = dialog lebar) atau palet perintah "Papan kanban".

1. Isi judul (dan detail), lalu pilih:
   - **SPACE**: sesi/space yang mengerjakan,
   - **STAF**: sesi terminal di space itu (pakai nama stafnya, mis. `Luna`), atau `otomatis`,
   - **MODEL** (opus/sonnet/haiku/fable) dan **EFFORT** (low…max), atau `bawaan`,
   - **PRIORITAS**: `tinggi` dikirim duluan kalau beberapa task nunggu staf yang sama,
   - **BATAS**: batas waktu (10/30/60/120 menit). Lewat batas = notifikasi + kartu ditandai, task-nya gak dihentikan,
   - **SETELAH**: task ini baru dikirim setelah task yang dipilih masuk Selesai.
2. **+ TAMBAH** → masuk kolom **Antrean**.
3. **KERJAKAN ▶** → pindah ke **Sedang dikerjakan**. Mesin (jalan tiap 3 detik selama Herdr terbuka):
   - mengirim `/model` dan `/effort` bila dipilih (hanya ke sesi Claude Code), lalu task-nya, lewat `hc send`,
   - menunggu kalau stafnya sibuk atau task yang ditunggu belum kelar,
   - membuka tab Claude baru bila space itu belum punya agent,
   - memindahkan kartu ke **Selesai** saat staf kembali nganggur, dengan notifikasi dan durasinya,
   - **mengembalikan model/effort** staf ke setelan sebelum task (lewat `/model` dan `/effort` lagi),
   - menaruh **HASIL** (pesan terakhir agent) di kartu. Klik kotaknya untuk melihat lengkap.

Di tiap kartu: **▲ ▼** mengubah urutan (di antara kartu dengan prioritas sama), **PRIO** mengganti prioritas,
**ULANGI ↻** mengirim ulang task yang gagal atau sudah selesai.

**Task gagal** ditandai merah (kartu tetap di kolom "Sedang dikerjakan") kalau: pengiriman gagal 5 kali,
stafnya hilang sebelum kelar, tab agent baru gak muncul dalam 1 menit, atau balasan agent berupa error
(`API Error`, batas usage). Notifikasi muncul dan jumlahnya tampil di tombol KANBAN.

**EKSPOR** menyimpan papan ke `pixel-hq-kanban-<waktu>.json` (bisa diimpor lagi) dan `.md` (buat dibaca)
di folder yang kamu pilih. **IMPOR** mengambil task dari file JSON ekspor: task yang sudah ada gak didobel,
space dicocokkan lewat nama, dan task yang tadinya jalan masuk Antrean dulu.

Data task ada di `~/.config/herdr-app/pixel-hq-kanban.json` (per komputer, tidak ikut repo).

**Catatan:**
- Model dikembalikan lewat alias (`opus`, `sonnet`, …) dari nama model yang dilaporkan statusline.
  Kalau sebelumnya kamu pakai versi model tertentu, hasilnya bisa versi terbaru dari keluarga yang sama.
- Hasil kerja butuh hook aktivitas terpasang (otomatis lewat `install.sh`) dan Claude Code.

## Usage Claude Code

![Usage Claude Code](docs/usage.png)

- Chip **CLAUDE · SESI · MINGGU** di status bar. Arahkan kursor untuk waktu reset, klik untuk membuka dialog.
- **Notifikasi** saat sesi 5 jam atau minggu ini lewat **80%** dan **95%**, sekali per jendela usage.
- Dialog **Usage Claude**: grafik sesi 5 jam (24 jam terakhir) dan mingguan (14 hari),
  serta tabel **per staf** (model, context, token, biaya perkiraan) untuk sesi yang lagi terbuka.
  Bisa juga dibuka dari palet perintah: "Usage Claude".

Riwayat mulai terkumpul setelah dipasang, jadi grafiknya baru terisi setelah beberapa jam pemakaian.

![Status bar](docs/statusbar.png)

## Nama staf

Tiap terminal yang belum punya nama otomatis dikasih nama acak dari daftar ±110 nama orang, binatang, dan
peliharaan (`mods/company-agents/names.js`). Nama gak boleh kembar antar staf; kalau semua nama dasar sudah
terpakai, ditambah angka (`Mochi 2`). Namanya muncul di meja staf, header panel, kanban, dan dialog usage,
dan bisa dicari lewat kotak "Cari staf".

- Mau ganti? Klik nama di header panel. Nama pilihanmu juga dijaga supaya gak kembar.
- Tersimpan di `~/.config/herdr-app/pixel-hq-names.json` (kunci = id panel), jadi nama bertahan selama panelnya ada.
- Panel yang sudah hilang lebih dari 5 menit dibuang dari file itu, supaya namanya bisa dipakai lagi.
- Ini berlaku untuk semua terminal (termasuk shell biasa), bukan cuma agent.

## Update

Updater bawaan Pixel HQ sekarang mengecek **repo ini** (`mods/company-agents/version.json` di branch `main`),
bukan Pixel HQ asli. Notifikasi update muncul kalau versi di GitHub lebih baru dari yang terpasang.
Tombol update mengunduh `layouts/`, `themes/`, dan `mods/` dari repo ini, lalu Herdr perlu direstart.

Buat yang merawat repo ini: **naikkan `version` di `mods/company-agents/version.json`** setiap merilis perubahan,
kalau gak, updater gak tahu ada versi baru. Update lewat tombol gak menyentuh `~/.claude/settings.json`;
kalau ada perubahan hook atau statusline, jalankan `sh install.sh`.

## Mencopot / memulihkan

```sh
sh uninstall.sh                  # copot mod, layout, tema, hook, dan statusLine Pixel HQ (data disimpan)
sh uninstall.sh --purge          # sekalian hapus data kanban dan riwayat usage
sh uninstall.sh --restore        # kembalikan kondisi dari backup terbaru yang dibuat install.sh
sh uninstall.sh --restore FILE   # dari backup tertentu (daftarnya: ls ~/backups/herdr/)
```

Sebelum mengubah apa pun, `uninstall.sh` juga membackup kondisi sekarang ke
`~/backups/herdr/sebelum-uninstall-pixelhq-<waktu>.tar.gz`. Hook dan `statusLine` lain milikmu gak disentuh.

Windows belum punya `uninstall`; pulihkan dari backup installer (ganti `<waktu>` dengan nama file backup-nya):
`Expand-Archive "$env:USERPROFILE\backups\herdr\sebelum-custom-pixelhq-<waktu>.zip" -DestinationPath $env:USERPROFILE -Force`

Kembali ke Pixel HQ asli: `sh uninstall.sh`, lalu pasang dari <https://github.com/bnhan2710/pixel-hq>.

## Susunan repo

```
layouts/pixel-hq.json     layout (sudah ada blok `kanban` di panel kanan)
themes/pixel-hq.json      tema
mods/company-*/           mod Pixel HQ + perubahan lokal
mods/company-usage/       dialog usage Claude (riwayat dan per staf)
install.sh / uninstall.sh pasang, copot, pulihkan (Linux/macOS)
install.cmd, install.ps1  pemasang Windows
docs/                     gambar README
```

## Peringatan

- Fitur kanban, usage, dan nama staf diuji di Linux (WSL2 dan Linux desktop). Pesan `MESA/EGL` di WSL itu noise GPU, bukan error.
- Installer Windows diuji di Windows 11 (PowerShell 5.1) dengan folder home tiruan: backup, salin mod, statusLine, dan hook
  (termasuk lewat Git Bash, cmd, dan PowerShell), tapi belum di sesi Claude Code sungguhan.
- **Di Windows, sebagian fitur baru belum jalan**: `claude-statusline.ps1` dan `claude-activity.ps1` belum ikut diperbarui,
  jadi **HASIL kerja di kartu kanban**, **grafik riwayat usage**, dan **token/biaya per staf** belum terisi di sana.
  Kanban, nama staf, notifikasi usage 80%/95%, dan terjemahan tetap jalan.
- Di Windows, sebagian fitur bawaan Pixel HQ yang memakai `sh`/`python3` (worktree crew, plugin Hermes,
  vitals Codex/Antigravity) tetap butuh alat itu; installer ini tidak mengubahnya.

## Lisensi

MIT, hak cipta asli bnhan2710 dipertahankan di [LICENSE](LICENSE). Lihat [NOTICE.md](NOTICE.md).
