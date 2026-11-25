@echo off
rem pixel-hq-task versi Windows: tambah task ke kanban Pixel HQ dari terminal. Lihat pixel-hq-task.ps1.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0pixel-hq-task.ps1" %*
exit /b %ERRORLEVEL%
