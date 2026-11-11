@echo off
cd /d "%~dp0"
set "ZIP=%~1"
if "%ZIP%"=="" set /p ZIP=Arrastra aqui el .zip o la carpeta y pulsa Enter: 
set "ZIP=%ZIP:"=%"
set /p ALCANCE=Para quien: agency, games, global o el id de un proyecto [agency]: 
if "%ALCANCE%"=="" set "ALCANCE=agency"
node references.mjs importar "%ZIP%" --para %ALCANCE%
echo.
node references.mjs listar
pause
