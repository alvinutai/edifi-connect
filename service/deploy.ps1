# EDiFi Connect — Windows Service Installer
# Run as Administrator on the OD server machine
# Usage: Right-click deploy.ps1 -> "Run with PowerShell" (as Administrator)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "EDiFi Connect Bridge Service Installer" -ForegroundColor Cyan
Write-Host "=======================================" -ForegroundColor Cyan
Write-Host ""

# Check for Node.js
try {
    $nodeVer = node --version 2>&1
    Write-Host "Node.js found: $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "ERROR: Node.js not found. Install from https://nodejs.org (LTS)" -ForegroundColor Red
    exit 1
}

# Check for existing config (must be registered via tray app first)
$configPath = Join-Path $env:APPDATA "edifi-connect\config.json"
if (-not (Test-Path $configPath)) {
    Write-Host ""
    Write-Host "ERROR: No EDiFi Connect config found at:" -ForegroundColor Red
    Write-Host "  $configPath" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Before installing the service, run the EDiFi Connect desktop app on" -ForegroundColor Yellow
    Write-Host "THIS machine and log in with your office credentials." -ForegroundColor Yellow
    Write-Host "Then run this script again." -ForegroundColor Yellow
    exit 1
}

$config = Get-Content $configPath | ConvertFrom-Json
if (-not $config.registered -or -not $config.office_id) {
    Write-Host "ERROR: EDiFi Connect is not registered. Log in via the tray app first." -ForegroundColor Red
    exit 1
}

Write-Host "Config found. Office: $($config.office_id)" -ForegroundColor Green
Write-Host ""

# Install npm dependencies
Write-Host "Installing dependencies..." -ForegroundColor Cyan
Set-Location $PSScriptRoot
npm install --silent
if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; exit 1 }
Write-Host "Dependencies installed." -ForegroundColor Green

# Stop existing service if running
$existing = Get-Service -Name "EDiFiConnect" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing service..." -ForegroundColor Yellow
    Stop-Service -Name "EDiFiConnect" -Force -ErrorAction SilentlyContinue
    node uninstall-service.js
    Start-Sleep -Seconds 3
}

# Install service
Write-Host "Installing Windows Service..." -ForegroundColor Cyan
node install-service.js
Start-Sleep -Seconds 5

# Verify
$svc = Get-Service -Name "EDiFiConnect" -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host ""
    Write-Host "SUCCESS. EDiFiConnect service status: $($svc.Status)" -ForegroundColor Green
    Write-Host ""
    Write-Host "The bridge is now running 24/7 on this machine." -ForegroundColor Green
    Write-Host "Logs: $env:APPDATA\edifi-connect\edifi-connect.log" -ForegroundColor Cyan
} else {
    Write-Host "Service install may have failed. Check logs." -ForegroundColor Red
}
