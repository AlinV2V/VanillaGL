@echo off
setlocal
title VanillaGL Setup
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

node tools\setup-wizard.mjs
echo.
pause
exit /b

:no_node
echo.
echo VanillaGL needs Node.js (version 20.19 or newer), which is not installed.
echo.
where winget >nul 2>nul
if errorlevel 1 goto :manual_node
choice /M "Install Node.js LTS now using winget"
if errorlevel 2 goto :manual_node
winget install --exact --id OpenJS.NodeJS.LTS --accept-source-agreements
echo.
echo Node.js is installed. Close this window and double-click Setup.bat again.
echo.
pause
exit /b

:manual_node
echo Download and install the LTS version from https://nodejs.org
echo then double-click Setup.bat again.
echo.
pause
exit /b 1
