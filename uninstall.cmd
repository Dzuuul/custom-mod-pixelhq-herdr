@echo off
rem Copot custom Pixel HQ dari Herdr di Windows: klik dua kali file ini.
rem Opsi (--purge, --restore) diteruskan ke uninstall.ps1. Lihat isi uninstall.ps1.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
set "PIXELHQ_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %PIXELHQ_EXIT%
