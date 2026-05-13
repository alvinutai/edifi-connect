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
      const password = cfg.DatabasePassword || cfg.DbPassword || cfg.Password || '';
      const port = parseInt(cfg.DatabasePort || cfg.Port || '3306', 10);

      configCache = { host, database, user, password, port, configPath: cfgPath };
      return configCache;
    } catch {
      continue;
    }
  }
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
    return pool;
  } catch {
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

module.exports = { isAvailable, readOdConfig, getBenefitsForPatient };
