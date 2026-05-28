@echo off
title FDA Compliance Tracker
echo.
echo  ╔══════════════════════════════════════╗
echo  ║    FDA Compliance Tracker            ║
echo  ╚══════════════════════════════════════╝
echo.

cd /d "%~dp0"

if not exist "node_modules" (
  echo  Installing dependencies for first time...
  echo.
  call npm install
  echo.
)

echo  Starting server...
echo  Open your browser at: http://localhost:3000
echo  Press Ctrl+C to stop.
echo.

node server.js

pause
