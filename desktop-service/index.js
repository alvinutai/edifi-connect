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

// ─── Setup Page ───────────────────────────────────────────────────────────────

app.get('/setup', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>EDiFi Connect Setup</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); padding: 32px; width: 100%; max-width: 440px; }
    .logo { display: flex; align-items: center; gap: 10px; margin-bottom: 24px; }
    .logo-box { width: 36px; height: 36px; background: #001f71; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: white; font-weight: 800; font-size: 16px; }
    h1 { font-size: 20px; font-weight: 700; color: #001f71; }
    p { font-size: 13px; color: #6b7280; margin: 8px 0 24px; }
    label { display: block; font-size: 11px; font-weight: 700; color: #374151; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.05em; }
    input { width: 100%; padding: 10px 12px; border: 1.5px solid #d1d5db; border-radius: 8px; font-size: 14px; outline: none; transition: border-color 0.15s; font-family: monospace; }
    input:focus { border-color: #001f71; }
    .hint { font-size: 11px; color: #9ca3af; margin-top: 4px; margin-bottom: 20px; }
    button { width: 100%; padding: 12px; background: #001f71; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.15s; }
    button:hover:not(:disabled) { background: #1a3a95; }
    button:disabled { background: #9ca3af; cursor: not-allowed; }
    .status { margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 13px; text-align: center; display: none; }
    .status.success { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
    .status.error { background: #fef2f2; color: #dc2626; border: 1px solid #fca5a5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <div class="logo-box">E</div>
      <h1>EDiFi Connect Setup</h1>
    </div>
    <p>Connect this computer to EDiFi Cloud. Find your Office Code in EDiFi → Settings → Office tab.</p>
    <label>EDiFi Office Code</label>
    <input type="text" id="code" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" oninput="document.getElementById('btn').disabled=this.value.length<8" autocomplete="off" spellcheck="false">
    <div class="hint">Paste the UUID from your EDiFi Settings page</div>
    <button id="btn" onclick="connect()" disabled>Connect to EDiFi</button>
    <div class="status" id="status"></div>
  </div>
  <script>
    async function connect() {
      const code = document.getElementById('code').value.trim();
      const btn = document.getElementById('btn');
      const status = document.getElementById('status');
      btn.disabled = true; btn.textContent = 'Connecting...';
      status.style.display = 'none';
      try {
        const r = await fetch('/register', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ office_id: code, api_key: null }) });
        const data = await r.json();
        if (data.ok) {
          status.className = 'status success';
          status.innerHTML = '✅ Connected! EDiFi Connect is running.<br><br>Install the Chrome extension to start capturing portal sessions.';
          status.style.display = 'block';
          btn.textContent = 'Connected!';
        } else {
          throw new Error('Connection failed');
        }
      } catch (e) {
        status.className = 'status error';
        status.textContent = 'Could not connect. Check your office code and try again.';
        status.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Connect to EDiFi';
      }
    }
  </script>
</body>
</html>`);
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  console.log(`EDiFi Connect Service running on localhost:${PORT}`);
  console.log(`Registered: ${config.registered} | Office: ${config.office_id || 'none'}`);

  if (config.registered) {
    // Small delay to let server fully start before connecting
    setTimeout(connectTunnel, 2000);
  }
});
