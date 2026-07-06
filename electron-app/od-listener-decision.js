// Pure decision engine for the setup-window OD-listener wizard.
// Framework-free and side-effect-free so it runs identically in the Electron
// renderer (loaded via <script>) and under `node --test`.
//
// It maps observed OpenDental listener state to one case (OK / LISTENER_UP / B /
// C / E / OD_NOT_FOUND / UNKNOWN) and says whether the office can self-fix it.
// Whichever port is up (30222 or 30223) becomes `servingPort` — the endpoint the
// UI points EDiFi at — so a 30223-only office is just "reachable, connect", not a
// separate "wrong port" state that would loop on re-check.
//
// Port facts (Open Dental docs, verified 2026-07-06):
//   30222 = Local API  — runs inside OpenDental.exe, only while OD is open + a
//                        user is logged in. This is what EDiFi's od_api_url
//                        defaults to.
//   30223 = API Service (OpenDentalAPIService.exe) — continuously running on the
//                        server, survives logout. Managed via
//                        Tools > Misc Tools > Service Manager.
// A listener on 30223 but not 30222 means "point EDiFi at 30223" — reachable via
// servingPort, NOT "enable the API" (Case B). Detect-od can false-positive on
// unrelated ports (e.g. Docker on 8080), so the live port probe wins over its URL.

const LOCAL_API_PORT = 30222;
const API_SERVICE_PORT = 30223;

// input shape (all fields optional; the engine degrades to UNKNOWN when blind):
//   detect   : { found, version, apiUrl, apiUnreachable }        from detect-od
//   ports    : { "30222": { listening }, "30223": { listening } } from diag-listener-ports
//   service  : { exists, state }                                  from diag-service-status (OpenDenteConnector)
//   restAuth : { econnector_reachable, auth_accepted, http_status, error_category } | null  from diag-rest-auth (post-enable)
//   ui       : { apiEnabled, hasCustomerKey }                     office-observed / config (optional)
function classifyListenerState(input) {
  const detect = input?.detect || {};
  const ports = input?.ports || {};
  const service = input?.service || {};
  const restAuth = input?.restAuth || null;
  const ui = input?.ui || {};

  const on222 = !!ports[LOCAL_API_PORT]?.listening;
  const on223 = !!ports[API_SERVICE_PORT]?.listening;
  const apiEnabled = ui.apiEnabled; // true | false | undefined
  const hasKey = !!ui.hasCustomerKey;
  const httpStatus = restAuth ? restAuth.http_status : null;
  // The port we actually confirmed a listener on — the endpoint EDiFi should use,
  // regardless of what detect-od guessed (it can false-positive on other ports,
  // e.g. a Docker service on 8080). Prefer the always-on API Service when only it
  // is up; otherwise the Local API.
  const servingPort = on222 ? LOCAL_API_PORT : on223 ? API_SERVICE_PORT : null;

  // 0 — Open Dental itself not on this machine. Not office-fixable in the wizard.
  if (detect.found === false) {
    return decision("OD_NOT_FOUND", {
      fixable: false,
      title: "Open Dental not found on this computer",
      detail:
        "Run the EDiFi Connect installer on the computer where Open Dental is installed.",
    });
  }

  // Need listener-probe data to reason about ports. Absent data must NOT be read
  // as "not listening" — that would misfire Case B (API off). Escalate instead.
  if (!(LOCAL_API_PORT in ports) && !(API_SERVICE_PORT in ports)) {
    return decision("UNKNOWN", {
      fixable: false,
      title: "We couldn't check the Open Dental connection",
      detail:
        "The port check didn't run. Try again, or send diagnostics to support.",
      escalate: true,
    });
  }

  // OK — the port EDiFi uses (30222) is serving and the authenticated probe was
  // accepted. diag-rest-auth SENDS the Customer Key, so a 401/403 here is a real
  // rejection (Case C), never OK — auth_accepted is the single source of truth.
  const authReached = !!restAuth && restAuth.auth_accepted === true;
  if (servingPort && authReached) {
    return decision("OK", {
      fixable: true,
      servingPort,
      title: "Open Dental Web Service is running",
      detail: "EDiFi can reach Open Dental. You're connected.",
    });
  }

  // E — API reported ON but nothing is serving on either port.
  // eConnector / service problem. Guided only if the service is clearly down.
  if (apiEnabled === true && !servingPort) {
    const svcDown =
      service.state === "STOPPED" ||
      service.state === "NOT_FOUND" ||
      service.exists === false;
    return decision("E", {
      fixable: svcDown,
      title: svcDown
        ? "The Open Dental eConnector is not running"
        : "Open Dental API is on, but nothing is serving",
      detail: svcDown
        ? "Install or start the eConnector, then re-check."
        : "The API is enabled but no listener responded. EDiFi needs to take a look.",
      showEnableSteps: svcDown ? "econnector" : null,
      showReCheck: svcDown,
      escalate: !svcDown,
    });
  }

  // B — no listener anywhere and the API is off (or unknown-off). The happy path.
  // Self-serve: enable the OD Web Service in the OD UI, then re-check.
  if (!servingPort && apiEnabled !== true) {
    return decision("B", {
      fixable: true,
      title: "Open Dental's Web Service is turned off",
      detail:
        "Turn on the Open Dental API, then click Re-check. We'll show you exactly where.",
      showEnableSteps: "api",
      showReCheck: true,
    });
  }

  // C — the serving port is up but auth was rejected.
  if (servingPort && (httpStatus === 401 || httpStatus === 403)) {
    return decision("C", {
      fixable: !hasKey, // no key yet → office adds one; key present + 401 → escalate
      servingPort,
      title: hasKey
        ? "Open Dental rejected the API key"
        : "Open Dental needs an API Customer Key",
      detail: hasKey
        ? "The Web Service is up but the key was rejected. EDiFi needs to take a look."
        : "The Web Service is up. Add your Open Dental Customer Key to finish.",
      showKeyStep: !hasKey,
      showReCheck: !hasKey,
      escalate: hasKey,
    });
  }

  // LISTENER_UP — a listener is up (Local API 30222, or the always-on API Service
  // 30223) but auth hasn't been tested yet (pre-register: no saved URL/key). The
  // hard part — the listener — is up; EDiFi will use servingPort. Just connect.
  if (
    servingPort &&
    (!restAuth ||
      restAuth.error_category === "OD_API_URL_NOT_CONFIGURED" ||
      restAuth.error_category === "OD_CUSTOMER_KEY_NOT_SET")
  ) {
    return decision("LISTENER_UP", {
      fixable: true,
      servingPort,
      title: "Open Dental's Web Service is running",
      detail:
        servingPort === API_SERVICE_PORT
          ? "Open Dental is reachable on the always-on API Service (port 30223). Enter your office code below and click Connect."
          : "Open Dental is reachable. Enter your office code below and click Connect.",
      showReCheck: true,
    });
  }

  // Anything else — not confidently classified. Escalate to EDF with diagnostics.
  return decision("UNKNOWN", {
    fixable: false,
    title: "We couldn't confirm the Open Dental connection",
    detail:
      "EDiFi needs to take a look. Send the diagnostics below to support.",
    escalate: true,
  });
}

function decision(caseId, fields) {
  return {
    case: caseId,
    fixable: false,
    title: "",
    detail: "",
    showEnableSteps: null, // "api" | "econnector" | null
    showPortFix: null, // { fromPort, toPort } | null
    servingPort: null, // confirmed listening port EDiFi should use, or null
    showKeyStep: false,
    showReCheck: false,
    escalate: false,
    ...fields,
  };
}

// Safe-to-copy diagnostic set for the "Copy diagnostics for support" button.
// Booleans / states / status codes / port numbers / version only — never keys,
// URLs, IPs, hostnames, paths, or PHI.
function buildDiagnosticSummary(input) {
  const detect = input?.detect || {};
  const ports = input?.ports || {};
  const service = input?.service || {};
  const restAuth = input?.restAuth || null;
  const verdict = classifyListenerState(input);
  return {
    case: verdict.case,
    od_found: detect.found === true,
    od_version: typeof detect.version === "string" ? detect.version : null,
    port_30222_listening: !!ports[LOCAL_API_PORT]?.listening,
    port_30223_listening: !!ports[API_SERVICE_PORT]?.listening,
    service_exists: service.exists === true,
    service_state: service.state ?? null,
    rest_http_status: restAuth ? restAuth.http_status : null,
    rest_error_category: restAuth ? restAuth.error_category : null,
  };
}

const api = {
  classifyListenerState,
  buildDiagnosticSummary,
  LOCAL_API_PORT,
  API_SERVICE_PORT,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
if (typeof window !== "undefined") {
  window.odListenerDecision = api;
}
