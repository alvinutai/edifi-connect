# Build script for EDiFi Connect installer ZIP
# Run from repo root: .\build-installer.ps1
#
# Creates EDiFiConnect-Setup.zip containing ALL required files — including
# node.exe and node_modules which are gitignored but MUST be in the release.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path $MyInvocation.MyCommand.Path
$desktopSvc = Join-Path $repoRoot "desktop-service"
$chromeExt = Join-Path $repoRoot "chrome-extension"
$zipPath = Join-Path $repoRoot "EDiFiConnect-Setup.zip"
$buildTemp = Join-Path $repoRoot "_build_temp"

# Validate prerequisites
if (-not (Test-Path "$desktopSvc\node.exe")) {
    Write-Error "node.exe not found in desktop-service/. Download Node.js LTS portable and place it there."
    exit 1
}

# Install npm dependencies (uses system npm — requires Node.js on build machine)
Write-Host "Installing npm dependencies..." -ForegroundColor Cyan
Push-Location $desktopSvc
npm install --production
if ($LASTEXITCODE -ne 0) {
    Write-Error "npm install failed. Make sure Node.js is installed on this machine."
    exit 1
}
Pop-Location

# Assemble ZIP structure in temp dir
Write-Host "Assembling installer package..." -ForegroundColor Cyan
if (Test-Path $buildTemp) { Remove-Item $buildTemp -Recurse -Force }
$pkgDir = New-Item -ItemType Directory -Path "$buildTemp\EDiFiConnect-Setup" -Force | Select-Object -ExpandProperty FullName

# Copy desktop service files
$coreFiles = @("install.bat", "index.js", "package.json", "package-lock.json", "node.exe")
foreach ($f in $coreFiles) {
    $src = Join-Path $desktopSvc $f
    if (Test-Path $src) {
        Copy-Item $src -Destination $pkgDir
    }
}
if (Test-Path "$desktopSvc\README.txt") {
    Copy-Item "$desktopSvc\README.txt" -Destination $pkgDir
}

# Copy scrapers and node_modules
Copy-Item "$desktopSvc\scrapers"     -Destination "$pkgDir\scrapers"     -Recurse
Copy-Item "$desktopSvc\node_modules" -Destination "$pkgDir\node_modules" -Recurse

# Copy Chrome extension
Copy-Item $chromeExt -Destination "$pkgDir\chrome-extension" -Recurse

# Create ZIP
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Write-Host "Creating ZIP..." -ForegroundColor Cyan
Compress-Archive -Path "$pkgDir" -DestinationPath $zipPath -CompressionLevel Optimal

# Cleanup
Remove-Item $buildTemp -Recurse -Force

$sizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host ""
Write-Host "Build complete!" -ForegroundColor Green
Write-Host "  Output: $zipPath"
Write-Host "  Size:   $sizeMB MB"
Write-Host ""
Write-Host "Next: Upload EDiFiConnect-Setup.zip as a GitHub release asset." -ForegroundColor Yellow
