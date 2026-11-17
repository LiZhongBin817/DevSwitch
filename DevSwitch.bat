@echo off
title DevSwitch
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

set OPEN_BROWSER=1
node server.js

set EXITCODE=%errorlevel%
if "%EXITCODE%"=="2" goto ALREADYRUNNING
if not "%EXITCODE%"=="0" goto FAILED

echo.
echo [DevSwitch] stopped.
echo.
pause
exit /b 0

:ALREADYRUNNING
rem Exit code 2 = panel was already running; it has been opened in the browser.
rem Nothing to report, just close this window.
exit /b 0

:FAILED
echo.
echo [DevSwitch] exited with code %EXITCODE%
echo.
echo   If it says the port is used by another program, either:
echo     1) Close that program, then run this file again, OR
echo     2) Use another port:
echo          set PORT=5000 ^&^& node server.js
echo        then open http://localhost:5000
echo.
echo   If you closed this window or pressed Ctrl+C yourself,
echo   that is normal - the code above is just the shutdown code.
echo.
pause
exit /b 1

:NONODE
echo.
echo   [X] Node.js not found.
echo.
echo       Install Node.js 18 or newer from https://nodejs.org
echo       (download the LTS build), then close this window
echo       and double-click this file again.
echo.
pause
exit /b 1
