@echo off
rem Pasa las pruebas y reinicia el panel solo si pasan y no hay trabajos en marcha. Ver panel\reiniciar-panel.ps1.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0panel\reiniciar-panel.ps1" %*
if errorlevel 1 pause
