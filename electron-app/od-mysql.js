// ─── OD MySQL Direct Access ────────────────────────────────────────────────────
// Reads Open Dental's local MySQL database directly — no REST API, no Customer Key.
// OD stores its MySQL credentials in FreeDentalConfig.xml. We read that file
// automatically and connect directly to get complete benefit data.

const fs = require('fs');
const path = require('path');

// Common OD installation paths on Windows
const OD_CONFIG_PATHS = [
  'C:\\OpenDental\\FreeDentalConfig.xml',
  'C:\\Program Files (x86)\\Open Dental\\FreeDentalConfig.xml',
  'C:\\Program Files\\Open Dental\\FreeDentalConfig.xml',
  path.join(process.env.LOCALAPPDATA || '', 'OpenDental', 'FreeDentalConfig.xml'),
  path.join(process.env.APPDATA || '', 'OpenDental', 'FreeDentalConfig.xml'),
];

// BenefitType values in OD benefit table
const BENEFIT_TYPE = {
  1: 'Frequency',
  2: 'Age',
  3: 'Copay',
  4: 'Deductible',
  5: 'FixedAmount',
  6: 'CoInsurance',
};

// EbenefitCat → EDiFi coverage category
const CATEGORY_MAP = {
  1: 'DIAGNOSTIC',
  2: 'PREVENTIVE',
  3: 'BASIC',           // Restorative
  4: 'ENDODONTIC',
  5: 'PERIODONTIC',
  6: 'ORAL_SURGERY',
  7: 'PROSTHODONTIA',
  8: 'IMPLANT',
  9: 'ORTHODONTIC',
  10: 'PREVENTIVE',     // WellBaby — same bucket
  11: 'GENERAL',
  12: 'MAJOR',          // Major Restorative
  13: 'PROSTHODONTIA',
  14: 'PROSTHODONTIA',
};

// TimePeriod → readable label
const TIME_PERIOD = {
  0: 'None', 1: 'ServiceYear', 2: 'CalendarYear', 3: 'Lifetime',
  4: 'Years2', 5: 'Years3', 6: 'Years4', 7: 'Years5',
  8: 'Months6', 9: 'Months4', 10: 'Months3', 11: 'Months18',
  12: 'Months24', 13: 'Months36', 14: 'Months48', 15: 'Months60',
};

// CoverageLevel → label
const COVERAGE_LEVEL = { 0: 'None', 1: 'Individual', 2: 'Family' };

let pool = null;
let configCache = null;
let available = null; // null = unknown, true/false = tested
let logger = (msg) => console.log(`[OD MySQL] ${msg}`); // overridden by main.js

function setLogger(fn) { logger = fn; }

// Reset availability every 5 min so transient MySQL failures don't stick permanently
setInterval(() => { if (available === false) { available = null; pool = null; } }, 5 * 60 * 1000);

// ─── Config Reader ────────────────────────────────────────────────────────────

function parseXmlSimple(xml) {
  const result = {};
  const tagRx = /<([A-Za-z]\w*)>([^<]*)<\/\1>/g;
  let m;
  while ((m = tagRx.exec(xml)) !== null) {
    result[m[1]] = m[2].trim();
  }
  return result;
}

async function readOdConfig() {
  if (configCache) return configCache;

  for (const cfgPath of OD_CONFIG_PATHS) {
    try {
      if (!fs.existsSync(cfgPath)) continue;
      const xml = fs.readFileSync(cfgPath, 'utf8');
      const cfg = parseXmlSimple(xml);

      const host = cfg.DatabaseServer || cfg.ComputerName || cfg.Server || 'localhost';
      const database = cfg.Database || cfg.DbName || 'opendental';
      const user = cfg.DatabaseUser || cfg.DbUser || cfg.User || 'root';
      const port = parseInt(cfg.DatabasePort || cfg.Port || '3306', 10);

      // OD commonly stores password as MySqlPassHash (hashed) — detect and log clearly
      const rawPassword = cfg.DatabasePassword || cfg.DbPassword || cfg.Password || '';
      const hashedPassword = cfg.MySqlPassHash || cfg.DatabasePasswordHash || '';
      if (!rawPassword && hashedPassword) {
        logger(`Config found at ${cfgPath} but password is hashed (MySqlPassHash) — cannot connect. Set plaintext password in OD Settings > Databases.`);
        continue;
      }

      configCache = { host, database, user, password: rawPassword, port, configPath: cfgPath };
      logger(`Config loaded from ${cfgPath} — host:${host} db:${database} user:${user}`);
      return configCache;
    } catch (e) {
      logger(`Config parse error at ${cfgPath}: ${e.message}`);
      continue;
    }
  }
  logger(`FreeDentalConfig.xml not found at any standard path — OD MySQL unavailable`);
  return null;
}

// ─── Connection Pool ──────────────────────────────────────────────────────────

async function getPool() {
  if (pool) return pool;
  const cfg = await readOdConfig();
  if (!cfg) return null;

  try {
    const mysql = require('mysql2/promise');
    const p = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      connectionLimit: 3,
      connectTimeout: 6000,
      waitForConnections: true,
      queueLimit: 10,
    });
    // Connectivity test
    const conn = await p.getConnection();
    await conn.query('SELECT 1');
    conn.release();
    pool = p;
    logger(`Connected to ${cfg.host}:${cfg.port}/${cfg.database} — benefit queries ready`);
    return pool;
  } catch (e) {
    logger(`MySQL connection failed (${cfg.host}:${cfg.port}): ${e.message}`);
    pool = null;
    return null;
  }
}

// ─── Availability Check ───────────────────────────────────────────────────────

async function isAvailable() {
  if (available !== null) return available;
  const p = await getPool();
  available = p !== null;
  return available;
}

// ─── Patient Plan Lookup ──────────────────────────────────────────────────────

async function getPatientPlanInfo(patNum) {
  const p = await getPool();
  if (!p) return null;
  try {
    const [rows] = await p.query(
      `SELECT pp.PatPlanNum, isub.InsPlanNum AS PlanNum, pp.Ordinal
       FROM patplan pp
       JOIN inssub isub ON isub.InsSubNum = pp.InsSubNum
       WHERE pp.PatNum = ? AND pp.Ordinal = 1
       LIMIT 1`,
      [patNum],
    );
    return rows[0] || null;
  } catch {
    return null;
  }
}

// ─── Benefit Query ────────────────────────────────────────────────────────────

async function getBenefitsForPatient(patNum) {
  const p = await getPool();
  if (!p) return [];

  const planInfo = await getPatientPlanInfo(patNum);
  if (!planInfo) return [];

  const { PlanNum, PatPlanNum } = planInfo;

  try {
    const [rows] = await p.query(
      `SELECT
         b.BenefitType,
         b.CoverageLevel,
         b.Percent,
         b.MonetaryAmt,
         b.Quantity,
         b.QuantityQualifier,
         b.TimePeriod,
         cc.Description AS CategoryDesc,
         cc.EbenefitCat
       FROM benefit b
       LEFT JOIN covcat cc ON cc.CovCatNum = b.CovCatNum
       WHERE (b.PlanNum = ? AND b.PatPlanNum = 0)
          OR b.PatPlanNum = ?
       ORDER BY b.BenefitType, cc.EbenefitCat`,
      [PlanNum, PatPlanNum],
    );

    return rows
      .map((r) => {
        const type = BENEFIT_TYPE[r.BenefitType];
        if (!type) return null;

        const category = CATEGORY_MAP[r.EbenefitCat] || r.CategoryDesc || 'GENERAL';
        const coverage_level = COVERAGE_LEVEL[r.CoverageLevel] || 'None';
        const period = TIME_PERIOD[r.TimePeriod] || 'None';

        const benefit = { type, category, coverage_level };
        if (type === 'CoInsurance') {
          const pct = Number(r.Percent);
          if (isNaN(pct)) return null;
          benefit.percent = pct;
        } else if (type === 'Deductible' || type === 'FixedAmount') {
          benefit.amount_cents = Math.round(Number(r.MonetaryAmt) * 100);
        } else if (type === 'Frequency') {
          benefit.quantity = r.Quantity;
          benefit.period = period;
        }
        return benefit;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Patient Lookup by Name + DOB ─────────────────────────────────────────────

async function getPatNumByNameDOB(firstName, lastName, birthDate) {
  const p = await getPool();
  if (!p) return null;
  try {
    // OD stores birthdate as YYYY-MM-DD. Normalize incoming date to same format.
    const dob = birthDate ? birthDate.toString().slice(0, 10) : null;
    const [rows] = await p.query(
      `SELECT PatNum FROM patient
       WHERE LName = ? AND FName = ?
       ${dob ? 'AND Birthdate = ?' : ''}
       AND PatStatus = 0
       LIMIT 1`,
      dob ? [lastName, firstName, dob] : [lastName, firstName],
    );
    return rows[0]?.PatNum ?? null;
  } catch {
    return null;
  }
}

// ─── Today's Scheduled Appointments (MySQL — no REST API required) ────────────

async function getAppointmentsToday() {
  const p = await getPool();
  if (!p) return [];
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [rows] = await p.query(
      `SELECT a.AptNum, a.PatNum, a.AptDateTime,
              p.FName, p.LName, p.Birthdate,
              p.HmPhone, p.WkPhone, p.Email
       FROM appointment a
       JOIN patient p ON p.PatNum = a.PatNum
       WHERE DATE(a.AptDateTime) = ?
         AND a.AptStatus = 1
       ORDER BY a.AptDateTime`,
      [today],
    );
    return rows;
  } catch (e) {
    logger(`getAppointmentsToday error: ${e.message}`);
    return [];
  }
}

// ─── Full Patient Insurance + Benefit Snapshot ────────────────────────────────

async function getPatientInsuranceSnapshot(patNum) {
  const p = await getPool();
  if (!p) return null;
  try {
    const [planRows] = await p.query(
      `SELECT
         pp.Ordinal,
         c.CarrierName,
         c.ElectID AS PayerID,
         ip.AnnualMax,
         ip.Deductible,
         isub.SubscriberID,
         isub.DateEffective,
         isub.DateTerm,
         sub.FName AS SubFirst, sub.LName AS SubLast, sub.Birthdate AS SubDOB,
         pp.Relationship
       FROM patplan pp
       JOIN inssub isub ON isub.InsSubNum = pp.InsSubNum
       JOIN insplan ip ON ip.PlanNum = isub.PlanNum
       JOIN carrier c ON c.CarrierNum = ip.CarrierNum
       JOIN patient sub ON sub.PatNum = isub.Subscriber
       WHERE pp.PatNum = ?
       ORDER BY pp.Ordinal
       LIMIT 2`,
      [patNum],
    );

    const benefits = await getBenefitsForPatient(patNum);

    return {
      patNum,
      plans: planRows.map((r) => ({
        ordinal: r.Ordinal,
        carrier_name: r.CarrierName,
        payer_id: r.PayerID,
        annual_max_cents: r.AnnualMax != null ? Math.round(Number(r.AnnualMax) * 100) : null,
        deductible_cents: r.Deductible != null ? Math.round(Number(r.Deductible) * 100) : null,
        subscriber_id: r.SubscriberID,
        date_effective: r.DateEffective,
        date_term: r.DateTerm,
        subscriber_first: r.SubFirst,
        subscriber_last: r.SubLast,
        subscriber_dob: r.SubDOB,
        relationship: r.Relationship,
      })),
      benefits,
    };
  } catch (e) {
    logger(`getPatientInsuranceSnapshot error for PatNum ${patNum}: ${e.message}`);
    return null;
  }
}

module.exports = {
  isAvailable,
  readOdConfig,
  getBenefitsForPatient,
  getPatNumByNameDOB,
  getAppointmentsToday,
  getPatientInsuranceSnapshot,
  setLogger,
};
