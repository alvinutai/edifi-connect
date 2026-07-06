// Standalone test harness for the setup-window OD-listener wizard.
// Opens the REAL setup.html + setup-preload.js with REAL read-only probes
// (netstat / sc query / OD detect) against this machine — but starts NOTHING
// else: no tunnel, no tray, no express service, no auto-update, no login-item,
// no registration. Not shipped (excluded from package.json "files").
//
// Run:  node_modules\.bin\electron.cmd setup-test.js
// Purpose: verify the wizard diagnoses OD state and re-checks to green, without
// touching the production agent or this machine's Connect config.

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const { detectOpenDental } = require("./od-detect");
const {
  probeListenerPorts,
  validateServiceName,
  probeServiceStatus,
} = require("./od-probes");

function createWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 760,
    title: "EDiFi Connect Setup — TEST HARNESS",
    webPreferences: {
      preload: path.join(__dirname, "setup-preload.js"),
    },
  });
  win.loadFile("setup.html");
}

// Real probes.
ipcMain.handle("detect-od", async () => await detectOpenDental());
ipcMain.handle("diag-listener-ports", () => probeListenerPorts());
ipcMain.handle("diag-service-status", (_, arg) => {
  const v = validateServiceName(arg && arg.service);
  if (v.invalid) return { invalid: true, service: null };
  return probeServiceStatus(v.service);
});

// Unregistered state — matches what the real diag-rest-auth returns before an
// office is connected (no saved od_api_url). Lets the engine reach LISTENER_UP
// once 30222 comes up, without needing a real EDiFi registration.
ipcMain.handle("diag-rest-auth", () => ({
  econnector_reachable: false,
  auth_accepted: false,
  http_status: null,
  error_category: "OD_API_URL_NOT_CONFIGURED",
}));

ipcMain.handle("get-config", () => ({
  office_id: null,
  od_api_url: null,
  od_customer_key_set: false,
  registered: false,
}));

ipcMain.handle("open-external", (_, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
    return { ok: true };
  }
  return { ok: false, error: "INVALID_URL" };
});

// Register is out of scope for this harness — the wizard's OD check above is what
// we're validating. Return a clear message instead of faking a cloud connection.
ipcMain.handle("register", () => ({
  ok: false,
  error:
    "Test harness — skipping the real EDiFi connection. The Open Dental check above is what we're validating.",
}));

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
