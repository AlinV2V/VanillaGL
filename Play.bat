@echo off
setlocal
title VanillaGL
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Double-click Setup.bat first.
  pause
  exit /b 1
)

node tools\play.mjs
echo.
pause
