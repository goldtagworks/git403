@echo off
rem git403 install (Windows) - double-click. Safe to run again.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install.ps1"
echo.
pause
