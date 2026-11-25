@echo off
rem Copot custom Pixel HQ dari Herdr di Windows: klik dua kali file ini.
rem Pilihan (dari terminal): uninstall.cmd -Purge, uninstall.cmd -Restore [file.zip], uninstall.cmd -Help
rem Menjalankan uninstall.ps1 tanpa perlu mengubah ExecutionPolicy komputer.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
set "PIXELHQ_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %PIXELHQ_EXIT%
