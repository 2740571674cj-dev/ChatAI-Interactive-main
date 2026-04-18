@echo off
setlocal
cd /d "%~dp0"

title ChatAI Interactive

if exist "%~dp0node_modules" (
    echo Starting from source with npm...
    call npm start
    exit /b %errorlevel%
)

set "PACKAGED_EXE=%~dp0dist-electron\win-unpacked\ChatAI Interactive.exe"

if exist "%PACKAGED_EXE%" (
    echo node_modules not found. Starting packaged app...
    start "" "%PACKAGED_EXE%"
    exit /b 0
)

echo Packaged app not found:
echo   "%PACKAGED_EXE%"
echo.
echo Install dependencies first, then run:
echo   npm install
echo   npm start
echo.
echo Or build the EXE version:
echo   npm run build
pause
exit /b 1
