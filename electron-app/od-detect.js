const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");

/**
 * Detects Open Dental installation and API configuration on Windows.
 * Returns { found, installPath, apiUrl, version, error }
 */
async function detectOpenDental() {
  const result = {
    found: false,
    installPath: null,
    apiUrl: null,
    version: null,
    error: null,
  };

  // ── Step 1: Find OD installation via Windows Registry ────────────────────────
  const registryPaths = [
    "HKLM\\SOFTWARE\\OpenDental",
    "HKLM\\SOFTWARE\\Open Dental Software",
    "HKLM\\SOFTWARE\\WOW6432Node\\OpenDental",
    "HKLM\\SOFTWARE\\WOW6432Node\\Open Dental Software",
  ];

  let installDir = null;
  for (const regPath of registryPaths) {
    try {
      const output = execSync(`reg query "${regPath}" /v InstallDir 2>nul`, {
        encoding: "utf8",
        timeout: 3000,
      });
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
      "C:\\Program Files\\Open Dental",
      "C:\\Program Files (x86)\\Open Dental",
      "C:\\OpenDental",
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(path.join(p, "OpenDental.exe"))) {
        installDir = p;
        break;
      }
    }
  }

  if (!installDir) {
    result.error = "Open Dental installation not found on this computer.";
    return result;
  }

  result.found = true;
  result.installPath = installDir;

  // ── Step 2: Get OD version from executable ────────────────────────────────────
  try {
    const exePath = path.join(installDir, "OpenDental.exe");
    if (fs.existsSync(exePath)) {
      const verOutput = execSync(
        `(Get-Item "${exePath}").VersionInfo.FileVersion`,
        { shell: "powershell", encoding: "utf8", timeout: 3000 },
      );
      result.version = verOutput.trim();
    }
  } catch {}

  // ── Step 3: Detect OD REST API URL ───────────────────────────────────────────
  // EDiFi uses the modern OpenDental REST API (base path /api/v1): the Local API
  // on port 30222 (runs inside OpenDental.exe) and the API Service on 30223
  // (OpenDentalAPIService.exe, always-on). NOT the legacy /opendentalapi web
  // service — that was the wrong target and matched unrelated services.
  const urlCandidates = [
    "http://localhost:30222/api/v1",
    "http://127.0.0.1:30222/api/v1",
    "http://localhost:30223/api/v1",
    "http://127.0.0.1:30223/api/v1",
  ];

  // If OD's database lives on another server, the always-on API Service may run
  // there too — add it as a candidate.
  try {
    const altConfig = path.join(installDir, "FreeDentalConfig.xml");
    if (fs.existsSync(altConfig)) {
      const content = fs.readFileSync(altConfig, "utf8");
      const serverMatch = content.match(
        /<ComputerName>([^<]+)<\/ComputerName>/i,
      );
      const server = serverMatch && serverMatch[1].trim();
      if (server && server !== "localhost" && server !== "127.0.0.1") {
        urlCandidates.push(`http://${server}:30223/api/v1`);
      }
    }
  } catch {}

  // Confirm a candidate is really the OD REST API before accepting it.
  for (const url of urlCandidates) {
    if (await isOpenDentalApi(url)) {
      result.apiUrl = url;
      break;
    }
  }

  // If none confirmed, suggest the standard Local API endpoint.
  if (!result.apiUrl) {
    result.apiUrl = "http://localhost:30222/api/v1";
    result.apiUnreachable = true;
  }

  return result;
}

// The OD REST API requires an ODFHIR auth header, so an unauthenticated GET to a
// real resource returns 400/401/403 — never a plain 200 (which a random local
// service, e.g. Docker on 8080, might). Accept only those auth-style responses as
// confirmation this is actually OpenDental, not just "something answered".
function isOpenDentalApi(base) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 2000);
    try {
      const req = http.get(`${base}/operatories`, (res) => {
        clearTimeout(timeout);
        resolve(
          res.statusCode === 400 ||
            res.statusCode === 401 ||
            res.statusCode === 403,
        );
      });
      req.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    } catch {
      clearTimeout(timeout);
      resolve(false);
    }
  });
}

module.exports = { detectOpenDental };
