/**
 * EDiFi Connect — Desktop Service
 *
 * Runs on the front-desk PC as a local background service.
 * Receives authenticated portal sessions from the Chrome extension,
 * and executes eligibility scrapes using those sessions — no passwords,
 * no TOTP, no behavioral AI issues because it IS a real office session.
 *
 * Connects back to EDiFi Cloud via WebSocket tunnel to receive scrape
 * requests and return benefit data.
 *
 * Port: 47821 (localhost only)
 */

const express = require('express');
const cors = require('cors');
const { WebSocket } = require('ws');
const { SessionScraper } = require('./scrapers/session-scraper');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = 47821;
const CONFIG_PATH = path.join(process.env.APPDATA || process.env.HOME, '.edifi-connect', 'config.json');
const EDIFI_CLOUD_URL = process.env.EDIFI_CLOUD_URL || 'wss://edifi-ai-eligibility-production.up.railway.app';

// ─── Session Store ────────────────────────────────────────────────────────────
// In-memory store: payer_code → { cookies, captured_at, office_id }
// Sessions expire after 8 hours (re-captured on next portal visit)

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessionStore = new Map();

function storeSession(officeId, payerCode, cookies) {
  sessionStore.set(`${officeId}:${payerCode}`, {
    office_id: officeId,
    payer_code: payerCode,
    cookies,
    captured_at: Date.now(),
  });
  console.log(`[Sessions] Captured: ${payerCode} for office ${officeId.slice(0, 8)}...`);
}

function getSession(officeId, payerCode) {
  const key = `${officeId}:${payerCode}`;
  const session = sessionStore.get(key);
  if (!session) return null;
  // Expire stale sessions
  if (Date.now() - session.captured_at > SESSION_TTL_MS) {
    sessionStore.delete(key);
    return null;
  }
  return session;
}

function getSessionStatus() {
  const active = {};
  for (const [key, session] of sessionStore.entries()) {
    if (Date.now() - session.captured_at < SESSION_TTL_MS) {
      active[session.payer_code] = {
        payer_code: session.payer_code,
        captured_at: session.captured_at,
        age_minutes: Math.floor((Date.now() - session.captured_at) / 60000),
      };
    }
  }
  return active;
}

// ─── Load / Save Config ───────────────────────────────────────────────────────

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch {}
  return { office_id: null, api_key: null, registered: false };
}

function saveConfig(config) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let config = loadConfig();

// ─── Express Server ───────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: ['chrome-extension://*', 'http://localhost:*'] }));
app.use(express.json({ limit: '2mb' }));

// Health check — Chrome extension polls this to verify service is running
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    registered: config.registered,
    office_id: config.office_id,
    active_sessions: Object.keys(getSessionStatus()).length,
    tunnel_connected: tunnelConnected,
  });
});

// Receive session cookies from Chrome extension
app.post('/session', (req, res) => {
  const { office_id, payer_code, cookies, payer_name, domain } = req.body;
  if (!office_id || !payer_code || !cookies?.length) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  storeSession(office_id, payer_code, cookies);

  // Notify EDiFi Cloud that a new session is available
  if (tunnelConnected && wsTunnel) {
    wsTunnel.send(JSON.stringify({
      type: 'SESSION_AVAILABLE',
      office_id,
      payer_code,
      payer_name,
    }));
  }

  res.json({ ok: true, payer: payer_code });
});

// Registration (from EDiFi dashboard setup page)
app.post('/register', (req, res) => {
  const { office_id, api_key } = req.body;
  if (!office_id) return res.status(400).json({ error: 'office_id required' });
  config = { office_id, api_key, registered: true };
  saveConfig(config);
  connectTunnel(); // Start tunnel connection after registration
  res.json({ ok: true });
});

// Status endpoint — EDiFi dashboard can poll this
app.get('/status', (req, res) => {
  res.json({
    registered: config.registered,
    office_id: config.office_id,
    tunnel_connected: tunnelConnected,
    active_sessions: getSessionStatus(),
    session_count: sessionStore.size,
  });
});

// ─── Scrape Handler ───────────────────────────────────────────────────────────

async function handleScrapeRequest(request) {
  const { scrape_id, office_id, payer_code, member_id, subscriber_dob, subscriber_last_name, group_number } = request;
  const scraper = new SessionScraper();

  console.log(`[Scrape] Starting ${payer_code} | member: ${member_id?.slice(0, 6)}...`);

  const session = getSession(office_id, payer_code);
  if (!session) {
    return {
      scrape_id,
      success: false,
      error: 'NO_SESSION',
      message: `No active session for ${payer_code}. Office staff should log into the portal.`,
    };
  }

  try {
    const result = await scraper.scrape({
      payer_code,
      cookies: session.cookies,
      member_id,
      subscriber_dob,
      subscriber_last_name,
      group_number,
    });

    console.log(`[Scrape] ${payer_code} complete — ${result.benefits?.length ?? 0} benefits`);
    return { scrape_id, success: true, data: result };
  } catch (err) {
    console.error(`[Scrape] ${payer_code} failed: ${err.message}`);
    return { scrape_id, success: false, error: 'SCRAPE_FAILED', message: err.message };
  }
}

// ─── WebSocket Tunnel to EDiFi Cloud ─────────────────────────────────────────

let wsTunnel = null;
let tunnelConnected = false;
let reconnectTimer = null;

function connectTunnel() {
  if (!config.registered || !config.office_id) return;

  const url = `${EDIFI_CLOUD_URL}/connect/bridge?office_id=${config.office_id}&api_key=${config.api_key || ''}`;
  console.log(`[Tunnel] Connecting to EDiFi Cloud...`);

  wsTunnel = new WebSocket(url);

  wsTunnel.on('open', () => {
    tunnelConnected = true;
    console.log(`[Tunnel] Connected — office ${config.office_id.slice(0, 8)}...`);

    // Announce available sessions
    const sessions = getSessionStatus();
    if (Object.keys(sessions).length > 0) {
      wsTunnel.send(JSON.stringify({ type: 'SESSIONS_AVAILABLE', sessions }));
    }
  });

  wsTunnel.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'SCRAPE_REQUEST') {
        const result = await handleScrapeRequest(message);
        wsTunnel.send(JSON.stringify({ type: 'SCRAPE_RESULT', ...result }));
      }

      if (message.type === 'PING') {
        wsTunnel.send(JSON.stringify({ type: 'PONG', office_id: config.office_id }));
      }
    } catch (err) {
      console.error('[Tunnel] Message error:', err.message);
    }
  });

  wsTunnel.on('close', () => {
    tunnelConnected = false;
    console.log('[Tunnel] Disconnected — reconnecting in 30s...');
    reconnectTimer = setTimeout(connectTunnel, 30000);
  });

  wsTunnel.on('error', (err) => {
    console.error('[Tunnel] Error:', err.message);
  });
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  console.log(`EDiFi Connect Service running on localhost:${PORT}`);
  console.log(`Registered: ${config.registered} | Office: ${config.office_id || 'none'}`);

  if (config.registered) {
    // Small delay to let server fully start before connecting
    setTimeout(connectTunnel, 2000);
  }
});
