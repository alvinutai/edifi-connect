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

const OD_DEV_KEY = "3TOLoPsbpxo8lxBi";

let config = {
  office_id: null,
  api_key: null,
  registered: false,
  od_api_url: null,
  od_customer_key: null,
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
    // Start OD sync immediately then every 15 minutes
    syncODData();
    if (odSyncInterval) clearInterval(odSyncInterval);
    odSyncInterval = setInterval(syncODData, 15 * 60 * 1000);
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

            return {
              ...apt,
              patient,
              insurance: { patPlans, insSubs, insPlans, carriers },
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
      await page.goto("https://www1.deltadentalins.com/ciam/login", {
        waitUntil: "networkidle",
        timeout: 30000,
      });
      await page.waitForLoadState("networkidle").catch(() => {});
      // Session should redirect to portal — navigate to eligibility
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

  // Silent auto-update — downloads in background, installs on next restart
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on("update-downloaded", () => {
      log("[Update] New version downloaded — will install on next restart");
      updateTray();
    });
    autoUpdater.on("error", (err) => log(`[Update] ${err.message}`));
    autoUpdater.checkForUpdates().catch(() => {}); // Silently ignore network errors
  } catch (e) {
    log(`[Update] electron-updater not available: ${e.message}`);
  }
});

app.on("window-all-closed", (e) => e.preventDefault()); // Keep running in tray
app.dock?.hide(); // Hide dock icon on macOS
