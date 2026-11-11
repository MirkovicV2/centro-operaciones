@echo off
cd /d "%~dp0"
if not exist panel\data mkdir panel\data
node tests\run-tests.mjs > panel\data\pruebas-resultado.txt 2>&1
findstr /B /C:"# pass" /C:"# fail" /C:"# skipped" panel\data\pruebas-resultado.txt
echo Resultado completo en panel\data\pruebas-resultado.txt
pause
