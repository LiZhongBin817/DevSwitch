@echo off
title DevSwitch Demo
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

set OPEN_BROWSER=1
node start-demo.js

set EXITCODE=%errorlevel%
if not "%EXITCODE%"=="0" goto FAILED

echo.
echo [Demo] finished.
echo.
pause
exit /b 0

:FAILED
echo.
echo [Demo] exited with code %EXITCODE%
echo   Port 4599 or 8081 is probably taken.
echo   Close the other window and run this again.
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
