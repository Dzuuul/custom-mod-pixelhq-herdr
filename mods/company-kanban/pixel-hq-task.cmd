@echo off
setlocal
rem pixel-hq-task versi Windows: tambah task ke kanban Pixel HQ dari terminal. Lihat pixel-hq-task.ps1.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0pixel-hq-task.ps1" %*
set "PIXELHQ_RC=%ERRORLEVEL%"
rem kode 5 = powershell.exe -File menolak argumen "-" sendirian (keluar tanpa pesan, sebelum skripnya jalan)
if "%PIXELHQ_RC%"=="5" echo pixel-hq-task: argumen "-" sendirian gak bisa lewat sini. Buat detail dari stdin pakai -Stdin, contoh: git diff ^| pixel-hq-task -Stdin "judul" 1>&2
exit /b %PIXELHQ_RC%
