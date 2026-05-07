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
)

:: Create app directory in AppData
set INSTALL_DIR=%APPDATA%\EDiFiConnect
echo Installing to: %INSTALL_DIR%
mkdir "%INSTALL_DIR%" 2>nul
mkdir "%INSTALL_DIR%\node_modules" 2>nul
mkdir "%INSTALL_DIR%\scrapers" 2>nul

:: Copy files
echo Copying files...
copy /Y "node.exe" "%INSTALL_DIR%\node.exe" >nul
copy /Y "index.js" "%INSTALL_DIR%\index.js" >nul
copy /Y "package.json" "%INSTALL_DIR%\package.json" >nul
xcopy /E /I /Q /Y "node_modules" "%INSTALL_DIR%\node_modules" >nul
xcopy /E /I /Q /Y "scrapers" "%INSTALL_DIR%\scrapers" >nul

:: Create start script
echo @echo off > "%INSTALL_DIR%\start.bat"
echo cd /d "%%APPDATA%%\EDiFiConnect" >> "%INSTALL_DIR%\start.bat"
echo start "" /B "%%APPDATA%%\EDiFiConnect\node.exe" index.js >> "%INSTALL_DIR%\start.bat"

:: Add to Windows startup via Registry
reg add "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v "EDiFiConnect" /t REG_SZ /d "\"%INSTALL_DIR%\start.bat\"" /f >nul 2>&1
echo Auto-start on login: enabled

:: Start the service now
echo Starting EDiFi Connect...
start "" /B "%INSTALL_DIR%\node.exe" "%INSTALL_DIR%\index.js"

:: Open setup page in browser
timeout /t 2 /nobreak >nul
start "" "http://localhost:47821/setup" 2>nul

echo.
echo  ============================================
echo   Installation complete!
echo.
echo   Next steps:
echo   1. Copy your Office Code from EDiFi Settings
echo   2. Your browser should open the setup page
echo      (or go to http://localhost:47821/setup.html)
echo   3. Paste your Office Code and click Connect
echo   4. Open Chrome and add the EDiFi extension
echo.
echo   The service starts automatically every time
echo   you log into Windows.
echo  ============================================
echo.
pause
