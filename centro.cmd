@echo off
setlocal
rem Node portable del equipo del propietario. Para otra ruta, crea centro.local.cmd (no versionado)
rem con: set "OPS_NODE=C:\ruta\a\node.exe". Ver ejemplos\centro.local.example.cmd.
if exist "%~dp0centro.local.cmd" call "%~dp0centro.local.cmd"
if not defined OPS_NODE set "OPS_NODE=%USERPROFILE%\Documents\Proyectos\FlechaTrampa\.tools\node-v24.22.2-win-x64\node.exe"
if exist "%OPS_NODE%" (
  "%OPS_NODE%" "%~dp0cli.mjs" %*
) else (
  node "%~dp0cli.mjs" %*
)
