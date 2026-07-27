// ─── OD MySQL Direct Access ────────────────────────────────────────────────────
// Reads Open Dental's local MySQL database directly — no REST API, no Customer Key.
// OD stores its MySQL credentials in FreeDentalConfig.xml. We read that file
// automatically and connect directly to get complete benefit data.

const fs = require("fs");
const path = require("path");
// B-014 v6 strict numeric seams. Imported, not re-implemented: the REST mapper
// (main.js) and lib/benefit-mapper.js already share these two functions, and a
// third copy here is exactly the divergence the parity gates exist to prevent.
const {
  toFiniteNumberOrNull,
  toNonNegativeFiniteOrNull,
} = require("./lib/benefit-mapper");

// Common OD installation paths on Windows
const OD_CONFIG_PATHS = [
  "C:\\OpenDental\\FreeDentalConfig.xml",
  "C:\\Program Files (x86)\\Open Dental\\FreeDentalConfig.xml",
  "C:\\Program Files\\Open Dental\\FreeDentalConfig.xml",
  path.join(
    process.env.LOCALAPPDATA || "",
    "OpenDental",
    "FreeDentalConfig.xml",
  ),
  path.join(process.env.APPDATA || "", "OpenDental", "FreeDentalConfig.xml"),
];

// OD BenefitType enum (Open Dental source: EnumBenefitType)
// Percent field = what the PLAN pays (e.g. 100 = fully covered, 80 = plan pays 80%)
const BENEFIT_TYPE = {
  1: "CoInsurance", // Plan pays Percent% of the procedure
  2: "Deductible", // MonetaryAmt = deductible amount
  3: "Limitations", // Annual max (MonetaryAmt) or frequency rules (Quantity + QuantityQualifier)
  4: "Other",
  5: "Note",
};

// OD EbenefitCat → EDiFi coverage category
// Mapping aligned with Tessina feedback (2026-05-06):
//   Restorative (3) → BASIC, Crowns (9) → MAJOR, Prosthodontics (8) → MAJOR
const CATEGORY_MAP = {
  0: "GENERAL",
  1: "DIAGNOSTIC",
  2: "PREVENTIVE",
  3: "BASIC", // Restorative → Basic
  4: "ENDO",
  5: "PERIO",
  6: "ORAL_SURGERY",
  7: "MAXILLOFACIAL",
  8: "MAJOR", // Prosthodontics → Major
  9: "MAJOR", // Crowns → Major
  10: "ACCIDENT",
  11: "ORTHO",
  12: "ADJUNCTIVE",
  13: "IMPLANTS",
};

// TimePeriod → readable label
const TIME_PERIOD = {
  0: "None",
  1: "ServiceYear",
  2: "CalendarYear",
  3: "Lifetime",
  4: "Years2",
  5: "Years3",
  6: "Years4",
  7: "Years5",
  8: "Months6",
  9: "Months4",
  10: "Months3",
  11: "Months18",
  12: "Months24",
  13: "Months36",
  14: "Months48",
  15: "Months60",
};

// OD CoverageLevel enum — note: Family = 3 (not 2)
const COVERAGE_LEVEL = { 0: "None", 1: "Individual", 3: "Family" };

// ─── OD wall-clock date/time on the wire (F1) ─────────────────────────────────
//
// Open Dental stores DATE/DATETIME with no zone: the value IS the clock on the
// office wall. mysql2 inflates those columns into JavaScript Date objects bound
// to the CONNECTION's timezone, and JSON.stringify then serializes that Date as
// a UTC ISO string. The backend correctly treats an OD value as office-local
// wall time, so it applies the office offset to an already-shifted instant and
// the value moves twice: a Denver 09:15 arrival is stored as 21:15Z and the
// card's waiting timer lies.
//
// Formatting in SQL keeps the value a wall-clock string from the driver onward,
// so exactly one conversion happens (the backend's odDateTimeOrNull with the
// office timezone).
//
// WHY NOT `dateStrings` ON THE POOL: mysql2's dateStrings option is scoped by
// TYPE (`true`, or a list like ['DATE','DATETIME','TIMESTAMP']) and applies to
// the whole connection — it is not column-scoped. Setting it would change the
// return type of every other query on this pool (benefits, covcat, codegroup,
// status definitions, appointment types, information_schema probes). Formatting
// per column confines the change to the two statements that put a date on the
// wire, which is the blast radius this fix is allowed to have.
//
// Zero dates: OD's `0001-01-01 00:00:00` sentinel is a valid date, so
// DATE_FORMAT returns it verbatim and the backend's existing sentinel check
// rejects it. A true `0000-00-00` returns NULL, which the backend reads as
// absent (COALESCE keeps the stored value) — also correct.
const OD_DATETIME_SQL_FORMAT = "%Y-%m-%d %H:%i:%s";
const OD_DATE_SQL_FORMAT = "%Y-%m-%d";

function odWallDateTime(column, alias) {
  return `DATE_FORMAT(${column}, '${OD_DATETIME_SQL_FORMAT}') AS ${alias}`;
}

function odWallDate(column, alias) {
  return `DATE_FORMAT(${column}, '${OD_DATE_SQL_FORMAT}') AS ${alias}`;
}

let pool = null;
let configCache = null;
let covCatCache = null; // cached CovCatNum map — invalidated on reconnect
let codeGroupAvailable = null; // cached CodeGroup capability probe — invalidated on reconnect
let appointmentTypeAvailable = null; // cached appointmenttype capability probe (session-scoped)
let agentExtColumns = null; // cached AGENT-EXT column probe (session-scoped)
let available = null; // null = unknown, true/false = tested
let logger = (msg) => console.log(`[OD MySQL] ${msg}`); // overridden by main.js
let manualConfigOverride = null; // set by SET_MYSQL_CONFIG command — bypasses file scan

function setLogger(fn) {
  logger = fn;
}

/**
 * Every cache that describes what the CONNECTED database can do.
 *
 * These are properties of a specific MySQL target, not of the process. When the
 * pool or config changes, a stale capability cache is worse than no cache: the
 * agent would keep selecting columns that exist on the old database, the
 * appointment SELECT would throw, and getAppointmentsForDate would return [] —
 * the blank board the probe exists to prevent.
 *
 * Called from every place that already discards `pool`/`available`.
 */
function resetCapabilityCaches() {
  covCatCache = null;
  codeGroupAvailable = null;
  appointmentTypeAvailable = null;
  agentExtColumns = null;
}

// Called by SET_MYSQL_CONFIG command — accepts manual MySQL credentials directly.
// Resets connection state so the new config is tested on next isAvailable() call.
function setManualMysqlConfig(cfg) {
  if (!cfg || !cfg.host || !cfg.database || !cfg.user || !cfg.password) return;
  manualConfigOverride = { ...cfg };
  configCache = null;
  available = null;
  pool = null;
  resetCapabilityCaches();
  logger(
    `Manual MySQL config loaded — host:${cfg.host} db:${cfg.database} user:${cfg.user}`,
  );
}

// Clears any manual override and cached connection state so config falls back to
// the normal file scan. Used to roll back a failed SET_MYSQL_CONFIG attempt when
// there was no prior override to restore.
function clearManualMysqlConfig() {
  manualConfigOverride = null;
  configCache = null;
  available = null;
  pool = null;
  resetCapabilityCaches();
}

// Reset availability every 5 min so transient MySQL failures don't stick permanently
setInterval(
  () => {
    if (available === false) {
      available = null;
      pool = null;
      resetCapabilityCaches();
    }
  },
  5 * 60 * 1000,
);

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

  // Manual override takes precedence over file scan (set by SET_MYSQL_CONFIG command)
  if (manualConfigOverride) {
    configCache = { ...manualConfigOverride, configPath: "manual" };
    return configCache;
  }

  for (const cfgPath of OD_CONFIG_PATHS) {
    try {
      if (!fs.existsSync(cfgPath)) continue;
      const xml = fs.readFileSync(cfgPath, "utf8");
      const cfg = parseXmlSimple(xml);

      const host =
        cfg.DatabaseServer || cfg.ComputerName || cfg.Server || "localhost";
      const database = cfg.Database || cfg.DbName || "opendental";
      const user = cfg.DatabaseUser || cfg.DbUser || cfg.User || "root";
      const port = parseInt(cfg.DatabasePort || cfg.Port || "3306", 10);

      // OD commonly stores password as MySqlPassHash (hashed) — detect and log clearly
      const rawPassword =
        cfg.DatabasePassword || cfg.DbPassword || cfg.Password || "";
      const hashedPassword =
        cfg.MySqlPassHash || cfg.DatabasePasswordHash || "";
      if (!rawPassword && hashedPassword) {
        logger(
          `Config found at ${cfgPath} but password is hashed (MySqlPassHash) — cannot connect. Set plaintext password in OD Settings > Databases.`,
        );
        continue;
      }

      configCache = {
        host,
        database,
        user,
        password: rawPassword,
        port,
        configPath: cfgPath,
      };
      logger(
        `Config loaded from ${cfgPath} — host:${host} db:${database} user:${user}`,
      );
      return configCache;
    } catch (e) {
      logger(`Config parse error at ${cfgPath}: ${e.message}`);
      continue;
    }
  }
  logger(
    `FreeDentalConfig.xml not found at any standard path — OD MySQL unavailable`,
  );
  return null;
}

// ─── Connection Pool ──────────────────────────────────────────────────────────

// Records the outcome of each connection strategy from the last getPool() attempt.
// Contains only strategy labels + MySQL error codes — never passwords or PHI.
let lastConnectDiag = [];
function getConnectDiagnostics() {
  return lastConnectDiag;
}

// Ordered connection strategies. Open Dental on Windows authenticates as
// user@localhost through a path a plain TCP client may not match (localhost-only
// grant, or skip_name_resolve). We try IPv4 TCP first (avoids the localhost->::1
// resolution that never matches an IPv4-only server), then the raw host if it
// differs, then the default Windows named pipe (which MySQL treats as localhost).
function buildConnectStrategies(cfg) {
  const base = {
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    connectionLimit: 3,
    connectTimeout: 6000,
    waitForConnections: true,
    queueLimit: 10,
  };
  // "localhost" -> 127.0.0.1 so we never hit the Windows localhost->::1 resolution
  // that an IPv4-only MySQL never accepts. A TCP connection from 127.0.0.1 still
  // matches a user@localhost grant when skip_name_resolve is off.
  const ipv4 = cfg.host === "localhost" ? "127.0.0.1" : cfg.host;
  const strategies = [
    { label: `tcp:${ipv4}`, opts: { ...base, host: ipv4, port: cfg.port } },
  ];
  // The named pipe is a LOCAL-only transport (MySQL treats it as localhost, which
  // matches a localhost-only grant when skip_name_resolve is on). Only add it for a
  // local host — never for a remote host, or a remote TCP failure could silently
  // fall through to an unrelated local MySQL instance.
  const isLocal = ["localhost", "127.0.0.1", "::1", "."].includes(
    String(cfg.host || "").toLowerCase(),
  );
  if (isLocal) {
    strategies.push({
      label: "pipe",
      opts: { ...base, socketPath: "\\\\.\\pipe\\MySQL" },
    });
  }
  return strategies;
}

async function getPool() {
  if (pool) return pool;
  const cfg = await readOdConfig();
  if (!cfg) return null;

  const mysql = require("mysql2/promise");
  lastConnectDiag = [];
  for (const s of buildConnectStrategies(cfg)) {
    let p;
    try {
      p = mysql.createPool(s.opts);
      const conn = await p.getConnection();
      await conn.query("SELECT 1");
      conn.release();
      pool = p;
      lastConnectDiag.push({ strategy: s.label, ok: true });
      logger(
        `Connected via ${s.label} — ${cfg.database} — benefit queries ready`,
      );
      return pool;
    } catch (e) {
      lastConnectDiag.push({
        strategy: s.label,
        ok: false,
        code: e.code || "ERR",
      });
      logger(`MySQL ${s.label} failed: ${e.code || e.message}`);
      try {
        if (p) await p.end();
      } catch {}
    }
  }
  pool = null;
  return null;
}

// ─── Availability Check ───────────────────────────────────────────────────────

async function isAvailable() {
  if (available !== null) return available;
  const p = await getPool();
  available = p !== null;
  return available;
}

/**
 * Availability for a NEW sync run (F3).
 *
 * `isAvailable()` caches a TRUE result for the life of the process — the 5-minute
 * reset above only clears a FALSE. So an office whose MySQL goes away mid-day
 * keeps reporting healthy forever and the sync path never falls back to the
 * configured REST service. Path selection needs a live answer, so it asks the
 * pool the same `SELECT 1` question `getPool()` asks when it builds one.
 *
 * On failure the pool and capability caches are discarded and `available` goes
 * back to unknown (not false), so the next call retries the connection
 * strategies and a recovered database is picked up on the following cycle
 * rather than waiting for the 5-minute timer.
 *
 * Connection strategy, credentials, config paths and pool construction are
 * untouched: this only asks the pool that already exists whether it still
 * answers. Every existing `isAvailable()` caller keeps its current behavior.
 */
async function recheckAvailability() {
  const p = await getPool();
  if (!p) {
    available = false;
    return false;
  }
  try {
    const conn = await p.getConnection();
    try {
      await conn.query("SELECT 1");
    } finally {
      conn.release();
    }
    available = true;
    return true;
  } catch (e) {
    logger(
      `MySQL liveness check failed (${e.code || e.message}) — reconnecting next cycle`,
    );
    try {
      await p.end();
    } catch {}
    pool = null;
    available = null;
    resetCapabilityCaches();
    return false;
  }
}

// ─── CodeGroup Capability Probe ───────────────────────────────────────────────
// Read-only probe: determines whether this OD database has the CodeGroupNum
// column on benefit and a codegroup table. Cached per session; failures are
// treated as "not available" so older schemas fall back safely.

async function probeCodeGroupSupport() {
  if (codeGroupAvailable !== null) return codeGroupAvailable;
  const p = await getPool();
  if (!p) {
    codeGroupAvailable = false;
    return false;
  }
  try {
    const [[colRow]] = await p.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'benefit'
         AND COLUMN_NAME = 'CodeGroupNum'`,
    );
    const [[tableRow]] = await p.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'codegroup'`,
    );
    codeGroupAvailable =
      Number(colRow?.cnt || 0) > 0 && Number(tableRow?.cnt || 0) > 0;
    logger(
      `CodeGroup support probe: ${codeGroupAvailable ? "available" : "unavailable"}`,
    );
    return codeGroupAvailable;
  } catch (e) {
    logger(`CodeGroup support probe failed: ${e.message}`);
    codeGroupAvailable = false;
    return false;
  }
}

// ─── AppointmentType Capability Probe ─────────────────────────────────────────
// Read-only probe: older OD schemas have no `appointmenttype` table (and no
// appointment.AppointmentTypeNum column). Mirrors probeCodeGroupSupport —
// cached per session; any failure is treated as "not available" so the board
// simply renders without per-type colors.

async function probeAppointmentTypeSupport() {
  if (appointmentTypeAvailable !== null) return appointmentTypeAvailable;
  const p = await getPool();
  if (!p) {
    appointmentTypeAvailable = false;
    return false;
  }
  try {
    const [[colRow]] = await p.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointment'
         AND COLUMN_NAME = 'AppointmentTypeNum'`,
    );
    const [[tableRow]] = await p.query(
      `SELECT COUNT(*) AS cnt
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'appointmenttype'`,
    );
    appointmentTypeAvailable =
      Number(colRow?.cnt || 0) > 0 && Number(tableRow?.cnt || 0) > 0;
    logger(
      `AppointmentType support probe: ${appointmentTypeAvailable ? "available" : "unavailable"}`,
    );
    return appointmentTypeAvailable;
  } catch (e) {
    logger(`AppointmentType support probe failed: ${e.message}`);
    appointmentTypeAvailable = false;
    return false;
  }
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
    // Phase 6E-1: CodeGroup identity forwarding. Probe the schema once per
    // session; if the CodeGroupNum column / codegroup table are absent, fall
    // back to the previous SELECT so older OD schemas still return benefits.
    const hasCodeGroup = await probeCodeGroupSupport();

    // Phase 6D-1: BenefitNum/CovCatNum/CodeNum + procedurecode join added for
    // parity with the REST path. LEFT JOINs are null-safe — rows without a
    // procedure linkage (CodeNum=0) simply carry nulls.
    const [rows] = await p.query(
      hasCodeGroup
        ? `SELECT
             b.BenefitNum,
             b.CovCatNum,
             b.CodeNum,
             b.CodeGroupNum,
             b.BenefitType,
             b.CoverageLevel,
             b.Percent,
             b.MonetaryAmt,
             b.Quantity,
             b.QuantityQualifier,
             b.TimePeriod,
             cc.Description AS CategoryDesc,
             cc.EbenefitCat,
             pc.ProcCode,
             cg.GroupName AS CodeGroupDesc
           FROM benefit b
           LEFT JOIN covcat cc ON cc.CovCatNum = b.CovCatNum
           LEFT JOIN procedurecode pc ON pc.CodeNum = b.CodeNum
           LEFT JOIN codegroup cg ON cg.CodeGroupNum = b.CodeGroupNum
           WHERE (b.PlanNum = ? AND b.PatPlanNum = 0)
              OR b.PatPlanNum = ?
           ORDER BY b.BenefitType, cc.EbenefitCat`
        : `SELECT
             b.BenefitNum,
             b.CovCatNum,
             b.CodeNum,
             b.BenefitType,
             b.CoverageLevel,
             b.Percent,
             b.MonetaryAmt,
             b.Quantity,
             b.QuantityQualifier,
             b.TimePeriod,
             cc.Description AS CategoryDesc,
             cc.EbenefitCat,
             pc.ProcCode
           FROM benefit b
           LEFT JOIN covcat cc ON cc.CovCatNum = b.CovCatNum
           LEFT JOIN procedurecode pc ON pc.CodeNum = b.CodeNum
           WHERE (b.PlanNum = ? AND b.PatPlanNum = 0)
              OR b.PatPlanNum = ?
           ORDER BY b.BenefitType, cc.EbenefitCat`,
      [PlanNum, PatPlanNum],
    );

    // B-014: the old `.map(...).filter(Boolean)` discarded rows with no reason
    // and no count. mapMysqlBenefits keeps the same output shape and attaches
    // the drop/fallback accounting the REST path already carries.
    return mapMysqlBenefits(rows);
  } catch {
    return mapMysqlBenefits([]);
  }
}

/**
 * Pure row mapper for the MySQL benefit path — B-014 v6 semantics.
 *
 * This used to be the uninstrumented twin of the REST mapper: an unrecognized
 * BenefitType returned null, a negative or NaN percent returned null, and both
 * disappeared behind `.filter(Boolean)` with no counter and no reason. Since
 * ruling R2 makes MySQL the design path, that would have re-created B-014 on
 * the very path the fix was written for.
 *
 * Now it never decides a row's fate alone: it BUILDS an entry (unknown type
 * becomes the `"Other"` fallback, recorded in `fallbackReasons`) and leaves the
 * keep/drop call to `mapMysqlBenefits`, which records a reason for every drop.
 *
 * Numeric parsing goes through the shared non-negative seam, so a real 0% or $0
 * survives while `-1` (OD's not-entered sentinel), NaN, booleans, arrays and
 * malformed strings all read as absent.
 *
 * Null-safe against LEFT JOIN misses: ProcCode NULL/empty → null, CodeNum
 * 0/NULL → null, string CodeNum normalized.
 *
 * @param {object} r                 raw benefit row
 * @param {object} [fallbackReasons] mutated when the row rides the Other path
 */
function mapMysqlBenefitRow(r, fallbackReasons) {
  // B-014 §2.A: accept-with-fallback instead of strict-reject. The numeric map
  // (BENEFIT_TYPE, this file) already covers 4→Other and 5→Note; no numeric
  // meaning is invented here. MySQL's BenefitType column is numeric, so the
  // REST path's string "CoPayment" cannot be expressed on this path at all —
  // see the result report rather than guessing a number for it.
  const type = BENEFIT_TYPE[r.BenefitType] || "Other";
  if (!BENEFIT_TYPE[r.BenefitType] && fallbackReasons) {
    const key = `type_${r.BenefitType}_unmapped_fallback`;
    fallbackReasons[key] = (fallbackReasons[key] || 0) + 1;
  }

  const category = CATEGORY_MAP[r.EbenefitCat] || r.CategoryDesc || "GENERAL";
  const coverage_level = COVERAGE_LEVEL[r.CoverageLevel] || "None";
  const period = TIME_PERIOD[r.TimePeriod] || "None";

  const benefit = {
    type,
    category,
    coverage_level,
    benefit_num: r.BenefitNum ?? null,
    cov_cat_num: Number(r.CovCatNum) || 0,
    ebenefitcat: Number(r.EbenefitCat ?? 0) || null,
    code_num: Number(r.CodeNum) || null,
    proc_code: typeof r.ProcCode === "string" && r.ProcCode ? r.ProcCode : null,
    code_group_num: Number(r.CodeGroupNum) || null,
    code_group_desc:
      typeof r.CodeGroupDesc === "string" && r.CodeGroupDesc
        ? r.CodeGroupDesc
        : null,
  };
  if (type === "CoInsurance") {
    // Percent = what the plan pays. A real 0% is data ("this plan covers none
    // of it"); -1 is OD's not-entered sentinel and reads as absent.
    benefit.percent = toNonNegativeFiniteOrNull(r.Percent);
  } else if (type === "Deductible") {
    const cents = toNonNegativeFiniteOrNull(r.MonetaryAmt);
    benefit.amount_cents = cents != null ? Math.round(cents * 100) : null;
  } else if (type === "Limitations") {
    // Annual max (a monetary cap) and frequency rules (quantity + qualifier)
    // both live in this type. The old `> 0` gates dropped a real $0 cap and a
    // real 0-quantity rule; both are now kept when they parse.
    const cents = toNonNegativeFiniteOrNull(r.MonetaryAmt);
    if (cents != null) benefit.amount_cents = Math.round(cents * 100);

    const qty = toNonNegativeFiniteOrNull(r.Quantity);
    const qualifier = toFiniteNumberOrNull(r.QuantityQualifier);
    if (qty != null && qualifier != null && qualifier > 0) {
      benefit.quantity = qty;
      benefit.period = period;
      benefit.qualifier = qualifier;
    }
  }
  // "Other" and "Note" carry no interpreted value fields, by design: the row's
  // own type is unrecognized or non-numeric, so no field can be safely assumed
  // to mean percent/amount/quantity. Same contract as the REST mapper.
  return benefit;
}

/**
 * Map a batch of MySQL benefit rows with full B-014 accounting.
 *
 * Returns the kept entries, annotated exactly like the REST mapper's output so
 * both paths surface identically downstream:
 *   `_raw_received`, `_dropped`, `_dropped_reasons`, `_fallback_reasons`.
 *
 * Invariant: `sum(_dropped_reasons) === _raw_received - kept`. Fallback rows
 * are KEPT and never counted as drops.
 */
function mapMysqlBenefits(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const dropped_reasons = {};
  const fallback_reason_counts = {};

  const mapped = rows.map((r) => mapMysqlBenefitRow(r, fallback_reason_counts));

  const filtered = mapped.filter((b) => {
    if (b.type === "CoInsurance") {
      if (b.percent != null) return true;
      dropped_reasons.coinsurance_invalid_percent =
        (dropped_reasons.coinsurance_invalid_percent || 0) + 1;
      return false;
    }
    if (b.type === "Deductible") {
      if (b.amount_cents != null) return true;
      dropped_reasons.deductible_invalid_amount =
        (dropped_reasons.deductible_invalid_amount || 0) + 1;
      return false;
    }
    if (b.type === "Limitations") {
      if (b.quantity != null || b.amount_cents != null) return true;
      dropped_reasons.limitations_no_valid_value =
        (dropped_reasons.limitations_no_valid_value || 0) + 1;
      return false;
    }
    return true; // Other / Note are preserved, never dropped by this filter
  });

  filtered._raw_received = rows.length;
  filtered._dropped = rows.length - filtered.length;
  filtered._dropped_reasons = dropped_reasons;
  filtered._fallback_reasons = fallback_reason_counts;
  return filtered;
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
       ${dob ? "AND Birthdate = ?" : ""}
       AND PatStatus = 0
       LIMIT 1`,
      dob ? [lastName, firstName, dob] : [lastName, firstName],
    );
    return rows[0]?.PatNum ?? null;
  } catch {
    return null;
  }
}

// ─── Dynamic CovCat Map ───────────────────────────────────────────────────────
// Builds EDiFi-category → CovCatNum map from OD's covcat table.
// Cached per session — avoids repeated DB queries on each write-back call.

async function buildCovCatMap() {
  if (covCatCache) return covCatCache;
  const p = await getPool();
  if (!p) return {};
  try {
    const [rows] = await p.query(
      `SELECT CovCatNum, EbenefitCat, Description FROM covcat ORDER BY CovCatNum`,
    );
    const EBENCAT_TO_EDIFI = {
      0: "GENERAL",
      1: "DIAGNOSTIC",
      2: "PREVENTIVE",
      3: "BASIC",
      4: "ENDO",
      5: "PERIO",
      6: "ORAL_SURGERY",
      7: "MAXILLOFACIAL",
      8: "MAJOR",
      9: "MAJOR",
      10: "ACCIDENT",
      11: "ORTHO",
      12: "ADJUNCTIVE",
      13: "IMPLANTS",
    };
    const map = {};
    for (const row of rows) {
      const edifiCat =
        EBENCAT_TO_EDIFI[row.EbenefitCat] ??
        (row.Description || "").toUpperCase().replace(/\s+/g, "_") ??
        "GENERAL";
      // First match wins — lower CovCatNum takes priority for shared categories (e.g. MAJOR=8 before 9)
      if (!(edifiCat in map)) map[edifiCat] = row.CovCatNum;
    }
    covCatCache = map;
    return map;
  } catch {
    return {};
  }
}

// ─── Appointments for Date (MySQL — no REST API required) ─────────────────────

// AGENT-EXT board fields, per table. Every one is probed before it enters the
// SELECT: this is a single statement, so one column that an older Open Dental
// build does not have would throw and return ZERO appointments — the board
// would go blank rather than lose one chip. Probing degrades per column.
const AGENT_EXT_COLUMNS = {
  appointment: [
    "Confirmed",
    "DateTimeArrived",
    "DateTimeSeated",
    "DateTimeDismissed",
    "IsNewPatient",
    "IsHygiene",
  ],
  patient: [
    "Premed",
    "MedUrgNote",
    "Preferred",
    // Balance source. No in-repo helper names one, and it could not be checked
    // against Tessina's real OD from here, so both known candidates are probed
    // and whichever exists is sent (BalTotal preferred — it is OD's own total
    // patient balance; EstBalance is the estimated-after-insurance figure).
    // Recorded in the packet result rather than guessed at.
    "BalTotal",
    "EstBalance",
  ],
  provider: ["ProvColor"],
};

// Which AGENT_EXT_COLUMNS entries are OD DATETIME columns and must therefore be
// formatted to a wall-clock string rather than handed to the driver's date
// parser. See the odWallDateTime comment for why this is done per column.
const AGENT_EXT_DATETIME_COLUMNS = new Set([
  "DateTimeArrived",
  "DateTimeSeated",
  "DateTimeDismissed",
]);

/**
 * Which AGENT-EXT columns this Open Dental actually has. One information_schema
 * query, cached per session, same shape as probeAppointmentTypeSupport. A probe
 * failure resolves to "none available", which returns the board to exactly the
 * query it runs today.
 */
async function probeAgentExtColumns() {
  if (agentExtColumns !== null) return agentExtColumns;
  const p = await getPool();
  if (!p) return { appointment: [], patient: [], provider: [] };
  const empty = { appointment: [], patient: [], provider: [] };
  try {
    const [rows] = await p.query(
      `SELECT TABLE_NAME, COLUMN_NAME
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME IN ('appointment', 'patient', 'provider')`,
    );
    const present = new Set(
      rows.map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`.toLowerCase()),
    );
    agentExtColumns = {
      appointment: AGENT_EXT_COLUMNS.appointment.filter((c) =>
        present.has(`appointment.${c.toLowerCase()}`),
      ),
      patient: AGENT_EXT_COLUMNS.patient.filter((c) =>
        present.has(`patient.${c.toLowerCase()}`),
      ),
      provider: AGENT_EXT_COLUMNS.provider.filter((c) =>
        present.has(`provider.${c.toLowerCase()}`),
      ),
    };
    logger(
      `AGENT-EXT column probe: appointment=[${agentExtColumns.appointment}] ` +
        `patient=[${agentExtColumns.patient}] provider=[${agentExtColumns.provider}]`,
    );
    return agentExtColumns;
  } catch (e) {
    // NOT cached. A transient information_schema failure would otherwise mean
    // "this database has no AGENT-EXT columns" for the rest of the process
    // lifetime, with no retry after the database recovers. This sync degrades
    // to the pre-P4 query; the next one probes again.
    logger(`AGENT-EXT column probe failed (retry next sync): ${e.message}`);
    return empty;
  }
}

/**
 * SELECT fragment for the probed columns. Names come from AGENT_EXT_COLUMNS —
 * a fixed in-file allowlist, never from OD data or a command — so this is not
 * a dynamic-SQL surface.
 */
function agentExtSelectFragment(cols) {
  const parts = [
    ...cols.appointment.map((c) =>
      AGENT_EXT_DATETIME_COLUMNS.has(c)
        ? odWallDateTime(`a.${c}`, c)
        : `a.${c}`,
    ),
    ...cols.patient.map((c) => `p.${c}`),
    ...cols.provider.map((c) => `prov.${c}`),
  ];
  return parts.length > 0 ? `,\n              ${parts.join(", ")}` : "";
}

async function getAppointmentsForDate(date) {
  const p = await getPool();
  if (!p) return [];
  const targetDate = date || new Date().toISOString().slice(0, 10);
  const extCols = await probeAgentExtColumns();
  try {
    const [rows] = await p.query(
      `SELECT a.AptNum, a.PatNum, ${odWallDateTime("a.AptDateTime", "AptDateTime")},
              a.Op, a.Pattern, a.ProvNum, a.ProvHyg, a.AptStatus,
              CHAR_LENGTH(a.Pattern) * 5 AS DurationMin,
              p.FName, p.LName, ${odWallDate("p.Birthdate", "Birthdate")},
              p.HmPhone, p.WkPhone, p.Email,
              op.OpName, op.Abbrev AS OpAbbrev,
              prov.Abbr AS ProvAbbr,
              hyg.Abbr  AS HygAbbr,
              (SELECT ROUND(SUM(pl.ProcFee), 2)
                 FROM procedurelog pl
                WHERE pl.AptNum = a.AptNum
                  AND pl.ProcStatus IN (1, 2)) AS Production${agentExtSelectFragment(extCols)}
       FROM appointment a
       LEFT JOIN patient   p    ON p.PatNum        = a.PatNum
       LEFT JOIN operatory op   ON op.OperatoryNum = a.Op
       LEFT JOIN provider  prov ON prov.ProvNum    = a.ProvNum
       LEFT JOIN provider  hyg  ON hyg.ProvNum      = a.ProvHyg
       WHERE DATE(a.AptDateTime) = ?
         AND a.AptStatus IN (1, 2)
       ORDER BY a.AptDateTime`,
      [targetDate],
    );
    return rows;
  } catch (e) {
    logger(`getAppointmentsForDate error (${targetDate}): ${e.message}`);
    return [];
  }
}

// Backward-compatible wrapper
async function getAppointmentsToday() {
  return getAppointmentsForDate(null);
}

// ─── Appointment Procedure Fees (read-only) ───────────────────────────────────
// Returns sanitized procedure summaries for a specific appointment.
// pat_est_amt = max(ProcFee - InsPayEst, 0) — conservative floor before
// deductible. Does not include deductible contribution (no YTD usage here).
// Returned objects contain no patient identifiers, dates, or clinical notes.

async function getAppointmentProcedures(aptNum) {
  const p = await getPool();
  if (!p) return [];
  try {
    const [rows] = await p.query(
      `SELECT
         pc.ProcCode,
         pc.AbbrDesc AS description,
         ROUND(pl.ProcFee, 2)                                             AS proc_fee,
         ROUND(GREATEST(pl.ProcFee - COALESCE(pl.InsPayEst, 0), 0), 2)  AS pat_est_amt
       FROM procedurelog pl
       JOIN procedurecode pc ON pc.CodeNum = pl.CodeNum
       WHERE pl.AptNum = ?
         AND pl.ProcStatus IN (1, 2)`,
      [aptNum],
    );
    return rows
      .filter((r) => r.ProcCode && String(r.ProcCode).trim())
      .map((r) => ({
        procedure_code: String(r.ProcCode).trim(),
        description: String(r.description || "").trim(),
        procedure_fee_cents: Math.round(Number(r.proc_fee) * 100),
        estimated_patient_portion_cents: Math.round(
          Number(r.pat_est_amt) * 100,
        ),
      }));
  } catch (e) {
    logger(`getAppointmentProcedures error: ${e.message}`);
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
        annual_max_cents:
          r.AnnualMax != null ? Math.round(Number(r.AnnualMax) * 100) : null,
        deductible_cents:
          r.Deductible != null ? Math.round(Number(r.Deductible) * 100) : null,
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
    logger(
      `getPatientInsuranceSnapshot error for PatNum ${patNum}: ${e.message}`,
    );
    return null;
  }
}

// ─── Write Verified Benefits Back to OD MySQL ─────────────────────────────────

async function writeOdBenefits(params) {
  const {
    pat_num,
    benefits = [],
    plan_note,
    source,
    confidence,
    dry_run = false,
  } = params;

  const result = {
    pat_num,
    plan_num: null,
    dry_run,
    rows_written: 0,
    rows_unchanged: 0,
    plan_note_updated: false,
    rollback_snapshot: null,
    errors: [],
  };

  if (
    source === "OD_MYSQL" ||
    source === "od_mysql" ||
    source === "OD_DIRECT"
  ) {
    result.errors.push("Circular write blocked — source is OD data");
    return result;
  }
  if (confidence != null && Number(confidence) < 75) {
    result.errors.push(`Confidence ${confidence} below threshold (75)`);
    return result;
  }

  const p = await getPool();
  if (!p) {
    result.errors.push("OD MySQL unavailable");
    return result;
  }

  const planInfo = await getPatientPlanInfo(pat_num);
  if (!planInfo) {
    result.errors.push(`No primary plan for PatNum ${pat_num}`);
    return result;
  }
  const { PlanNum } = planInfo;
  result.plan_num = PlanNum;

  let existingBenefitRows = [],
    existingPlan = null;
  try {
    const [bRows] = await p.query(
      `SELECT BenefitNum, BenefitType, CovCatNum, Percent, MonetaryAmt, CoverageLevel
       FROM benefit WHERE PlanNum = ? AND PatNum = 0`,
      [PlanNum],
    );
    existingBenefitRows = bRows;
    result.rollback_snapshot = bRows.map((r) => ({ ...r }));
    const [pRows] = await p.query(
      `SELECT PlanNum, AnnualMax, Deductible, PlanNote FROM insplan WHERE PlanNum = ?`,
      [PlanNum],
    );
    existingPlan = pRows[0] ?? null;
  } catch (e) {
    result.errors.push(`Pre-read failed: ${e.message}`);
    return result;
  }

  const covCatMap = await buildCovCatMap();

  for (const b of benefits) {
    try {
      if (b.type === "AnnualMax") {
        const newVal = (b.amount_cents ?? 0) / 100;
        const curVal = Number(existingPlan?.AnnualMax ?? 0);
        if (Math.abs(newVal - curVal) < 0.01) {
          result.rows_unchanged++;
          continue;
        }
        if (!dry_run)
          await p.query(`UPDATE insplan SET AnnualMax = ? WHERE PlanNum = ?`, [
            newVal,
            PlanNum,
          ]);
        result.rows_written++;
      } else if (b.type === "Deductible") {
        const newVal = (b.amount_cents ?? 0) / 100;
        const curVal = Number(existingPlan?.Deductible ?? 0);
        if (Math.abs(newVal - curVal) < 0.01) {
          result.rows_unchanged++;
          continue;
        }
        if (!dry_run)
          await p.query(`UPDATE insplan SET Deductible = ? WHERE PlanNum = ?`, [
            newVal,
            PlanNum,
          ]);
        result.rows_written++;
      } else if (b.type === "CoInsurance") {
        const covCatNum = covCatMap[b.category] ?? 0;
        const percent = b.plan_pays_pct ?? 0;
        const existing = existingBenefitRows.find(
          (r) =>
            r.BenefitType === 1 &&
            r.CovCatNum === covCatNum &&
            r.CoverageLevel === 0,
        );
        if (existing && Math.abs(Number(existing.Percent) - percent) < 0.01) {
          result.rows_unchanged++;
          continue;
        }
        if (!dry_run) {
          if (existing) {
            await p.query(
              `UPDATE benefit SET Percent = ? WHERE BenefitNum = ?`,
              [percent, existing.BenefitNum],
            );
          } else {
            await p.query(
              `INSERT INTO benefit (PlanNum, PatNum, CodeNum, CovCatNum, BenefitType, Percent, MonetaryAmt, TimePeriod, QuantityQualifier, Quantity, CoverageLevel)
               VALUES (?, 0, 0, ?, 1, ?, 0, 2, 0, -1, 0)`,
              [PlanNum, covCatNum, percent],
            );
          }
        }
        result.rows_written++;
      }
    } catch (e) {
      result.errors.push(`${b.type}/${b.category ?? ""}: ${e.message}`);
    }
  }

  if (plan_note) {
    try {
      const existing = (existingPlan?.PlanNote ?? "").trim();
      // Deduplication: check if this date's entry is already in the plan note.
      // Plan note format: "5/18/26 EDiFi EDI. ..." — first 8 chars are the date prefix.
      const notePrefix = plan_note.substring(0, 8);
      const alreadyWritten = notePrefix && existing.includes(notePrefix);
      if (!alreadyWritten) {
        const newNote = existing ? `${existing}\n${plan_note}` : plan_note;
        if (!dry_run)
          await p.query(`UPDATE insplan SET PlanNote = ? WHERE PlanNum = ?`, [
            newNote,
            PlanNum,
          ]);
        result.plan_note_updated = true;
      }
    } catch (e) {
      result.errors.push(`Plan note: ${e.message}`);
    }
  }

  logger(
    `[WriteBack] PatNum ${pat_num} Plan ${PlanNum}: ` +
      `${dry_run ? "[DRY RUN] " : ""}${result.rows_written} written, ` +
      `${result.rows_unchanged} unchanged, ${result.errors.length} errors`,
  );
  return result;
}

// ─── Operatory Columns (board layout, read-only) ──────────────────────────────
// OD renders EVERY non-hidden operatory as a board column in ItemOrder — not
// just the occupied ones. Returned rows are the column list itself.

async function getOperatories() {
  const p = await getPool();
  if (!p) return [];
  try {
    const [rows] = await p.query(
      `SELECT OperatoryNum, OpName, Abbrev, ItemOrder, IsHidden
         FROM operatory
        WHERE IsHidden = 0
        ORDER BY ItemOrder`,
    );
    return rows.map((r) => ({
      operatory_num: Number(r.OperatoryNum),
      name: String(r.OpName || "").trim(),
      abbrev: String(r.Abbrev || "").trim(),
      item_order: Number(r.ItemOrder),
    }));
  } catch (e) {
    logger(`getOperatories error: ${e.message}`);
    return [];
  }
}

// ─── Appointment Types for a Date (read-only, probe-guarded) ──────────────────
// Resolves each appointment's type name + OD packed color. Deliberately keyed
// off AptNum in its own query so the primary getAppointmentsForDate SELECT is
// untouched. Hidden types are NOT filtered out: an appointment assigned a
// since-hidden type still renders with that type's color in OD.

/**
 * Open Dental's confirmation-status palette — `definition` Category 2, the
 * office's own list behind `appointment.Confirmed` (a DefNum FK).
 *
 * Probe-guarded like getAppointmentTypesForDate: a schema without the table or
 * the columns returns [] and the board keeps its current status colors. Colors
 * are the raw signed ARGB integers OD stores; the backend converts them once,
 * at ingest, so this stays a dumb read.
 */
async function getStatusDefinitions() {
  const p = await getPool();
  if (!p) return [];
  try {
    const [[tableRow]] = await p.query(
      `SELECT COUNT(*) AS cnt
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'definition'`,
    );
    if (Number(tableRow?.cnt || 0) === 0) return [];

    const [rows] = await p.query(
      `SELECT d.DefNum, d.ItemName, d.ItemColor, d.ItemOrder, d.IsHidden
         FROM definition d
        WHERE d.Category = 2
        ORDER BY d.ItemOrder`,
    );
    return rows.map((r) => ({
      def_num: Number(r.DefNum),
      // Hidden entries are still returned: an appointment can carry a Confirmed
      // value the office later hid, and dropping it would leave that status
      // unlabeled on the card.
      is_hidden: Number(r.IsHidden || 0) === 1,
      status_name: String(r.ItemName || "").trim() || null,
      status_color: r.ItemColor != null ? Number(r.ItemColor) : null,
    }));
  } catch (e) {
    logger(`getStatusDefinitions error: ${e.message}`);
    return [];
  }
}

async function getAppointmentTypesForDate(date) {
  if (!(await probeAppointmentTypeSupport())) return [];
  const p = await getPool();
  if (!p) return [];
  const targetDate = date || new Date().toISOString().slice(0, 10);
  try {
    const [rows] = await p.query(
      `SELECT a.AptNum, a.AppointmentTypeNum,
              at.AppointmentTypeName, at.AppointmentTypeColor
         FROM appointment a
         JOIN appointmenttype at
           ON at.AppointmentTypeNum = a.AppointmentTypeNum
        WHERE DATE(a.AptDateTime) = ?
          AND a.AppointmentTypeNum <> 0`,
      [targetDate],
    );
    return rows.map((r) => ({
      apt_num: Number(r.AptNum),
      appointment_type_num: Number(r.AppointmentTypeNum),
      type_name: String(r.AppointmentTypeName || "").trim() || null,
      type_color:
        r.AppointmentTypeColor != null ? Number(r.AppointmentTypeColor) : null,
    }));
  } catch (e) {
    logger(`getAppointmentTypesForDate error (${targetDate}): ${e.message}`);
    return [];
  }
}

module.exports = {
  isAvailable,
  recheckAvailability,
  readOdConfig,
  odWallDateTime,
  odWallDate,
  AGENT_EXT_DATETIME_COLUMNS,
  getBenefitsForPatient,
  mapMysqlBenefitRow,
  mapMysqlBenefits,
  probeCodeGroupSupport,
  probeAppointmentTypeSupport,
  probeAgentExtColumns,
  agentExtSelectFragment,
  getStatusDefinitions,
  AGENT_EXT_COLUMNS,
  getPatNumByNameDOB,
  getAppointmentsForDate,
  getAppointmentsToday,
  getOperatories,
  getAppointmentTypesForDate,
  getPatientInsuranceSnapshot,
  getAppointmentProcedures,
  writeOdBenefits,
  buildCovCatMap,
  setLogger,
  setManualMysqlConfig,
  clearManualMysqlConfig,
  buildConnectStrategies,
  getConnectDiagnostics,
};
