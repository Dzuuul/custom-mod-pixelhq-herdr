@echo off
rem Pasang custom Pixel HQ ke Herdr di Windows: klik dua kali file ini.
rem Menjalankan install.ps1 tanpa perlu mengubah ExecutionPolicy komputer.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set "PIXELHQ_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %PIXELHQ_EXIT%
