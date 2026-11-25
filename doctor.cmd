@echo off
rem Diagnosa pemasangan custom Pixel HQ di Windows: klik dua kali file ini. Gak mengubah apa pun.
rem Hasilnya disimpan ke %USERPROFILE%\pixel-hq-doctor-<waktu>.txt dan disalin ke clipboard.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0mods\company-agents\pixel-hq-doctor.ps1" %*
set "PIXELHQ_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %PIXELHQ_EXIT%
