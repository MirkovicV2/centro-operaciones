@echo off
setlocal
cd /d "%~dp0"
set "ORCA=%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe"
if not exist "%ORCA%" set "ORCA=orca"
if not exist "%~dp0panel\data" mkdir "%~dp0panel\data"
set "OUT=%~dp0panel\data\orca-ayuda.txt"
(
echo ORCA=%ORCA%
echo === worker-start --help
"%ORCA%" orchestration worker-start --help
echo === worker-retain --help
"%ORCA%" orchestration worker-retain --help
echo === worker-release --help
"%ORCA%" orchestration worker-release --help
echo === orchestration --help
"%ORCA%" orchestration --help
echo === FIN
) > "%OUT%" 2>&1
exit /b 0
