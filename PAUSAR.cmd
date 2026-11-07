@echo off
setlocal
if not exist "%~dp0data" mkdir "%~dp0data"
type nul > "%~dp0data\PAUSE"
echo Pausa solicitada. La cola dejara de tomar trabajos nuevos.
echo Una tarea ya iniciada puede terminar antes de detener el ejecutor.
