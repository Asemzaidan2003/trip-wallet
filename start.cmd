@echo off
rem One-click start for Windows: database, then the app, then the browser.
cd /d "%~dp0"

where docker >nul 2>nul || (echo Docker is not installed. Install Docker Desktop first. & pause & exit /b 1)
docker info >nul 2>nul || (
  echo Starting Docker Desktop, please wait...
  start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
  for /l %%i in (1,1,60) do (docker info >nul 2>nul && goto docker_ready) & timeout /t 2 >nul
  echo Docker did not start. Open Docker Desktop yourself, then run this file again. & pause & exit /b 1
)
:docker_ready

if not exist node_modules (echo Installing packages... & call npm install --no-audit --no-fund || (pause & exit /b 1))
if not exist .env copy .env.example .env >nul

rem Already running? Just open it.
curl -s -o nul http://localhost:3000/api/session && (
  echo Trip Wallet is already running. Opening it...
  start "" http://localhost:3000
  exit /b 0
)

echo Starting the database...
docker compose up -d --wait || (echo The database did not start. & pause & exit /b 1)

start "" http://localhost:3000
echo Trip Wallet is running at http://localhost:3000  (close this window to stop it)
call npm start
pause
