@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0panel\start-panel.ps1"
if errorlevel 1 pause
