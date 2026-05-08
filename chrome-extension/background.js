/**
 * EDiFi Connect — Chrome Extension Service Worker
 *
 * Monitors dental insurance portal logins. When office staff logs in
 * to a portal (as they do every day), this captures the authenticated
 * session and sends it to the EDiFi Connect desktop service running
 * locally on the front-desk PC.
 *
 * The office never shares passwords or TOTP secrets — EDiFi uses
 * their existing authenticated session instead.
 */

const LOCAL_SERVICE_URL = 'http://localhost:47821';

// Portal domains we capture sessions for, mapped to payer codes
const PORTAL_MAP = {
  'deltadentalins.com':        { payer: 'DDIC',       name: 'Delta Dental (DDIC)' },
  'deltadental.com':           { payer: 'DDCA',       name: 'Delta Dental National' },
  'dentalofficetoolkit.com':   { payer: 'DOT',        name: 'Delta Dental (DOT)' },
  'dental.provider.metlife.com': { payer: 'METLIFE',  name: 'MetLife Dental' },
  'planconnect.metlife.com':   { payer: 'METLIFE',    name: 'MetLife Dental' },
  'cignaforhcp.cigna.com':     { payer: 'CIGNA',      name: 'Cigna Dental' },
  'aetna.com':                 { payer: 'AETNA',      name: 'Aetna Dental' },
  'uhcprovider.com':           { payer: 'UHC',        name: 'UnitedHealthcare Dental' },
  'guardianlife.com':          { payer: 'GUARDIAN',   name: 'Guardian Dental' },
  'selecthealth.org':          { payer: 'SELECTHEALTH', name: 'SelectHealth' },
  'emihealth.com':             { payer: 'EMIHEALTH',  name: 'EMI Health' },
  'deltadentalwa.com':         { payer: 'DDWA',       name: 'Delta Dental WA' },
  'deltadentalil.com':         { payer: 'DDIL',       name: 'Delta Dental IL' },
};

// Track which portals have active sessions
const activeSessions = {};

// Storage key for office registration
const OFFICE_ID_KEY = 'edifi_office_id';
const EDIFI_API_KEY = 'edifi_api_key';

// ─── Session Capture ──────────────────────────────────────────────────────────

/**
 * Detects which portal a URL belongs to.
 */
function detectPortal(url) {
  try {
    const hostname = new URL(url).hostname;
    for (const [domain, info] of Object.entries(PORTAL_MAP)) {
      if (hostname.includes(domain)) return { domain, ...info };
    }
  } catch {}
  return null;
}

/**
 * Captures all cookies for a portal and sends them to the local desktop service.
 * Called when a tab navigates to a portal page (post-login detection).
 */
async function capturePortalSession(tabId, url) {
  const portal = detectPortal(url);
  if (!portal) return;

  // Get all cookies for this domain
  const cookies = await chrome.cookies.getAll({ domain: portal.domain });
  if (cookies.length === 0) return;

  // Check if this looks like a logged-in state (has session-type cookies)
  const sessionCookies = cookies.filter(c =>
    c.name.toLowerCase().includes('session') ||
    c.name.toLowerCase().includes('token') ||
    c.name.toLowerCase().includes('auth') ||
    c.name.toLowerCase().includes('jsessionid') ||
    c.name.toLowerCase().includes('sid') ||
    c.httpOnly
  );
  if (sessionCookies.length === 0) return;

  // Get office registration
  const stored = await chrome.storage.local.get([OFFICE_ID_KEY, EDIFI_API_KEY]);
  if (!stored[OFFICE_ID_KEY]) return; // Not registered yet

  const payload = {
    office_id: stored[OFFICE_ID_KEY],
    payer_code: portal.payer,
    payer_name: portal.name,
    domain: portal.domain,
    cookies: cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate,
    })),
    captured_at: Date.now(),
    page_url: url,
  };

  // Send to local desktop service
  try {
    const resp = await fetch(`${LOCAL_SERVICE_URL}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (resp.ok) {
      activeSessions[portal.payer] = {
        capturedAt: Date.now(),
        payerName: portal.name,
      };
      updateBadge();
      console.log(`[EDiFi Connect] Session captured: ${portal.name}`);
    }
  } catch {
    // Local service not running — sessions will be captured on next sync
    console.log('[EDiFi Connect] Local service not running — session stored locally');
    await queueSessionLocally(payload);
  }
}

/**
 * Stores sessions locally when the desktop service isn't running yet.
 * These get flushed when the service starts.
 */
async function queueSessionLocally(session) {
  const existing = await chrome.storage.local.get('pending_sessions');
  const queue = existing.pending_sessions || [];
  queue.push(session);
  // Keep only last 10 sessions per payer (don't grow unbounded)
  const trimmed = queue.slice(-50);
  await chrome.storage.local.set({ pending_sessions: trimmed });
}

// ─── Badge + Status ───────────────────────────────────────────────────────────

function updateBadge() {
  const count = Object.keys(activeSessions).length;
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' }); // green
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Tab Navigation Listener ──────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only capture on completed navigation to dental portals
  if (changeInfo.status !== 'complete') return;
  if (!tab.url) return;

  const portal = detectPortal(tab.url);
  if (!portal) return;

  // Small delay to let post-login cookies settle
  setTimeout(() => capturePortalSession(tabId, tab.url), 1500);
});

// ─── Flush Queued Sessions on Startup ────────────────────────────────────────

async function flushPendingSessions() {
  const stored = await chrome.storage.local.get('pending_sessions');
  const queue = stored.pending_sessions || [];
  if (queue.length === 0) return;

  const remaining = [];
  for (const session of queue) {
    try {
      const resp = await fetch(`${LOCAL_SERVICE_URL}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(session),
      });
      if (!resp.ok) remaining.push(session);
    } catch {
      remaining.push(session); // Desktop service still not running
    }
  }
  await chrome.storage.local.set({ pending_sessions: remaining });
}

// ─── Registration ─────────────────────────────────────────────────────────────

// Listen for registration messages from the popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'REGISTER') {
    chrome.storage.local.set({
      [OFFICE_ID_KEY]: message.office_id,
      [EDIFI_API_KEY]: message.api_key,
    }).then(() => {
      sendResponse({ ok: true });
      flushPendingSessions();
    });
    return true; // Keep channel open for async response
  }

  if (message.type === 'GET_STATUS') {
    chrome.storage.local.get([OFFICE_ID_KEY]).then(stored => {
      sendResponse({
        registered: !!stored[OFFICE_ID_KEY],
        office_id: stored[OFFICE_ID_KEY],
        active_sessions: activeSessions,
        session_count: Object.keys(activeSessions).length,
      });
    });
    return true;
  }
});

// Flush any queued sessions on service worker startup
flushPendingSessions();
