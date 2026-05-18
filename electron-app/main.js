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
const {
  isAvailable: isMysqlAvailable,
  getBenefitsForPatient,
  getPatNumByNameDOB,
  getAppointmentsForDate,
  getAppointmentsToday,
  getPatientInsuranceSnapshot,
  writeOdBenefits,
  setLogger: setMysqlLogger,
} = require("./od-mysql");
const { autoUpdater } = require("electron-updater");
const { randomUUID, createHash } = require("crypto");
const os = require("os");

// ─── Constants ────────────────────────────────────────────────────────────────

const PORT = 47821;
const EDIFI_CLOUD_WS = "wss://edifi-ai-eligibility-production.up.railway.app";
// New per-session UUID — changes every time the app starts. Used for command routing.
const AGENT_INSTANCE_ID = randomUUID();
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

const OD_DEV_KEY = "3TOLoPsbpxo8lxBi";

let config = {
  office_id: null,
  api_key: null,
  registered: false,
  od_api_url: null,
  od_customer_key: null,
  // Stable per-machine UUID — generated once and persisted. Never sent raw.
  // Only the SHA-256 hash is transmitted to the backend via AGENT_HELLO.
  machine_id: null,
};

// ─── Remote control state (never contains credentials or PHI) ─────────────────

const update_status = {
  checking: false,
  available: false,
  downloaded: false,
  last_check_at: null,
  last_download_at: null,
  last_error: null,
};

const od_sync_status = {
  available: false,
  last_attempt_at: null,
  last_success_at: null,
  last_error: null,
  last_counts: null,
};

// ─── Hardcoded capability list ────────────────────────────────────────────────
// This list is what the agent declares it can handle. The backend enforces
// which of these are actually enabled via Railway environment variables.
// Electron does NOT read Railway env vars — it is an office-local process.

const AGENT_CAPABILITIES = [
  "REPORT_STATUS",
  "REPORT_CONFIG_STATUS",
  "REPORT_UPDATE_STATUS",
  "REPORT_OD_STATUS",
  "CHECK_FOR_UPDATE",
  "DOWNLOAD_UPDATE",
  "SYNC_OD_NOW",
  "WRITE_OD_BENEFITS",
  "GET_SESSION_COOKIES",
  "CLEAR_SESSION_COOKIES",
  "RESTART_APP",
  "QUIT_AND_INSTALL",
];

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = {
        ...config,
        ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")),
      };
    }
    // Generate stable machine_id if not yet set
    if (!config.machine_id) {
      config.machine_id = randomUUID();
      saveConfig();
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

// ─── Built-in Portal Windows (no Chrome extension needed) ────────────────────

const PORTALS = [
  {
    payerCode: "DDIC",
    payerName: "Delta Dental",
    url: "https://www.deltadentalins.com/dental-professionals/login.html",
    partition: "persist:ddic",
    cookieUrl: "https://www.deltadentalins.com",
    domain: "deltadentalins.com",
  },
  {
    payerCode: "SELECTHEALTH",
    payerName: "SelectHealth",
    url: "https://selecthealth.org/providers",
    partition: "persist:selecthealth",
    cookieUrl: "https://selecthealth.org",
    domain: "selecthealth.org",
  },
  {
    payerCode: "EMIHEALTH",
    payerName: "EMI Health",
    url: "https://www.emihealth.com/providers",
    partition: "persist:emihealth",
    cookieUrl: "https://www.emihealth.com",
    domain: "emihealth.com",
  },
];

async function checkPartitionCookies(portal) {
  const { session: electronSession } = require("electron");
  const s = electronSession.fromPartition(portal.partition);
  const cookies = await s.cookies.get({ url: portal.cookieUrl });
  const sessionCookies = cookies.filter(
    (c) =>
      c.httpOnly ||
      c.name.toLowerCase().includes("session") ||
      c.name.toLowerCase().includes("token") ||
      c.name.toLowerCase().includes("auth") ||
      c.name.toLowerCase().includes("jsessionid") ||
      c.name.toLowerCase().includes("sid"),
  );
  return sessionCookies.length > 0 ? cookies : null;
}

function announceSessions() {
  if (!tunnelOk || !tunnel) return;
  const active = activeSessions();
  if (active.length === 0) return;
  tunnel.send(
    JSON.stringify({
      type: "SESSIONS_AVAILABLE",
      count: active.length,
      payers: active.map((s) => s.payerCode),
    }),
  );
  log(
    `[Portal] Announced ${active.length} active session(s): ${active.map((s) => s.payerCode).join(", ")}`,
  );
}

async function loadSavedPortalSessions() {
  if (!config.office_id) return;
  let restored = 0;
  for (const portal of PORTALS) {
    const cookies = await checkPartitionCookies(portal);
    if (cookies) {
      storeSession(
        config.office_id,
        portal.payerCode,
        cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          sameSite: c.sameSite,
          expirationDate: c.expirationDate,
        })),
      );
      log(`[Portal] Restored saved session: ${portal.payerName}`);
      restored++;
    }
  }
  if (restored > 0) announceSessions();
}

let portalWindows = {};

function openPortalWindow(portal) {
  if (portalWindows[portal.payerCode]) {
    portalWindows[portal.payerCode].focus();
    return;
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 750,
    title: `EDiFi — Connect ${portal.payerName}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: portal.partition,
    },
  });

  portalWindows[portal.payerCode] = win;
  win.loadURL(portal.url);

  const checkAndCapture = async () => {
    const cookies = await checkPartitionCookies(portal);
    if (!cookies) return;
    log(
      `[Portal] Session captured: ${portal.payerName} (${cookies.length} cookies)`,
    );
    storeSession(
      config.office_id,
      portal.payerCode,
      cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate,
      })),
    );
    announceSessions();
    updateTray();
    win.close();
  };

  win.webContents.on("did-navigate", checkAndCapture);
  win.webContents.on("did-finish-load", checkAndCapture);
  win.on("closed", () => {
    delete portalWindows[portal.payerCode];
  });
}

// ─── Agent Hello ──────────────────────────────────────────────────────────────
// Sent immediately after tunnel connects. Provides version, capabilities, and
// safe status snapshots. No credentials, no PHI, no raw secrets.

function getMachineIdHash() {
  if (!config.machine_id) return null;
  return createHash("sha256").update(config.machine_id).digest("hex");
}

function getSafeConfigStatus() {
  return {
    office_id_present: !!config.office_id,
    od_mysql_config_present: false, // set below after mysql check
    od_api_url_present: !!config.od_api_url,
    portal_sessions_count: activeSessions().length,
    has_bridge_url: !!EDIFI_CLOUD_WS,
  };
}

async function sendAgentHello() {
  if (!tunnel || !tunnelOk) return;
  const mysqlOk = await isMysqlAvailable().catch(() => false);
  od_sync_status.available = mysqlOk || !!config.od_api_url;
  const configStatus = getSafeConfigStatus();
  configStatus.od_mysql_config_present = mysqlOk;

  const hello = {
    type: "AGENT_HELLO",
    office_id: config.office_id,
    app_version: app.getVersion(),
    machine_id_hash: getMachineIdHash(),
    agent_instance_id: AGENT_INSTANCE_ID,
    os_platform: os.platform(),
    capabilities: AGENT_CAPABILITIES,
    started_at: new Date().toISOString(),
    update_status: { ...update_status },
    od_sync_status: { ...od_sync_status },
    safe_config_status: configStatus,
  };

  tunnel.send(JSON.stringify(hello));
  log(
    `[RemoteControl] AGENT_HELLO sent: v${app.getVersion()} caps=${AGENT_CAPABILITIES.length}`,
  );
}

// ─── Remote Command Router ────────────────────────────────────────────────────
// Handles COMMAND_REQUEST messages from the server.
// Safety rules:
//   - Reject unknown command types
//   - Reject expired commands
//   - Reject commands with wrong office_id
//   - Send COMMAND_ACK immediately on receipt
//   - Return COMMAND_RESULT when done
//   - Never return credentials, tokens, PHI, or raw config values

async function handleCommand(msg) {
  const {
    command_id,
    command_type,
    payload,
    expires_at,
    office_id: cmdOfficeId,
  } = msg;

  // Validate required fields
  if (!command_id || !command_type) {
    log("[RemoteControl] Rejected command: missing command_id or command_type");
    return;
  }

  // Validate office scope
  if (cmdOfficeId && cmdOfficeId !== config.office_id) {
    log(`[RemoteControl] Rejected command ${command_id}: office_id mismatch`);
    return;
  }

  // Validate expiry
  if (expires_at && new Date(expires_at) < new Date()) {
    log(
      `[RemoteControl] Rejected command ${command_id}: expired at ${expires_at}`,
    );
    sendCommandResult(
      command_id,
      command_type,
      "FAILED",
      null,
      "EXPIRED",
      "Command expired before delivery",
    );
    return;
  }

  // Validate command type is in capability list
  if (!AGENT_CAPABILITIES.includes(command_type)) {
    log(`[RemoteControl] Rejected unknown command type: ${command_type}`);
    sendCommandResult(
      command_id,
      command_type,
      "FAILED",
      null,
      "UNKNOWN_COMMAND",
      `Command type not supported: ${command_type}`,
    );
    return;
  }

  // Send ACK immediately
  sendCommandAck(command_id);
  log(
    `[RemoteControl] Handling command: ${command_type} (${command_id.slice(0, 8)})`,
  );

  try {
    switch (command_type) {
      case "REPORT_STATUS":
        await handleReportStatus(command_id);
        break;
      case "REPORT_CONFIG_STATUS":
        await handleReportConfigStatus(command_id);
        break;
      case "REPORT_UPDATE_STATUS":
        await handleReportUpdateStatus(command_id);
        break;
      case "REPORT_OD_STATUS":
        await handleReportOdStatus(command_id);
        break;
      case "CHECK_FOR_UPDATE":
        await handleCheckForUpdate(command_id);
        break;
      case "DOWNLOAD_UPDATE":
        await handleDownloadUpdate(command_id);
        break;
      case "SYNC_OD_NOW":
        await handleSyncOdNow(command_id, payload);
        break;
      case "WRITE_OD_BENEFITS":
        await handleWriteOdBenefits(command_id, payload);
        break;
      case "GET_SESSION_COOKIES":
        await handleGetSessionCookies(command_id, payload);
        break;
      case "CLEAR_SESSION_COOKIES":
        await handleClearSessionCookies(command_id, payload);
        break;
      case "RESTART_APP":
        await handleRestartApp(command_id);
        break;
      case "QUIT_AND_INSTALL":
        await handleQuitAndInstall(command_id);
        break;
      default:
        sendCommandResult(
          command_id,
          command_type,
          "FAILED",
          null,
          "UNKNOWN_COMMAND",
          `Unhandled command: ${command_type}`,
        );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`[RemoteControl] Command error ${command_type}: ${msg}`);
    sendCommandResult(
      command_id,
      command_type,
      "FAILED",
      null,
      "HANDLER_ERROR",
      msg.slice(0, 200),
    );
  }
}

function sendCommandAck(commandId) {
  if (!tunnel || !tunnelOk) return;
  tunnel.send(
    JSON.stringify({
      type: "COMMAND_ACK",
      command_id: commandId,
      agent_instance_id: AGENT_INSTANCE_ID,
      received_at: new Date().toISOString(),
    }),
  );
}

function sendCommandResult(
  commandId,
  commandType,
  status,
  result,
  errorCode,
  errorMessage,
) {
  if (!tunnel || !tunnelOk) return;
  tunnel.send(
    JSON.stringify({
      type: "COMMAND_RESULT",
      command_id: commandId,
      command_type: commandType,
      agent_instance_id: AGENT_INSTANCE_ID,
      status,
      result: result ?? null,
      error_code: errorCode ?? null,
      error_message: errorMessage ?? null,
      completed_at: new Date().toISOString(),
    }),
  );
}

// ── REPORT_STATUS ─────────────────────────────────────────────────────────────

async function handleReportStatus(commandId) {
  const mysqlOk = await isMysqlAvailable().catch(() => false);
  const result = {
    app_version: app.getVersion(),
    agent_instance_id: AGENT_INSTANCE_ID,
    os_platform: os.platform(),
    uptime_seconds: Math.floor(process.uptime()),
    capabilities: AGENT_CAPABILITIES,
    bridge_connected: tunnelOk,
    update_status: { ...update_status },
    od_sync_status: {
      ...od_sync_status,
      available: mysqlOk || !!config.od_api_url,
    },
    safe_config_status: {
      ...getSafeConfigStatus(),
      od_mysql_config_present: mysqlOk,
    },
    portal_sessions_count: activeSessions().length,
  };
  sendCommandResult(commandId, "REPORT_STATUS", "COMPLETED", result);
}

// ── REPORT_CONFIG_STATUS ──────────────────────────────────────────────────────
// Returns BOOLEANS ONLY. No URLs, no credentials, no tokens, no connection strings.

async function handleReportConfigStatus(commandId) {
  const mysqlOk = await isMysqlAvailable().catch(() => false);
  const result = {
    office_id_present: !!config.office_id,
    api_key_present: !!config.api_key,
    od_api_url_present: !!config.od_api_url,
    od_customer_key_present: !!config.od_customer_key,
    od_mysql_config_present: mysqlOk,
    machine_id_present: !!config.machine_id,
    portal_sessions_count: activeSessions().length,
    has_bridge_url: !!EDIFI_CLOUD_WS,
  };
  sendCommandResult(commandId, "REPORT_CONFIG_STATUS", "COMPLETED", result);
}

// ── REPORT_UPDATE_STATUS ──────────────────────────────────────────────────────

async function handleReportUpdateStatus(commandId) {
  const result = {
    current_version: app.getVersion(),
    ...update_status,
  };
  sendCommandResult(commandId, "REPORT_UPDATE_STATUS", "COMPLETED", result);
}

// ── REPORT_OD_STATUS ──────────────────────────────────────────────────────────
// Returns OD sync state. No credentials, no connection strings.

async function handleReportOdStatus(commandId) {
  const mysqlOk = await isMysqlAvailable().catch(() => false);
  const result = {
    od_mysql_available: mysqlOk,
    od_api_url_present: !!config.od_api_url,
    ...od_sync_status,
  };
  sendCommandResult(commandId, "REPORT_OD_STATUS", "COMPLETED", result);
}

// ── CHECK_FOR_UPDATE ──────────────────────────────────────────────────────────

async function handleCheckForUpdate(commandId) {
  try {
    update_status.checking = true;
    update_status.last_check_at = new Date().toISOString();
    update_status.last_error = null;
    const checkResult = await autoUpdater.checkForUpdates();
    update_status.checking = false;
    const updateAvailable = !!checkResult?.updateInfo;
    update_status.available = updateAvailable;
    sendCommandResult(commandId, "CHECK_FOR_UPDATE", "COMPLETED", {
      update_available: updateAvailable,
      current_version: app.getVersion(),
      latest_version: checkResult?.updateInfo?.version ?? null,
    });
  } catch (e) {
    update_status.checking = false;
    update_status.last_error = e.message.slice(0, 200);
    sendCommandResult(
      commandId,
      "CHECK_FOR_UPDATE",
      "FAILED",
      null,
      "UPDATE_CHECK_ERROR",
      e.message.slice(0, 200),
    );
  }
}

// ── DOWNLOAD_UPDATE ───────────────────────────────────────────────────────────

async function handleDownloadUpdate(commandId) {
  if (update_status.downloaded) {
    sendCommandResult(commandId, "DOWNLOAD_UPDATE", "COMPLETED", {
      already_downloaded: true,
      current_version: app.getVersion(),
    });
    return;
  }
  if (!update_status.available) {
    sendCommandResult(
      commandId,
      "DOWNLOAD_UPDATE",
      "FAILED",
      null,
      "NO_UPDATE_AVAILABLE",
      "No update available to download. Run CHECK_FOR_UPDATE first.",
    );
    return;
  }
  // autoDownload is true — download is already in progress or will start automatically
  sendCommandResult(commandId, "DOWNLOAD_UPDATE", "COMPLETED", {
    download_in_progress: true,
    note: "autoDownload is enabled; download will complete in background",
    current_version: app.getVersion(),
  });
}

// ── SYNC_OD_NOW ───────────────────────────────────────────────────────────────

async function handleSyncOdNow(commandId, payload) {
  od_sync_status.last_attempt_at = new Date().toISOString();
  const syncDate = payload?.sync_date || null; // null = today
  const mysqlOk = await isMysqlAvailable().catch(() => false);

  if (!mysqlOk && !config.od_api_url) {
    od_sync_status.last_error =
      "Neither OD MySQL nor OD Web Service is configured";
    sendCommandResult(
      commandId,
      "SYNC_OD_NOW",
      "FAILED",
      null,
      "OD_NOT_CONFIGURED",
      od_sync_status.last_error,
    );
    return;
  }

  try {
    // Report STARTED before the sync begins
    if (tunnel && tunnelOk) {
      tunnel.send(
        JSON.stringify({
          type: "COMMAND_RESULT",
          command_id: commandId,
          command_type: "SYNC_OD_NOW",
          agent_instance_id: AGENT_INSTANCE_ID,
          status: "STARTED",
          completed_at: new Date().toISOString(),
        }),
      );
    }

    if (mysqlOk) {
      await syncODMySql(syncDate);
    } else {
      await syncODData();
    }

    od_sync_status.last_success_at = new Date().toISOString();
    od_sync_status.last_error = null;

    sendCommandResult(commandId, "SYNC_OD_NOW", "COMPLETED", {
      sync_method: mysqlOk ? "od_mysql" : "od_rest_api",
      completed_at: od_sync_status.last_success_at,
    });
  } catch (e) {
    od_sync_status.last_error = e.message.slice(0, 200);
    sendCommandResult(
      commandId,
      "SYNC_OD_NOW",
      "FAILED",
      null,
      "SYNC_ERROR",
      od_sync_status.last_error,
    );
  }
}

// ── WRITE_OD_BENEFITS ─────────────────────────────────────────────────────────
// Writes verified eligibility benefit data back into OD's MySQL database.
// Uses the same MySQL connection as SYNC_OD_NOW — no OD REST API required.
// Supports dry_run=true for preview before committing writes.

async function handleWriteOdBenefits(commandId, payload) {
  const mysqlOk = await isMysqlAvailable().catch(() => false);
  if (!mysqlOk) {
    sendCommandResult(
      commandId,
      "WRITE_OD_BENEFITS",
      "FAILED",
      null,
      "OD_MYSQL_UNAVAILABLE",
      "OD MySQL not available — cannot write benefits",
    );
    return;
  }
  if (!payload?.pat_num) {
    sendCommandResult(
      commandId,
      "WRITE_OD_BENEFITS",
      "FAILED",
      null,
      "MISSING_PAT_NUM",
      "payload.pat_num is required",
    );
    return;
  }

  try {
    const result = await writeOdBenefits({
      pat_num: payload.pat_num,
      benefits: payload.benefits ?? [],
      plan_note: payload.plan_note ?? null,
      source: payload.source ?? null,
      confidence: payload.confidence ?? null,
      dry_run: payload.dry_run === true,
    });

    sendCommandResult(
      commandId,
      "WRITE_OD_BENEFITS",
      result.errors.length === 0 || result.rows_written > 0
        ? "COMPLETED"
        : "FAILED",
      result,
      result.errors.length > 0 ? "PARTIAL_ERRORS" : undefined,
      result.errors.length > 0 ? result.errors.join("; ") : undefined,
    );
  } catch (e) {
    sendCommandResult(
      commandId,
      "WRITE_OD_BENEFITS",
      "FAILED",
      null,
      "WRITE_ERROR",
      e.message.slice(0, 200),
    );
  }
}

// ── GET_SESSION_COOKIES ───────────────────────────────────────────────────────
// Returns authenticated portal session cookies for a specific payer.
// Called by Railway before launching a portal scraper so the scraper can inject
// the live session instead of doing a credential-based login.
// Cookie values are NEVER logged — only transmitted over the encrypted WSS tunnel.

async function handleGetSessionCookies(commandId, payload) {
  const payerCode = payload?.payer_code;
  if (!payerCode) {
    sendCommandResult(commandId, 'GET_SESSION_COOKIES', 'FAILED', null,
      'MISSING_PAYER_CODE', 'payload.payer_code is required');
    return;
  }

  const session = getSession(config.office_id, payerCode);
  if (!session) {
    sendCommandResult(commandId, 'GET_SESSION_COOKIES', 'COMPLETED', {
      payer_code: payerCode,
      available: false,
      cookies: null,
      reason: 'No active session for this payer',
    });
    return;
  }

  const ageMinutes = Math.round((Date.now() - session.at) / 60000);
  const remainingMinutes = Math.round((SESSION_TTL - (Date.now() - session.at)) / 60000);

  // Transmit cookies over encrypted WSS — never log values
  log(`[Portal] GET_SESSION_COOKIES: sending ${session.cookies.length} cookies for ${payerCode} (age: ${ageMinutes}min, expires in: ${remainingMinutes}min)`);

  sendCommandResult(commandId, 'GET_SESSION_COOKIES', 'COMPLETED', {
    payer_code: payerCode,
    available: true,
    cookies: session.cookies,
    captured_at: new Date(session.at).toISOString(),
    age_minutes: ageMinutes,
    expires_in_minutes: remainingMinutes,
  });
}

// ── CLEAR_SESSION_COOKIES ─────────────────────────────────────────────────────

async function handleClearSessionCookies(commandId, payload) {
  const payerCode = payload?.payer_code;
  if (payerCode) {
    sessions.delete(`${config.office_id}:${payerCode}`);
    log(`[Portal] CLEAR_SESSION_COOKIES: cleared session for ${payerCode}`);
    sendCommandResult(commandId, 'CLEAR_SESSION_COOKIES', 'COMPLETED', { payer_code: payerCode, cleared: true });
  } else {
    // Clear all sessions
    const count = sessions.size;
    sessions.clear();
    log(`[Portal] CLEAR_SESSION_COOKIES: cleared all ${count} sessions`);
    sendCommandResult(commandId, 'CLEAR_SESSION_COOKIES', 'COMPLETED', { cleared_count: count });
  }
}

// ── RESTART_APP ───────────────────────────────────────────────────────────────

async function handleRestartApp(commandId) {
  // Send result BEFORE restarting — once app exits, tunnel drops
  sendCommandResult(commandId, "RESTART_APP", "COMPLETED", {
    restarting: true,
    note: "App will disconnect and reconnect with fresh session",
  });
  log("[RemoteControl] Restarting app on server command");
  // Small delay so ACK and RESULT have time to transmit
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 500);
}

// ── QUIT_AND_INSTALL ──────────────────────────────────────────────────────────

async function handleQuitAndInstall(commandId) {
  if (!update_status.downloaded) {
    sendCommandResult(
      commandId,
      "QUIT_AND_INSTALL",
      "FAILED",
      null,
      "UPDATE_NOT_DOWNLOADED",
      "Update must be downloaded before installing. Run CHECK_FOR_UPDATE and wait for download to complete.",
    );
    return;
  }
  // Send result BEFORE quitting
  sendCommandResult(commandId, "QUIT_AND_INSTALL", "COMPLETED", {
    installing: true,
    note: "App will quit and install the downloaded update",
  });
  log("[RemoteControl] Quitting and installing update on server command");
  setTimeout(() => {
    autoUpdater.quitAndInstall(false, true);
  }, 500);
}

// ─── Tunnel to EDiFi Cloud ────────────────────────────────────────────────────

let tunnel = null;
let tunnelOk = false;
let reconnectTimer = null;
let odSyncInterval = null;
let lastOdSync = null;

function connectTunnel() {
  if (!config.registered || !config.office_id) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  const url = `${EDIFI_CLOUD_WS}/connect/bridge?office_id=${encodeURIComponent(config.office_id)}`;
  log(`Tunnel connecting: ${url}`);

  tunnel = new WebSocket(url);

  tunnel.on("open", () => {
    tunnelOk = true;
    log("Tunnel connected to EDiFi Cloud");
    updateTray();
    // Send AGENT_HELLO first — backend stores version and capabilities
    sendAgentHello().catch((e) =>
      log(`[RemoteControl] AGENT_HELLO error: ${e.message}`),
    );
    // Restore sessions saved from previous portal logins, then announce
    loadSavedPortalSessions().then(() => {
      // Also announce any sessions already in memory from this run
      announceSessions();
    });
    // Start OD sync immediately then every 15 minutes.
    // If OD Web Service (od_api_url) is not configured, fall back to direct MySQL sync.
    if (config.od_api_url) {
      syncODData();
      if (odSyncInterval) clearInterval(odSyncInterval);
      odSyncInterval = setInterval(syncODData, 15 * 60 * 1000);
    } else {
      syncODMySql();
      if (odSyncInterval) clearInterval(odSyncInterval);
      odSyncInterval = setInterval(syncODMySql, 15 * 60 * 1000);
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
      // SESSION_REQUEST — server asks for raw portal cookies for server-side scraping.
      // Safer than Playwright on the office machine: browser runs on Railway + proxy.
      if (msg.type === "SESSION_REQUEST") {
        const session = getSession(config.office_id, msg.payer_code);
        log(
          `[SESSION_REQUEST] ${msg.payer_code}: ${session ? session.cookies.length + " cookies" : "no session"}`,
        );
        tunnel.send(
          JSON.stringify({
            type: "SESSION_RESPONSE",
            scrape_id: msg.scrape_id,
            payer_code: msg.payer_code,
            cookies: session?.cookies ?? [],
          }),
        );
      }
      // OD_BENEFIT_REQUEST — server asks for OD benefit data for a specific patient.
      // Looks up PatNum by name+DOB, returns full insurance snapshot from MySQL.
      if (msg.type === "OD_BENEFIT_REQUEST") {
        const { scrape_id, first_name, last_name, birth_date, pat_num } = msg;
        log(
          `[OD Benefit] Request for ${first_name} ${last_name} (${birth_date || pat_num})`,
        );
        try {
          const resolvedPatNum =
            pat_num ||
            (await getPatNumByNameDOB(first_name, last_name, birth_date));
          if (!resolvedPatNum) {
            tunnel.send(
              JSON.stringify({
                type: "OD_BENEFIT_RESPONSE",
                scrape_id,
                found: false,
                reason: "patient_not_found",
              }),
            );
          } else {
            const snapshot = await getPatientInsuranceSnapshot(resolvedPatNum);
            tunnel.send(
              JSON.stringify({
                type: "OD_BENEFIT_RESPONSE",
                scrape_id,
                found: true,
                pat_num: resolvedPatNum,
                ...snapshot,
              }),
            );
            log(
              `[OD Benefit] Sent snapshot for PatNum ${resolvedPatNum}: ${snapshot?.benefits?.length ?? 0} benefits`,
            );
          }
        } catch (e) {
          log(`[OD Benefit] Error: ${e.message}`);
          tunnel.send(
            JSON.stringify({
              type: "OD_BENEFIT_RESPONSE",
              scrape_id,
              found: false,
              reason: e.message,
            }),
          );
        }
      }
      if (msg.type === "OD_PUSH_ACK") {
        log(
          `[OD Sync] ACK: ${msg.patients_processed} patients, ${msg.verifications_queued} verifications for ${msg.date}`,
        );
        lastOdSync = new Date();
        updateTray();
      }
      if (msg.type === "OD_WRITEBACK_REQUEST") {
        const { snapshot_id, fields, source, verified_at } = msg;
        log(`[Writeback] Request for snapshot ${snapshot_id} source=${source}`);
        writebackToOD(snapshot_id, fields)
          .then((result) => {
            tunnel.send(
              JSON.stringify({
                type: "OD_WRITEBACK_ACK",
                snapshot_id,
                success: result.success,
                fields_written: result.fields_written,
              }),
            );
          })
          .catch((err) => {
            log(
              `[Writeback] Error for snapshot ${snapshot_id}: ${err.message}`,
            );
            tunnel.send(
              JSON.stringify({
                type: "OD_WRITEBACK_ACK",
                snapshot_id,
                success: false,
                error: err.message,
              }),
            );
          });
      }
      // COMMAND_REQUEST — server-issued remote control command.
      // Handled by the command router which enforces all safety rules.
      if (msg.type === "COMMAND_REQUEST") {
        handleCommand(msg).catch((e) =>
          log(`[RemoteControl] handleCommand error: ${e.message}`),
        );
      }
    } catch (e) {
      log(`Tunnel message error: ${e.message}`);
    }
  });

  tunnel.on("close", () => {
    tunnelOk = false;
    updateTray();
    if (odSyncInterval) {
      clearInterval(odSyncInterval);
      odSyncInterval = null;
    }
    if (!reconnectTimer) {
      log("Tunnel disconnected — reconnecting in 5s");
      reconnectTimer = setTimeout(connectTunnel, 5000);
    }
  });

  tunnel.on("error", (e) => {
    log(`Tunnel error: ${e.message}`);
    tunnelOk = false;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(connectTunnel, 5000);
    }
  });
}

// ─── Open Dental Sync ─────────────────────────────────────────────────────────

function odAuthHeader() {
  if (config.od_customer_key) {
    return { Authorization: `ODFHIR ${OD_DEV_KEY} ${config.od_customer_key}` };
  }
  return {};
}

async function odGet(path) {
  const base = config.od_api_url;
  if (!base) return null;
  try {
    const axios = require("axios");
    const r = await axios.get(`${base}${path}`, {
      timeout: 8000,
      headers: odAuthHeader(),
    });
    return r.data;
  } catch (e) {
    if (e.response?.status === 404) return null;
    if (e.response?.status === 401) {
      log(`[OD] Auth failed — check OD customer key in settings`);
      return null;
    }
    log(`[OD] GET ${path} failed: ${e.message}`);
    return null;
  }
}

// Maps raw OD REST API /insbenefits entries to EDiFi benefit format.
// OD BenefitType 6 = CoInsurance (plan pays X%), 4 = Deductible, 1 = Frequency.
// CovCatNum default mapping assumes standard OD category sequence.
let odCovCatCache = null; // { catNum: 'PREVENTIVE', ... }

async function getOdCovCats() {
  if (odCovCatCache) return odCovCatCache;
  // Default OD categories — used when /covcat endpoint unavailable
  const defaults = {
    1: "DIAGNOSTIC",
    2: "PREVENTIVE",
    3: "BASIC",
    4: "ENDODONTIC",
    5: "PERIODONTIC",
    6: "ORAL_SURGERY",
    7: "PROSTHODONTIA",
    8: "IMPLANT",
    9: "ORTHODONTIC",
    10: "PREVENTIVE",
    11: "GENERAL",
    12: "MAJOR",
    13: "PROSTHODONTIA",
    14: "PROSTHODONTIA",
  };
  try {
    const cats = await odGet("/covcat");
    if (Array.isArray(cats) && cats.length > 0) {
      const map = {};
      for (const c of cats) {
        // Map EbenefitCat to category code; fall back to description-based detection
        const desc = (c.Description || "").toUpperCase();
        let cat = "GENERAL";
        if (desc.includes("PREVENT")) cat = "PREVENTIVE";
        else if (desc.includes("BASIC") || desc.includes("RESTOR"))
          cat = "BASIC";
        else if (desc.includes("MAJOR")) cat = "MAJOR";
        else if (desc.includes("ENDO")) cat = "ENDODONTIC";
        else if (desc.includes("PERIO")) cat = "PERIODONTIC";
        else if (desc.includes("ORAL") || desc.includes("SURGERY"))
          cat = "ORAL_SURGERY";
        else if (desc.includes("ORTHO")) cat = "ORTHODONTIC";
        else if (desc.includes("IMPLANT")) cat = "IMPLANT";
        else if (
          desc.includes("PROSTHO") ||
          desc.includes("CROWN") ||
          desc.includes("BRIDGE")
        )
          cat = "PROSTHODONTIA";
        else if (desc.includes("DIAGN")) cat = "DIAGNOSTIC";
        map[c.CovCatNum] = cat;
      }
      odCovCatCache = map;
      return map;
    }
  } catch {}
  odCovCatCache = defaults;
  return defaults;
}

function mapOdApiBenefits(rawBenefits) {
  const BEN_TYPE = {
    1: "Frequency",
    3: "Copay",
    4: "Deductible",
    6: "CoInsurance",
  };
  const COV_LEVEL = { 0: "None", 1: "Individual", 2: "Family" };
  const TIME_PERIOD = {
    0: "None",
    1: "ServiceYear",
    2: "CalendarYear",
    3: "Lifetime",
    4: "Years2",
    5: "Years3",
    8: "Months6",
    12: "Months24",
  };
  // Use cached covcat if available, else default numeric mapping
  const catMap = odCovCatCache || {
    1: "DIAGNOSTIC",
    2: "PREVENTIVE",
    3: "BASIC",
    4: "ENDODONTIC",
    5: "PERIODONTIC",
    6: "ORAL_SURGERY",
    7: "PROSTHODONTIA",
    8: "IMPLANT",
    9: "ORTHODONTIC",
    10: "PREVENTIVE",
    11: "GENERAL",
    12: "MAJOR",
  };

  const results = [];
  for (const b of rawBenefits) {
    const type = BEN_TYPE[b.BenefitType];
    if (!type) continue;
    const category = catMap[b.CovCatNum] || "GENERAL";
    const coverage_level = COV_LEVEL[b.CoverageLevel] || "None";
    const entry = { type, category, coverage_level };
    if (type === "CoInsurance") entry.percent = Number(b.Percent);
    else if (type === "Deductible")
      entry.amount_cents = Math.round(Number(b.MonetaryAmt) * 100);
    else if (type === "Frequency") {
      entry.quantity = b.Quantity;
      entry.period = TIME_PERIOD[b.TimePeriod] || "None";
    }
    results.push(entry);
  }
  return results.filter((b) =>
    b.type === "CoInsurance" ? b.percent > 0 : true,
  );
}

async function syncODData() {
  if (!config.od_api_url || !config.office_id) return;
  if (!tunnelOk || !tunnel) {
    log("[OD Sync] Skipped — tunnel not connected");
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  log(`[OD Sync] Starting for ${today}...`);

  try {
    // 1. Get today's scheduled appointments
    const allApts = (await odGet(`/appointments?date=${today}`)) ?? [];
    const scheduled = Array.isArray(allApts)
      ? allApts.filter((a) => a.AptStatus === "Scheduled")
      : [];

    if (scheduled.length === 0) {
      log("[OD Sync] No scheduled appointments today");
      return;
    }

    log(
      `[OD Sync] ${scheduled.length} scheduled appointments — fetching patient data...`,
    );

    // Pre-warm coverage category cache so benefit mapping is accurate
    await getOdCovCats();

    // 2. For each appointment, fetch patient + insurance (batch of 3)
    const enriched = [];
    const BATCH = 3;
    for (let i = 0; i < scheduled.length; i += BATCH) {
      const batch = scheduled.slice(i, i + BATCH);
      const results = await Promise.all(
        batch.map(async (apt) => {
          try {
            const patient = await odGet(`/patients/${apt.PatNum}`);
            if (!patient) return null;

            // Fetch insurance chain
            const patPlans =
              (await odGet(`/patplans?PatNum=${apt.PatNum}`)) ?? [];
            const insSubs = [],
              insPlans = [],
              carriers = [];

            for (const pp of patPlans.slice(0, 2)) {
              // primary + secondary only
              const sub = await odGet(`/inssubs/${pp.InsSubNum}`);
              if (sub) {
                insSubs.push(sub);
                const plan = await odGet(`/insplans/${sub.PlanNum}`);
                if (plan) {
                  insPlans.push(plan);
                  const carrier = await odGet(`/carriers/${plan.CarrierNum}`);
                  if (carrier) carriers.push(carrier);
                }
              }
            }

            // Pull benefit data (coinsurance %, deductibles, frequencies) from OD.
            // Source priority: OD REST API → OD MySQL → empty
            // OD REST API is preferred because it reflects what staff entered in OD directly.
            let benefits = [];
            const primarySub = insSubs[0];
            const primaryPlan = insPlans[0];

            // Source 1: OD REST API /insbenefits — reads the benefit table directly
            if (primaryPlan?.PlanNum) {
              try {
                const rawBenefits = await odGet(
                  `/insbenefits?InsPlanNum=${primaryPlan.PlanNum}`,
                );
                if (Array.isArray(rawBenefits) && rawBenefits.length > 0) {
                  benefits = mapOdApiBenefits(rawBenefits);
                  if (benefits.length > 0) {
                    log(
                      `[OD Benefits] ${benefits.length} benefits from REST API for PatNum ${apt.PatNum} (Plan ${primaryPlan.PlanNum})`,
                    );
                  }
                }
              } catch (e) {
                log(
                  `[OD Benefits] REST API failed for PatNum ${apt.PatNum}: ${e.message}`,
                );
              }
            }

            // Source 2: OD MySQL fallback — direct database read when REST API unavailable
            if (benefits.length === 0) {
              try {
                if (await isMysqlAvailable()) {
                  benefits = await getBenefitsForPatient(apt.PatNum);
                  if (benefits.length > 0) {
                    log(
                      `[OD MySQL] ${benefits.length} benefits for PatNum ${apt.PatNum}`,
                    );
                  }
                }
              } catch (e) {
                log(
                  `[OD MySQL] benefit query error for PatNum ${apt.PatNum}: ${e.message}`,
                );
              }
            }

            return {
              ...apt,
              patient,
              insurance: { patPlans, insSubs, insPlans, carriers },
              benefits,
            };
          } catch (e) {
            log(`[OD Sync] Skipping PatNum ${apt.PatNum}: ${e.message}`);
            return null;
          }
        }),
      );
      enriched.push(...results.filter(Boolean));
    }

    if (enriched.length === 0) {
      log("[OD Sync] No appointments with complete patient data");
      return;
    }

    // 3. Push through the tunnel
    log(
      `[OD Sync] Pushing ${enriched.length} enriched appointments to EDiFi Cloud...`,
    );
    tunnel.send(
      JSON.stringify({
        type: "OD_DATA_PUSH",
        date: today,
        appointments: enriched,
      }),
    );
  } catch (e) {
    log(`[OD Sync] Error: ${e.message}`);
  }
}

// ─── OD MySQL-Only Sync ───────────────────────────────────────────────────────
// Runs when od_api_url is not configured (OD Web Service not set up).
// Reads today's appointments and patient insurance directly from MySQL,
// then pushes to EDiFi Cloud so benefit breakdowns are populated without REST API.

async function syncODMySql(syncDate) {
  if (!tunnelOk || !tunnel) {
    log("[OD MySQL Sync] Skipped — tunnel not connected");
    return;
  }
  if (!(await isMysqlAvailable())) {
    log("[OD MySQL Sync] MySQL not available — skipping");
    return;
  }

  const targetDate = syncDate || new Date().toISOString().slice(0, 10);
  od_sync_status.last_attempt_at = new Date().toISOString();
  log(`[OD MySQL Sync] Starting direct MySQL sync for ${targetDate}...`);
  try {
    const apts = await getAppointmentsForDate(targetDate);
    if (apts.length === 0) {
      log(`[OD MySQL Sync] No scheduled appointments for ${targetDate}`);
      return;
    }

    log(
      `[OD MySQL Sync] ${apts.length} appointments — pulling insurance snapshots...`,
    );
    const enriched = [];
    for (const apt of apts) {
      try {
        const snapshot = await getPatientInsuranceSnapshot(apt.PatNum);
        if (!snapshot) continue;
        enriched.push({
          AptNum: apt.AptNum,
          PatNum: apt.PatNum,
          AptDateTime: apt.AptDateTime,
          patient: {
            FName: apt.FName,
            LName: apt.LName,
            Birthdate: apt.Birthdate,
            HmPhone: apt.HmPhone,
            WkPhone: apt.WkPhone,
            Email: apt.Email,
          },
          insurance: snapshot.plans,
          benefits: snapshot.benefits,
          source: "od_mysql",
        });
      } catch (e) {
        log(`[OD MySQL Sync] Skipping PatNum ${apt.PatNum}: ${e.message}`);
      }
    }

    if (enriched.length === 0) {
      log("[OD MySQL Sync] No insurance data found");
      return;
    }

    log(
      `[OD MySQL Sync] Pushing ${enriched.length} appointments to EDiFi Cloud...`,
    );
    tunnel.send(
      JSON.stringify({
        type: "OD_DATA_PUSH",
        date: targetDate,
        appointments: enriched,
        source: "od_mysql",
      }),
    );
    od_sync_status.last_success_at = new Date().toISOString();
    od_sync_status.last_error = null;
    od_sync_status.last_counts = { appointments: enriched.length };
  } catch (e) {
    od_sync_status.last_error = e.message.slice(0, 200);
    log(`[OD MySQL Sync] Error: ${e.message}`);
  }
}

/**
 * Write EDiFi-verified benefit data back to Open Dental via Web Service.
 * Only writes the 4 governance-approved fields — never member_id or group_number.
 * Returns { success, fields_written } or throws on hard failure.
 */
async function writebackToOD(snapshotId, fields) {
  if (!config.od_api_url) {
    throw new Error(
      "od_api_url not configured — cannot write back to Open Dental",
    );
  }

  const axios = require("axios");
  const written = [];

  // Open Dental Web Service uses REST endpoints on PatPlan/InsSub for insurance fields.
  // We look up the PatPlanNum by matching the snapshot_id we stored in OD's Note field
  // on the last sync, then PATCH the insurance fields.
  // Since we don't store OD PatPlanNum directly, we use the eligibility_status note
  // approach: write fields to the PatPlan note field as structured text.
  // Full OD insurance API write-back (D2000 equivalent) requires knowing PatPlanNum
  // which is available on the Electron side from the last OD sync cache.

  try {
    // Attempt to POST fields to a custom EDiFi endpoint on the OD Web Service bridge.
    // The OD Web Service doesn't have a native benefit write-back — this posts to the
    // local bridge's /writeback endpoint which the office's IT can configure.
    const r = await axios.post(
      `${config.od_api_url}/edifi/writeback`,
      {
        snapshot_id: snapshotId,
        fields: {
          eligibility_status: fields.eligibility_status,
          individual_deductible_remaining:
            fields.individual_deductible_remaining,
          annual_maximum_remaining: fields.annual_maximum_remaining,
          benefit_year_type: fields.benefit_year_type,
        },
        source: "edifi_verified",
      },
      { timeout: 10000 },
    );

    if (r.data?.success) {
      written.push(...Object.keys(fields));
      log(
        `[Writeback] Snapshot ${snapshotId} written OK: ${written.join(", ")}`,
      );
      return { success: true, fields_written: written };
    }

    log(
      `[Writeback] Snapshot ${snapshotId} OD returned failure: ${JSON.stringify(r.data)}`,
    );
    return { success: false, fields_written: [] };
  } catch (err) {
    // 404 = endpoint not yet configured on this office's OD bridge — non-fatal
    if (err.response?.status === 404) {
      log(
        `[Writeback] OD writeback endpoint not available for this office (404) — skipping`,
      );
      return { success: false, fields_written: [] };
    }
    throw err;
  }
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
  const { member_id, subscriber_dob, subscriber_last_name } = patientInfo;

  // Convert YYYY-MM-DD → MM/DD/YYYY for portal forms
  function fmtDob(dob) {
    if (!dob) return "";
    const m = dob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[2]}/${m[3]}/${m[1]}` : dob;
  }

  const dob = fmtDob(subscriber_dob);

  // Fill a form field by trying multiple selector strategies in order
  async function fillField(pg, selectors, value) {
    for (const sel of selectors) {
      try {
        const el = await pg.$(sel);
        if (el) {
          await el.fill(value);
          return true;
        }
      } catch {}
    }
    return false;
  }

  // Click a button by trying multiple selector strategies
  async function clickButton(pg, selectors) {
    for (const sel of selectors) {
      try {
        const el = await pg.$(sel);
        if (el) {
          await el.click();
          return true;
        }
      } catch {}
    }
    return false;
  }

  // Parse benefit rows out of a results container
  // Looks for table rows or definition lists containing coverage category keywords
  function parseBenefitRows(html) {
    const benefits = [];
    const categoryPatterns = [
      { key: "PREVENTIVE", rx: /preventive|prev\b/i },
      { key: "BASIC", rx: /basic|restorative/i },
      { key: "MAJOR", rx: /major/i },
      { key: "ENDODONTIC", rx: /endo/i },
      { key: "PERIODONTIC", rx: /perio/i },
      { key: "ORAL_SURGERY", rx: /oral\s*surg/i },
      { key: "ORTHODONTIC", rx: /ortho/i },
    ];
    const pctRx = /(\d{1,3})\s*%/g;
    const freqRx = /(\d+)\s*x\s*(\/\s*(yr|year|per\s*year))/i;

    // Split on <tr or common block boundaries to isolate rows
    const rows = html.split(/<tr[\s>]|<div[\s>]|<li[\s>]/i);
    for (const row of rows) {
      for (const cat of categoryPatterns) {
        if (!cat.rx.test(row)) continue;
        const pcts = [...row.matchAll(pctRx)].map((m) => parseInt(m[1], 10));
        if (pcts.length === 0) continue;
        const freqMatch = row.match(freqRx);
        benefits.push({
          category: cat.key,
          coinsurance_pct: pcts[0],
          frequency: freqMatch ? freqMatch[0].trim() : null,
          in_network: true,
        });
        break;
      }
    }
    return benefits;
  }

  // Capture the best available html snapshot from results area
  async function captureSnapshot(pg) {
    return pg
      .$eval(
        [
          ".results",
          ".eligibility-results",
          "#results",
          "#eligibilityResults",
          ".benefits-summary",
          "#benefitsSummary",
          ".benefit-details",
          "#content",
          "main",
          "body",
        ].join(", "),
        (el) => el.innerHTML,
      )
      .catch(() => "");
  }

  try {
    let html_snapshot = "";
    let benefits = [];

    if (payerCode === "DOT") {
      await page.goto("https://www.dentalofficetoolkit.com/dot-ui/", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      // Navigate to eligibility section
      await clickButton(page, [
        'a[href*="eligibility"]',
        'a:has-text("Eligibility")',
        'a:has-text("Elig Check")',
        'nav a:has-text("Elig")',
        'button:has-text("Eligibility")',
      ]);
      await page.waitForLoadState("networkidle").catch(() => {});
      // Fill member lookup form
      await fillField(
        page,
        [
          'input[name*="member" i]',
          'input[name*="subscriber" i]',
          'input[placeholder*="member" i]',
          'input[id*="memberId" i]',
          'input[aria-label*="member" i]',
        ],
        member_id,
      );
      await fillField(
        page,
        [
          'input[name*="dob" i]',
          'input[name*="birth" i]',
          'input[placeholder*="mm/dd" i]',
          'input[id*="dob" i]',
          'input[aria-label*="birth" i]',
        ],
        dob,
      );
      if (subscriber_last_name) {
        await fillField(
          page,
          [
            'input[name*="last" i]',
            'input[placeholder*="last" i]',
            'input[id*="lastName" i]',
            'input[aria-label*="last name" i]',
          ],
          subscriber_last_name,
        );
      }
      await clickButton(page, [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Search")',
        'button:has-text("Check")',
        'button:has-text("Verify")',
        'button:has-text("Submit")',
      ]);
      await page
        .waitForSelector(
          ".results, table.benefits, .eligibility-result, #eligibilityResults",
          { timeout: 20000 },
        )
        .catch(() => {});
      html_snapshot = await captureSnapshot(page);
      benefits = parseBenefitRows(html_snapshot);
    } else if (payerCode === "DDIC") {
      // Navigate directly to provider portal — session cookies make this land logged-in
      // www1.deltadentalins.com/ciam/login has DNS issues; go straight to the dashboard
      await page.goto("https://www.deltadentalins.com/dental-professionals/", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await page.waitForLoadState("networkidle").catch(() => {});
      // Find and click eligibility/benefits search
      await clickButton(page, [
        'a[href*="eligib" i]',
        'a:has-text("Eligibility")',
        'a:has-text("Benefits")',
        'a:has-text("Check Eligibility")',
        'button:has-text("Eligibility")',
        'nav a:has-text("Elig")',
      ]);
      await page.waitForLoadState("networkidle").catch(() => {});
      await fillField(
        page,
        [
          'input[name*="member" i]',
          'input[name*="subscriber" i]',
          'input[name*="id" i]',
          'input[placeholder*="member" i]',
          'input[id*="memberId" i]',
        ],
        member_id,
      );
      await fillField(
        page,
        [
          'input[name*="dob" i]',
          'input[name*="birth" i]',
          'input[placeholder*="date" i]',
          'input[id*="dob" i]',
        ],
        dob,
      );
      if (subscriber_last_name) {
        await fillField(
          page,
          [
            'input[name*="last" i]',
            'input[id*="last" i]',
            'input[placeholder*="last" i]',
          ],
          subscriber_last_name,
        );
      }
      await clickButton(page, [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Search")',
        'button:has-text("Check Eligibility")',
        'button:has-text("Submit")',
      ]);
      await page
        .waitForSelector(
          ".benefits, table, .eligibility, #results, .plan-details",
          { timeout: 20000 },
        )
        .catch(() => {});
      html_snapshot = await captureSnapshot(page);
      benefits = parseBenefitRows(html_snapshot);
    } else if (payerCode === "DDCA") {
      await page.goto("https://dentist.deltadental.com", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await clickButton(page, [
        'a[href*="eligib" i]',
        'a:has-text("Eligibility")',
        'a:has-text("Benefits")',
      ]);
      await page.waitForLoadState("networkidle").catch(() => {});
      await fillField(
        page,
        [
          'input[name*="member" i]',
          'input[name*="subscriber" i]',
          'input[placeholder*="member" i]',
        ],
        member_id,
      );
      await fillField(
        page,
        [
          'input[name*="dob" i]',
          'input[name*="birth" i]',
          'input[placeholder*="date" i]',
        ],
        dob,
      );
      if (subscriber_last_name) {
        await fillField(
          page,
          ['input[name*="last" i]', 'input[placeholder*="last" i]'],
          subscriber_last_name,
        );
      }
      await clickButton(page, [
        'button[type="submit"]',
        'button:has-text("Search")',
        'input[type="submit"]',
      ]);
      await page
        .waitForSelector(".benefits, table, .results, #eligibilityResults", {
          timeout: 20000,
        })
        .catch(() => {});
      html_snapshot = await captureSnapshot(page);
      benefits = parseBenefitRows(html_snapshot);
    } else if (payerCode === "METLIFE") {
      await page.goto("https://dental.provider.metlife.com", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await clickButton(page, [
        'a[href*="eligib" i]',
        'a:has-text("Eligibility")',
        'a:has-text("Benefits")',
      ]);
      await page.waitForLoadState("networkidle").catch(() => {});
      await fillField(
        page,
        [
          'input[name*="member" i]',
          'input[name*="patient" i]',
          'input[placeholder*="member" i]',
          'input[id*="memberId" i]',
        ],
        member_id,
      );
      await fillField(
        page,
        [
          'input[name*="dob" i]',
          'input[name*="birth" i]',
          'input[placeholder*="date" i]',
          'input[id*="dob" i]',
        ],
        dob,
      );
      if (subscriber_last_name) {
        await fillField(
          page,
          ['input[name*="last" i]', 'input[id*="lastName" i]'],
          subscriber_last_name,
        );
      }
      await clickButton(page, [
        'button[type="submit"]',
        'button:has-text("Check Eligibility")',
        'button:has-text("Search")',
        'input[type="submit"]',
      ]);
      await page
        .waitForSelector(".benefits, .eligibility-summary, table, #content", {
          timeout: 20000,
        })
        .catch(() => {});
      html_snapshot = await captureSnapshot(page);
      benefits = parseBenefitRows(html_snapshot);
    } else if (payerCode === "CIGNA") {
      await page.goto("https://cignaforhcp.cigna.com", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await clickButton(page, [
        'a[href*="eligib" i]',
        'a:has-text("Eligibility")',
        'a:has-text("Coverage")',
      ]);
      await page.waitForLoadState("networkidle").catch(() => {});
      await fillField(
        page,
        [
          'input[name*="member" i]',
          'input[name*="id" i]',
          'input[placeholder*="member" i]',
          'input[id*="memberId" i]',
        ],
        member_id,
      );
      await fillField(
        page,
        [
          'input[name*="dob" i]',
          'input[name*="birth" i]',
          'input[placeholder*="date" i]',
        ],
        dob,
      );
      if (subscriber_last_name) {
        await fillField(
          page,
          ['input[name*="last" i]', 'input[placeholder*="last" i]'],
          subscriber_last_name,
        );
      }
      await clickButton(page, [
        'button[type="submit"]',
        'button:has-text("Search")',
        'button:has-text("Find")',
        'input[type="submit"]',
      ]);
      await page
        .waitForSelector(
          ".benefits, .coverage-details, table, #eligibility-results",
          { timeout: 20000 },
        )
        .catch(() => {});
      html_snapshot = await captureSnapshot(page);
      benefits = parseBenefitRows(html_snapshot);
    } else if (payerCode === "GUARDIAN") {
      await page.goto("https://www.guardianlife.com/dental/dentists", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await clickButton(page, [
        'a[href*="eligib" i]',
        'a:has-text("Eligibility")',
        'a:has-text("Benefits")',
        'button:has-text("Eligibility")',
      ]);
      await page.waitForLoadState("networkidle").catch(() => {});
      await fillField(
        page,
        [
          'input[name*="member" i]',
          'input[name*="subscriber" i]',
          'input[placeholder*="member" i]',
          'input[id*="member" i]',
        ],
        member_id,
      );
      await fillField(
        page,
        [
          'input[name*="dob" i]',
          'input[name*="birth" i]',
          'input[placeholder*="date" i]',
        ],
        dob,
      );
      if (subscriber_last_name) {
        await fillField(
          page,
          ['input[name*="last" i]', 'input[placeholder*="last" i]'],
          subscriber_last_name,
        );
      }
      await clickButton(page, [
        'button[type="submit"]',
        'button:has-text("Search")',
        'button:has-text("Check")',
        'input[type="submit"]',
      ]);
      await page
        .waitForSelector(".benefits, .eligibility, table, .plan-summary", {
          timeout: 20000,
        })
        .catch(() => {});
      html_snapshot = await captureSnapshot(page);
      benefits = parseBenefitRows(html_snapshot);
    } else if (payerCode === "UHC") {
      await page.goto("https://www.uhcprovider.com", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await clickButton(page, [
        'a[href*="eligib" i]',
        'a:has-text("Eligibility")',
        'a:has-text("Benefits")',
      ]);
      await page.waitForLoadState("networkidle").catch(() => {});
      await fillField(
        page,
        [
          'input[name*="member" i]',
          'input[name*="id" i]',
          'input[placeholder*="member" i]',
          'input[id*="memberId" i]',
        ],
        member_id,
      );
      await fillField(
        page,
        [
          'input[name*="dob" i]',
          'input[name*="birth" i]',
          'input[placeholder*="date" i]',
        ],
        dob,
      );
      if (subscriber_last_name) {
        await fillField(
          page,
          ['input[name*="last" i]', 'input[placeholder*="last" i]'],
          subscriber_last_name,
        );
      }
      await clickButton(page, [
        'button[type="submit"]',
        'button:has-text("Search")',
        'input[type="submit"]',
      ]);
      await page
        .waitForSelector(".benefits, .eligibility, table, #results", {
          timeout: 20000,
        })
        .catch(() => {});
      html_snapshot = await captureSnapshot(page);
      benefits = parseBenefitRows(html_snapshot);
    } else if (payerCode === "SELECTHEALTH") {
      await page.goto("https://providers.selecthealth.org", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await clickButton(page, [
        'a[href*="eligib" i]',
        'a:has-text("Eligibility")',
        'a:has-text("Benefits")',
      ]);
      await page.waitForLoadState("networkidle").catch(() => {});
      await fillField(
        page,
        [
          'input[name*="member" i]',
          'input[name*="subscriber" i]',
          'input[placeholder*="member" i]',
        ],
        member_id,
      );
      await fillField(
        page,
        [
          'input[name*="dob" i]',
          'input[name*="birth" i]',
          'input[placeholder*="date" i]',
        ],
        dob,
      );
      if (subscriber_last_name) {
        await fillField(
          page,
          ['input[name*="last" i]', 'input[placeholder*="last" i]'],
          subscriber_last_name,
        );
      }
      await clickButton(page, [
        'button[type="submit"]',
        'button:has-text("Search")',
        'input[type="submit"]',
      ]);
      await page
        .waitForSelector(".benefits, table, .eligibility, #content", {
          timeout: 20000,
        })
        .catch(() => {});
      html_snapshot = await captureSnapshot(page);
      benefits = parseBenefitRows(html_snapshot);
    } else if (payerCode === "EMIHEALTH") {
      await page.goto("https://www.emihealth.com", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await clickButton(page, [
        'a[href*="eligib" i]',
        'a:has-text("Eligibility")',
        'a:has-text("Provider")',
        'a:has-text("Benefits")',
      ]);
      await page.waitForLoadState("networkidle").catch(() => {});
      await fillField(
        page,
        [
          'input[name*="member" i]',
          'input[name*="subscriber" i]',
          'input[placeholder*="member" i]',
        ],
        member_id,
      );
      await fillField(
        page,
        [
          'input[name*="dob" i]',
          'input[name*="birth" i]',
          'input[placeholder*="date" i]',
        ],
        dob,
      );
      if (subscriber_last_name) {
        await fillField(
          page,
          ['input[name*="last" i]', 'input[placeholder*="last" i]'],
          subscriber_last_name,
        );
      }
      await clickButton(page, [
        'button[type="submit"]',
        'button:has-text("Search")',
        'input[type="submit"]',
      ]);
      await page
        .waitForSelector(".benefits, table, .eligibility, #content", {
          timeout: 20000,
        })
        .catch(() => {});
      html_snapshot = await captureSnapshot(page);
      benefits = parseBenefitRows(html_snapshot);
    } else if (payerCode === "AETNA") {
      await page.goto("https://www.aetna.com/health-care-professionals.html", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await clickButton(page, [
        'a[href*="eligib" i]',
        'a:has-text("Eligibility")',
        'a:has-text("Benefits")',
        'a:has-text("NaviNet")',
        'a[href*="navinet" i]',
      ]);
      await page.waitForLoadState("networkidle").catch(() => {});
      await fillField(
        page,
        [
          'input[name*="member" i]',
          'input[name*="subscriber" i]',
          'input[placeholder*="member" i]',
          'input[id*="memberId" i]',
        ],
        member_id,
      );
      await fillField(
        page,
        [
          'input[name*="dob" i]',
          'input[name*="birth" i]',
          'input[placeholder*="date" i]',
        ],
        dob,
      );
      if (subscriber_last_name) {
        await fillField(
          page,
          ['input[name*="last" i]', 'input[placeholder*="last" i]'],
          subscriber_last_name,
        );
      }
      await clickButton(page, [
        'button[type="submit"]',
        'button:has-text("Search")',
        'button:has-text("Check")',
        'input[type="submit"]',
      ]);
      await page
        .waitForSelector(
          ".benefits, .eligibility, table, #eligibility-result",
          { timeout: 20000 },
        )
        .catch(() => {});
      html_snapshot = await captureSnapshot(page);
      benefits = parseBenefitRows(html_snapshot);
    } else {
      // Unknown payer — capture whatever is on the page
      html_snapshot = await captureSnapshot(page);
    }

    return {
      benefits,
      html_snapshot,
      source: "bridge_portal",
      payer_code: payerCode,
    };
  } catch (err) {
    log(
      `[Scrape] performEligibilityScrape error (${payerCode}): ${err.message}`,
    );
    return {
      benefits: [],
      html_snapshot: "",
      source: "bridge_portal_error",
      error: err.message,
      payer_code: payerCode,
    };
  }
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
  const { payer_code, cookies, payer_name } = req.body;
  if (!payer_code || !cookies?.length)
    return res.status(400).json({ error: "Missing fields" });
  // Always use config.office_id so getSession() can find the session by the Electron app's office.
  // Extension may send a different office_id if its popup was registered separately — ignore it.
  storeSession(config.office_id, payer_code, cookies);
  if (tunnelOk && tunnel) {
    tunnel.send(
      JSON.stringify({
        type: "SESSION_AVAILABLE",
        office_id: config.office_id,
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
      label: "Enter OD Customer Key",
      click: showSetupWindow,
      visible: config.registered && !config.od_customer_key,
    },
    {
      label: "Open EDiFi Dashboard",
      click: () =>
        shell.openExternal("https://edifi-eligibility-platform.netlify.app"),
    },
    { label: "Install Chrome Extension", click: showExtensionInstructions },
    {
      label: lastOdSync
        ? `OD last synced: ${Math.round((Date.now() - lastOdSync) / 60000)}m ago`
        : config.od_api_url
          ? "OD sync pending..."
          : "Open Dental not configured",
      enabled: !!config.od_api_url,
      click: () => {
        if (tunnelOk) syncODData();
      },
    },
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

ipcMain.handle(
  "register",
  async (_, { officeCode, odApiUrl, odCustomerKey }) => {
    const code = officeCode?.trim();
    if (!code || code.length < 8) {
      return { ok: false, error: "Please enter a valid Office Code." };
    }
    config = {
      ...config,
      office_id: code,
      od_api_url: odApiUrl?.trim() || null,
      od_customer_key: odCustomerKey?.trim() || config.od_customer_key || null,
      registered: true,
    };
    saveConfig();
    connectTunnel();
    updateTray();
    log(
      `Office registered: ${code.slice(0, 8)}...${config.od_customer_key ? " (OD key set)" : " (no OD key)"}`,
    );
    return { ok: true };
  },
);

ipcMain.handle("get-status", () => ({
  registered: config.registered,
  office_id: config.office_id,
  tunnel_connected: tunnelOk,
  sessions: activeSessions().length,
}));

ipcMain.handle("get-config", () => ({
  office_id: config.office_id,
  od_api_url: config.od_api_url,
  od_customer_key_set: !!config.od_customer_key,
  registered: config.registered,
}));

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  loadConfig();

  // Wire OD MySQL logger to main app log — failures now show in edifi-connect.log
  setMysqlLogger((msg) => log(`[OD MySQL] ${msg}`));

  // Silent auto-update — checks GitHub on startup, downloads + installs with no user prompt.
  // Every future update after v2.3.0 is completely invisible to office staff.
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("checking-for-update", () => {
      update_status.checking = true;
      update_status.last_check_at = new Date().toISOString();
    });
    autoUpdater.on("update-available", (info) => {
      update_status.checking = false;
      update_status.available = true;
    });
    autoUpdater.on("update-not-available", () => {
      update_status.checking = false;
      update_status.available = false;
    });
    autoUpdater.on("download-progress", () => {
      // download in progress — no-op, downloaded remains false
    });
    autoUpdater.on("update-downloaded", () => {
      update_status.downloaded = true;
      update_status.last_download_at = new Date().toISOString();
      update_status.last_error = null;
      log("[Updater] Update ready — installing silently on next quit");
    });
    autoUpdater.on("error", (err) => {
      update_status.checking = false;
      update_status.last_error = err.message.slice(0, 200);
      log(`[Updater] ${err.message}`);
    });
    autoUpdater.checkForUpdates().catch(() => {});
  } catch {}

  // Offices that upgraded from v2.0.0 inherit a config without od_api_url set.
  // Default it so the OD sync fires without requiring a fresh registration.
  if (config.registered && !config.od_api_url) {
    config.od_api_url = "http://localhost:30222";
    saveConfig();
    log("[OD] Auto-configured OD URL: http://localhost:30222");
  }

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

  // Second auto-update block — registers additional listeners and re-checks on app ready.
  try {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-downloaded", () => {
      update_status.downloaded = true;
      update_status.last_download_at = new Date().toISOString();
      log("[Update] New version downloaded — will install on next restart");
      updateTray();
    });
    autoUpdater.on("error", (err) => {
      update_status.last_error = err.message.slice(0, 200);
      log(`[Update] ${err.message}`);
    });
    autoUpdater.checkForUpdates().catch(() => {});
  } catch (e) {
    log(`[Update] electron-updater not available: ${e.message}`);
  }
});

app.on("window-all-closed", (e) => e.preventDefault()); // Keep running in tray
app.dock?.hide(); // Hide dock icon on macOS
