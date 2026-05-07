const {
  app,
  Tray,
  Menu,
  BrowserWindow,
  shell,
  ipcMain,
  nativeImage,
  dialog,
} = require("electron");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const { WebSocket, WebSocketServer } = require("ws");
const { detectOpenDental } = require("./od-detect");

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = 47821;
const EDIFI_CLOUD_WS = "wss://edifi-ai-eligibility-production.up.railway.app";
const EDIFI_CLOUD_HTTP =
  "https://edifi-ai-eligibility-production.up.railway.app";
const CONFIG_PATH = path.join(app.getPath("userData"), "config.json");
const LOG_PATH = path.join(app.getPath("userData"), "edifi-connect.log");

// ─── Logging ──────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + "\n");
  } catch {}
}

// ─── Config ───────────────────────────────────────────────────────────────────

let config = {
  office_id: null,
  api_key: null,
  registered: false,
  od_api_url: null,
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = {
        ...config,
        ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")),
      };
    }
  } catch (e) {
    log(`Config load error: ${e.message}`);
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch {}
}

// ─── Session Store ────────────────────────────────────────────────────────────

const SESSION_TTL = 8 * 60 * 60 * 1000;
const sessions = new Map();

function storeSession(officeId, payerCode, cookies) {
  sessions.set(`${officeId}:${payerCode}`, {
    officeId,
    payerCode,
    cookies,
    at: Date.now(),
  });
  log(`Session captured: ${payerCode}`);
  updateTray();
}

function getSession(officeId, payerCode) {
  const s = sessions.get(`${officeId}:${payerCode}`);
  if (!s || Date.now() - s.at > SESSION_TTL) {
    sessions.delete(`${officeId}:${payerCode}`);
    return null;
  }
  return s;
}

function activeSessions() {
  const now = Date.now();
  return [...sessions.values()].filter((s) => now - s.at < SESSION_TTL);
}

// ─── Tunnel to EDiFi Cloud ────────────────────────────────────────────────────

let tunnel = null;
let tunnelOk = false;
let reconnectTimer = null;

function connectTunnel() {
  if (!config.registered || !config.office_id) return;
  clearTimeout(reconnectTimer);

  const url = `${EDIFI_CLOUD_WS}/connect/bridge?office_id=${encodeURIComponent(config.office_id)}`;
  log(`Tunnel connecting: ${url}`);

  tunnel = new WebSocket(url);

  tunnel.on("open", () => {
    tunnelOk = true;
    log("Tunnel connected to EDiFi Cloud");
    updateTray();
    // Announce available sessions
    const active = activeSessions();
    if (active.length > 0) {
      tunnel.send(
        JSON.stringify({
          type: "SESSIONS_AVAILABLE",
          count: active.length,
          payers: active.map((s) => s.payerCode),
        }),
      );
    }
  });

  tunnel.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "PING") {
        tunnel.send(
          JSON.stringify({ type: "PONG", office_id: config.office_id }),
        );
      }
      if (msg.type === "SCRAPE_REQUEST") {
        const result = await handleScrape(msg);
        tunnel.send(JSON.stringify({ type: "SCRAPE_RESULT", ...result }));
      }
    } catch (e) {
      log(`Tunnel message error: ${e.message}`);
    }
  });

  tunnel.on("close", () => {
    tunnelOk = false;
    log("Tunnel disconnected — reconnecting in 30s");
    updateTray();
    reconnectTimer = setTimeout(connectTunnel, 30000);
  });

  tunnel.on("error", (e) => {
    log(`Tunnel error: ${e.message}`);
  });
}

async function handleScrape(req) {
  const {
    scrape_id,
    payer_code,
    member_id,
    subscriber_dob,
    subscriber_last_name,
  } = req;
  const session = getSession(config.office_id, payer_code);

  if (!session) {
    return {
      scrape_id,
      success: false,
      error: "NO_SESSION",
      message: `No active portal session for ${payer_code}. Please log into the carrier portal in your browser.`,
    };
  }

  try {
    const { chromium } = require("playwright");
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      storageState: { cookies: session.cookies, origins: [] },
    });
    const page = await ctx.newPage();

    // Navigate to eligibility page with existing session — no login needed
    log(
      `[Scrape] ${payer_code} — using captured session, searching member ${member_id?.slice(0, 4)}...`,
    );

    // Basic scrape — navigates to eligibility search with existing authenticated session
    const result = await performEligibilityScrape(page, payer_code, {
      member_id,
      subscriber_dob,
      subscriber_last_name,
    });

    await browser.close();
    return { scrape_id, success: true, data: result };
  } catch (e) {
    log(`[Scrape] ${payer_code} failed: ${e.message}`);
    return {
      scrape_id,
      success: false,
      error: "SCRAPE_FAILED",
      message: e.message,
    };
  }
}

async function performEligibilityScrape(page, payerCode, patientInfo) {
  // Placeholder — actual portal navigation goes here per-carrier
  // With a live authenticated session, just navigate to eligibility search
  return {
    benefits: [],
    note: "Session-based scrape — carrier-specific navigation needed",
  };
}

// ─── Express Local Server ─────────────────────────────────────────────────────

const expressApp = express();
expressApp.use(
  cors({ origin: ["chrome-extension://*", "http://localhost:*"] }),
);
expressApp.use(express.json({ limit: "5mb" }));

expressApp.get("/health", (_, res) =>
  res.json({
    ok: true,
    registered: config.registered,
    office_id: config.office_id,
    tunnel_connected: tunnelOk,
    sessions: activeSessions().map((s) => s.payerCode),
  }),
);

expressApp.post("/session", (req, res) => {
  const { office_id, payer_code, cookies, payer_name } = req.body;
  if (!office_id || !payer_code || !cookies?.length)
    return res.status(400).json({ error: "Missing fields" });
  storeSession(office_id, payer_code, cookies);
  if (tunnelOk && tunnel) {
    tunnel.send(
      JSON.stringify({
        type: "SESSION_AVAILABLE",
        office_id,
        payer_code,
        payer_name,
      }),
    );
  }
  res.json({ ok: true });
});

expressApp.post("/register", (req, res) => {
  const { office_id, api_key } = req.body;
  if (!office_id) return res.status(400).json({ error: "office_id required" });
  config = { ...config, office_id, api_key, registered: true };
  saveConfig();
  connectTunnel();
  updateTray();
  res.json({ ok: true });
});

expressApp.get("/status", (_, res) =>
  res.json({
    registered: config.registered,
    office_id: config.office_id,
    tunnel_connected: tunnelOk,
    session_count: activeSessions().length,
    sessions: activeSessions().map((s) => ({
      payer: s.payerCode,
      age_min: Math.floor((Date.now() - s.at) / 60000),
    })),
  }),
);

// ─── System Tray ──────────────────────────────────────────────────────────────

let tray = null;
let setupWindow = null;

function createTrayIcon(status) {
  const colors = {
    connected: "#16a34a",
    connecting: "#d97706",
    error: "#dc2626",
  };
  const color = colors[status] || colors.error;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="6" fill="${color}"/>
    <text x="16" y="23" text-anchor="middle" font-family="Arial,sans-serif"
          font-size="20" font-weight="bold" fill="white">E</text>
  </svg>`;
  return nativeImage
    .createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
    )
    .resize({ width: 16, height: 16 });
}

function updateTray() {
  if (!tray) return;

  const sessions = activeSessions();
  const status = !config.registered
    ? "error"
    : !tunnelOk
      ? "connecting"
      : "connected";
  const statusText = !config.registered
    ? "Not set up"
    : !tunnelOk
      ? "Connecting..."
      : `Connected — ${sessions.length} portal session${sessions.length !== 1 ? "s" : ""}`;

  const menu = Menu.buildFromTemplate([
    { label: "EDiFi Connect", enabled: false },
    { label: statusText, enabled: false },
    { type: "separator" },
    ...(sessions.length > 0
      ? [
          { label: `Active sessions (${sessions.length}):`, enabled: false },
          ...sessions.map((s) => ({
            label: `  • ${s.payerCode}`,
            enabled: false,
          })),
          { type: "separator" },
        ]
      : []),
    {
      label: "Set up office...",
      click: showSetupWindow,
      visible: !config.registered,
    },
    {
      label: "Open EDiFi Dashboard",
      click: () =>
        shell.openExternal("https://edifi-eligibility-platform.netlify.app"),
    },
    { label: "Install Chrome Extension", click: showExtensionInstructions },
    { type: "separator" },
    { label: "View logs", click: () => shell.openPath(LOG_PATH) },
    { label: "Quit EDiFi Connect", click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(`EDiFi Connect — ${statusText}`);
}

function showExtensionInstructions() {
  const extensionPath = path.join(process.resourcesPath, "chrome-extension");
  dialog
    .showMessageBox({
      type: "info",
      title: "Install Chrome Extension",
      message: "To install the EDiFi Connect Chrome extension:",
      detail:
        "1. Open Chrome and go to chrome://extensions\n" +
        '2. Turn on "Developer mode" (top right toggle)\n' +
        '3. Click "Load unpacked"\n' +
        `4. Select this folder:\n${extensionPath}\n\n` +
        "The extension will appear in your toolbar.",
      buttons: ["Copy folder path", "OK"],
    })
    .then((result) => {
      if (result.response === 0) {
        require("electron").clipboard.writeText(extensionPath);
      }
    });
}

// ─── Setup Window ─────────────────────────────────────────────────────────────

function showSetupWindow() {
  if (setupWindow) {
    setupWindow.focus();
    return;
  }

  setupWindow = new BrowserWindow({
    width: 520,
    height: 480,
    resizable: false,
    title: "EDiFi Connect Setup",
    webPreferences: {
      preload: path.join(__dirname, "setup-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  setupWindow.loadFile("setup.html");
  setupWindow.on("closed", () => {
    setupWindow = null;
  });
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle("detect-od", async () => {
  return await detectOpenDental();
});

ipcMain.handle("register", async (_, { officeCode, odApiUrl }) => {
  const code = officeCode?.trim();
  if (!code || code.length < 8) {
    return { ok: false, error: "Please enter a valid Office Code." };
  }
  config = {
    ...config,
    office_id: code,
    od_api_url: odApiUrl?.trim() || null,
    registered: true,
  };
  saveConfig();
  connectTunnel();
  updateTray();
  log(`Office registered: ${code.slice(0, 8)}...`);
  return { ok: true };
});

ipcMain.handle("get-status", () => ({
  registered: config.registered,
  office_id: config.office_id,
  tunnel_connected: tunnelOk,
  sessions: activeSessions().length,
}));

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  loadConfig();

  // Start local service
  expressApp.listen(PORT, "127.0.0.1", () => {
    log(`Local service on port ${PORT}`);
  });

  // Create tray
  app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
  tray = new Tray(createTrayIcon("error"));
  tray.setToolTip("EDiFi Connect");
  updateTray();

  // Show setup on first run
  if (!config.registered) {
    showSetupWindow();
  } else {
    connectTunnel();
  }

  log(`EDiFi Connect started v${app.getVersion()}`);
});

app.on("window-all-closed", (e) => e.preventDefault()); // Keep running in tray
app.dock?.hide(); // Hide dock icon on macOS
