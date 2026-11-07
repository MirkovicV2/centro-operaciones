@echo off
setlocal
set "OPS_NODE=C:\Users\brank\Documents\Proyectos\FlechaTrampa\.tools\node-v24.22.2-win-x64\node.exe"
if exist "%OPS_NODE%" (
  "%OPS_NODE%" "%~dp0cli.mjs" %*
) else (
  node "%~dp0cli.mjs" %*
)
