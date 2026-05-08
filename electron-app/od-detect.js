const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

/**
 * Detects Open Dental installation and API configuration on Windows.
 * Returns { found, installPath, apiUrl, version, error }
 */
async function detectOpenDental() {
  const result = { found: false, installPath: null, apiUrl: null, version: null, error: null };

  // ── Step 1: Find OD installation via Windows Registry ────────────────────────
  const registryPaths = [
    'HKLM\\SOFTWARE\\OpenDental',
    'HKLM\\SOFTWARE\\Open Dental Software',
    'HKLM\\SOFTWARE\\WOW6432Node\\OpenDental',
    'HKLM\\SOFTWARE\\WOW6432Node\\Open Dental Software',
  ];

  let installDir = null;
  for (const regPath of registryPaths) {
    try {
      const output = execSync(`reg query "${regPath}" /v InstallDir 2>nul`, { encoding: 'utf8', timeout: 3000 });
      const match = output.match(/InstallDir\s+REG_SZ\s+(.+)/);
      if (match) {
        installDir = match[1].trim();
        break;
      }
    } catch {}
  }

  // Fallback: check common install paths
  if (!installDir) {
    const commonPaths = [
      'C:\\Program Files\\Open Dental',
      'C:\\Program Files (x86)\\Open Dental',
      'C:\\OpenDental',
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(path.join(p, 'OpenDental.exe'))) {
        installDir = p;
        break;
      }
    }
  }

  if (!installDir) {
    result.error = 'Open Dental installation not found on this computer.';
    return result;
  }

  result.found = true;
  result.installPath = installDir;

  // ── Step 2: Get OD version from executable ────────────────────────────────────
  try {
    const exePath = path.join(installDir, 'OpenDental.exe');
    if (fs.existsSync(exePath)) {
      const verOutput = execSync(
        `(Get-Item "${exePath}").VersionInfo.FileVersion`,
        { shell: 'powershell', encoding: 'utf8', timeout: 3000 }
      );
      result.version = verOutput.trim();
    }
  } catch {}

  // ── Step 3: Detect OD API URL ────────────────────────────────────────────────
  // OD Web Service runs on the local server. Try common configurations.
  const urlCandidates = [
    'http://localhost/opendentalapi',
    'http://127.0.0.1/opendentalapi',
    'http://localhost:8080/opendentalapi',
    'http://localhost:80/opendentalapi',
  ];

  // Also try to get the server name from OD config
  try {
    const configFile = path.join(installDir, 'OpenDental.config');
    const altConfig = path.join(installDir, 'FreeDentalConfig.xml');

    for (const cfgPath of [configFile, altConfig]) {
      if (fs.existsSync(cfgPath)) {
        const content = fs.readFileSync(cfgPath, 'utf8');
        // Look for server/host configuration
        const serverMatch = content.match(/(?:Server|DataSource|host)=([^;"\s<]+)/i);
        if (serverMatch && serverMatch[1] !== 'localhost' && serverMatch[1] !== '127.0.0.1') {
          urlCandidates.unshift(`http://${serverMatch[1]}/opendentalapi`);
        }
      }
    }
  } catch {}

  // Test each URL
  for (const url of urlCandidates) {
    const reachable = await testApiUrl(`${url}/version`);
    if (reachable) {
      result.apiUrl = url;
      break;
    }
  }

  // If none reachable, provide the most likely URL as a suggestion
  if (!result.apiUrl) {
    result.apiUrl = 'http://localhost/opendentalapi';
    result.apiUnreachable = true;
  }

  return result;
}

function testApiUrl(url) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 2000);
    try {
      const req = http.get(url, (res) => {
        clearTimeout(timeout);
        resolve(res.statusCode < 500);
      });
      req.on('error', () => { clearTimeout(timeout); resolve(false); });
    } catch { clearTimeout(timeout); resolve(false); }
  });
}

module.exports = { detectOpenDental };
