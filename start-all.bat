@echo off
setlocal
cd /d "%~dp0"

title ChatAI Interactive

call "%~dp0start.bat"
set "EXIT_CODE=%errorlevel%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo Launch failed with exit code %EXIT_CODE%.
    pause
)

exit /b %EXIT_CODE%
