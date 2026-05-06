@echo off
echo EDiFi Connect — Setup
echo =====================

:: Check Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
  echo ERROR: Node.js not found. Download from https://nodejs.org
  pause
  exit /b 1
)

echo Installing dependencies...
call npm install

echo Installing Playwright browser...
call npx playwright install chromium

echo Creating auto-start task...
schtasks /create /tn "EDiFi Connect" /tr "\"%CD%\start.bat\"" /sc onlogon /ru "%USERNAME%" /f >nul 2>&1
if %errorlevel% equ 0 (
  echo Auto-start task created — service will start on next login.
) else (
  echo Note: Run as administrator to enable auto-start.
)

echo.
echo Starting EDiFi Connect service...
start "" /B cmd /c "node index.js > edifi-connect.log 2>&1"

echo.
echo Setup complete! EDiFi Connect is running.
echo Open Chrome and log into your dental portals — sessions will be captured automatically.
echo.
echo Your EDiFi dashboard will show "Desktop Connected" when the link is active.
pause
