@echo off
title EDiFi Connect Setup
color 0A
echo.
echo  ============================================
echo   EDiFi Connect Setup
echo   Elite Dental Force
echo  ============================================
echo.

:: Check if already installed
if exist "%APPDATA%\EDiFiConnect\config.json" (
  echo EDiFi Connect is already installed.
  echo.
  set /p REINSTALL="Reinstall? (Y/N): "
  if /i "%REINSTALL%" neq "Y" exit /b 0
  echo Reinstalling...
  taskkill /F /IM "node.exe" /FI "WINDOWTITLE eq EDiFiConnect*" >nul 2>&1
)

:: Verify required files are present
if not exist "node.exe" (
  echo.
  echo  ERROR: node.exe not found.
  echo  Please re-download EDiFiConnect-Setup.zip from the release page
  echo  and extract all files before running this installer.
  echo.
  pause
  exit /b 1
)
if not exist "index.js" (
  echo  ERROR: index.js not found. Re-download and extract all files.
  pause
  exit /b 1
)

:: Create install directory
set INSTALL_DIR=%APPDATA%\EDiFiConnect
echo Installing to: %INSTALL_DIR%
mkdir "%INSTALL_DIR%" 2>nul
mkdir "%INSTALL_DIR%\scrapers" 2>nul

:: Copy core files
echo Copying files...
copy /Y "node.exe"     "%INSTALL_DIR%\node.exe"     >nul
copy /Y "index.js"     "%INSTALL_DIR%\index.js"     >nul
copy /Y "package.json" "%INSTALL_DIR%\package.json" >nul
if exist "package-lock.json" copy /Y "package-lock.json" "%INSTALL_DIR%\package-lock.json" >nul
xcopy /E /I /Q /Y "node_modules" "%INSTALL_DIR%\node_modules" 2>nul
xcopy /E /I /Q /Y "scrapers"     "%INSTALL_DIR%\scrapers"     2>nul

:: Install Playwright Chromium browser (required for portal scraping)
echo.
echo  Installing browser components for portal access...
echo  (One-time download — approx 300 MB, may take a few minutes)
echo.
set PLAYWRIGHT_BROWSERS_PATH=%INSTALL_DIR%\browsers
"%INSTALL_DIR%\node.exe" "%INSTALL_DIR%\node_modules\playwright\bin\playwright.js" install chromium
if %ERRORLEVEL% neq 0 (
  echo.
  echo  WARNING: Browser install had issues. Portal scraping may not work until
  echo  this completes. You can re-run this installer to retry.
  echo.
)

:: Create start script
echo @echo off > "%INSTALL_DIR%\start.bat"
echo set PLAYWRIGHT_BROWSERS_PATH=%%APPDATA%%\EDiFiConnect\browsers >> "%INSTALL_DIR%\start.bat"
echo cd /d "%%APPDATA%%\EDiFiConnect" >> "%INSTALL_DIR%\start.bat"
echo start "" /B "%%APPDATA%%\EDiFiConnect\node.exe" index.js >> "%INSTALL_DIR%\start.bat"

:: Add to Windows startup via Registry
reg add "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v "EDiFiConnect" /t REG_SZ /d "\"%INSTALL_DIR%\start.bat\"" /f >nul 2>&1
echo Auto-start on login: enabled

:: Start the service
echo Starting EDiFi Connect...
set PLAYWRIGHT_BROWSERS_PATH=%INSTALL_DIR%\browsers
start "" /B "%INSTALL_DIR%\node.exe" "%INSTALL_DIR%\index.js"

:: Open setup page
timeout /t 2 /nobreak >nul
start "" "http://localhost:47821/setup" 2>nul

echo.
echo  ============================================
echo   Installation complete!
echo.
echo   Next steps:
echo   1. Copy your Office Code from EDiFi Settings
echo   2. Your browser should open the setup page
echo      (or go to http://localhost:47821/setup)
echo   3. Paste your Office Code and click Connect
echo   4. Open Chrome and add the EDiFi extension
echo.
echo   EDiFi Connect starts automatically every time
echo   you log into Windows.
echo  ============================================
echo.
pause
