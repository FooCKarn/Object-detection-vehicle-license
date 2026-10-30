@echo off
rem Double-click to start the PlateScan CCTV relay, then open http://localhost:8080 (see docs\CCTV.md)
cd /d "%~dp0.."
where node >nul 2>nul || (echo Node.js is not installed. Get the LTS version from https://nodejs.org & pause & exit /b 1)
start "" http://localhost:8080
node tools\cctv-relay.js %*
pause
