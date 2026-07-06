// Read-only OpenDental listener probes, shared with the setup-window wizard test
// harness (setup-test.js). Copied verbatim from the equivalents in main.js.
// NOTE: main.js currently keeps its own copies for the production agent; dedupe
// main.js to import from here in a follow-up (tracked in the wizard spec). These
// never mutate anything — netstat / sc query only.

// Which OD API listeners are up. 30222 = Local API (inside OpenDental.exe, only
// while OD is open + logged in); 30223 = API Service (OpenDentalAPIService.exe,
// always-on). Port numbers are <= 65535 so ":30222"/":30223" are unambiguous.
function probeListenerPorts() {
  const { execSync } = require("child_process");
  const result = {
    30222: { listening: false, listener_pid: null },
    30223: { listening: false, listener_pid: null },
    error: null,
  };

  try {
    const out = execSync("netstat -ano", {
      encoding: "utf8",
      timeout: 8000,
      shell: true,
    });
    for (const line of out.split("\n")) {
      if (!/LISTEN/i.test(line)) continue;
      for (const p of [30222, 30223]) {
        if (result[p].listening) continue;
        if (line.includes(`:${p}`)) {
          result[p].listening = true;
          const m = line.trim().match(/(\d+)\s*$/);
          if (m) result[p].listener_pid = parseInt(m[1], 10);
        }
      }
    }
  } catch (e) {
    result.error = e.message.slice(0, 200);
  }

  return result;
}

// Resolve + allowlist-validate a service name (defaults to OpenDenteConnector).
function validateServiceName(rawService) {
  const SERVICE =
    (typeof rawService === "string" ? rawService.trim() : "") ||
    "OpenDenteConnector";
  const SAFE_SERVICE_NAME = /^[A-Za-z0-9 _.\\-]{1,80}$/;
  return SAFE_SERVICE_NAME.test(SERVICE)
    ? { service: SERVICE }
    : { invalid: true };
}

function probeServiceStatus(SERVICE) {
  const { execSync } = require("child_process");
  let exists = false;
  let state = null;
  let start_type = null;
  let error = null;

  try {
    const q = execSync(`sc query "${SERVICE}"`, {
      encoding: "utf8",
      timeout: 8000,
      shell: true,
    });
    exists = true;
    if (/RUNNING/i.test(q)) state = "RUNNING";
    else if (/START_PENDING/i.test(q)) state = "START_PENDING";
    else if (/STOP_PENDING/i.test(q)) state = "STOP_PENDING";
    else if (/STOPPED/i.test(q)) state = "STOPPED";
    else state = "UNKNOWN";
  } catch (e) {
    const msg = (
      (e.stderr || "") +
      (e.stdout || "") +
      (e.message || "")
    ).toLowerCase();
    if (
      msg.includes("does not exist") ||
      msg.includes("error 1060") ||
      msg.includes("openscmanager")
    ) {
      exists = false;
      state = "NOT_FOUND";
    } else {
      exists = false;
      state = "QUERY_FAILED";
      error = e.message.slice(0, 200);
    }
  }

  if (exists) {
    try {
      const cfg = execSync(`sc qc "${SERVICE}"`, {
        encoding: "utf8",
        timeout: 8000,
        shell: true,
      });
      const m = cfg.match(/START_TYPE\s*:\s*\d+\s+(\S+)/i);
      if (m) start_type = m[1];
    } catch {}
  }

  return { service: SERVICE, exists, state, start_type, error };
}

module.exports = { probeListenerPorts, validateServiceName, probeServiceStatus };
