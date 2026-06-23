/**
 * G-09I: READ_OD_PLAN_BENEFITS — read-only evidence probe.
 *
 * Sanitizes and structures raw OD API responses for diagnostic use.
 * Evidence only — no mapping, no inference, no category transformation.
 * Shared by electron-app/main.js and service/bridge.js.
 *
 * PHI rules:
 *   - PatNum, SubscriberID removed entirely
 *   - PatPlanNum > 0 replaced with "REDACTED"
 *   - BenefitNum/PlanNum replaced with synthetic IDs
 *   - Free-text fields: { present, length } only — no value
 *   - All other fields are plan configuration (non-PHI) and are kept
 */

// Fields that are plan configuration — safe to keep values
const SAFE_VALUE_FIELDS = new Set([
  "BenefitType",
  "CovCatNum",
  "Percent",
  "MonetaryAmt",
  "TimePeriod",
  "QuantityQualifier",
  "Quantity",
  "CodeNum",
  "procCode",
  "CodeGroupNum",
  "TreatArea",
  "CoverageLevel",
  "EbenefitCat",
  "IsHidden",
  "SecDateTEntry",
]);

// Fields that must be removed entirely (patient identifiers)
const REMOVE_FIELDS = new Set([
  "PatNum",
  "SubscriberID",
  "Subscriber",
  "SubNote",
]);

/**
 * Sanitize one raw OD benefit row.
 * @param {object} raw   - raw row from OD REST API
 * @param {number} index - row index (used to build synthetic ID)
 * @returns sanitized row
 */
function sanitizeBenefitRow(raw, index) {
  const out = {
    row: `B${index}`,
    AllKeys: Object.keys(raw).join(","),
  };

  for (const [key, val] of Object.entries(raw)) {
    // Remove patient identifiers entirely
    if (REMOVE_FIELDS.has(key)) continue;

    // Synthetic IDs
    if (key === "BenefitNum") {
      out[key] = `B${index}`;
      continue;
    }
    if (key === "PlanNum") {
      out[key] = "P001";
      continue;
    }

    // PatPlanNum: 0 = plan-level (safe), >0 = patient-specific (redact)
    if (key === "PatPlanNum") {
      out[key] = Number(val) > 0 ? "REDACTED" : 0;
      continue;
    }

    // Safe plan-config fields — keep value
    if (SAFE_VALUE_FIELDS.has(key)) {
      out[key] = val ?? null;
      continue;
    }

    // Unknown fields or potential free-text: report presence and length only
    const strVal = val != null ? String(val) : "";
    out[key] = { present: strVal.length > 0, length: strVal.length };
  }

  // Ensure critical fields always present (null if absent)
  for (const f of [
    "CovCatNum",
    "BenefitType",
    "Percent",
    "CodeNum",
    "procCode",
    "CodeGroupNum",
    "CoverageLevel",
    "EbenefitCat",
    "PatPlanNum",
    "TreatArea",
    "Quantity",
    "TimePeriod",
  ]) {
    if (!(f in out)) out[f] = null;
  }

  return out;
}

/**
 * Sanitize one raw OD covcat row.
 * Covcat is pure plan configuration — no PHI. All fields kept.
 */
function sanitizeCovcatRow(raw) {
  return { ...raw };
}

/**
 * Produce summary statistics from sanitized benefit rows.
 * Evidence only — no category names, no mapping.
 * @param {object[]} rows - output of sanitizeBenefitRow[]
 */
function summarizeBenefitRows(rows) {
  const byType = {};
  const coinsuranceRows = [];
  const limitationRows = [];

  for (const r of rows) {
    const bt = r.BenefitType ?? "unknown";
    byType[bt] = (byType[bt] || 0) + 1;

    if (bt === "CoInsurance" || bt === 1 || bt === "1") {
      coinsuranceRows.push(r);
    } else if (bt === "Limitations" || bt === 3 || bt === "3") {
      limitationRows.push(r);
    }
  }

  // Signal distribution for CoInsurance rows
  const sig = {
    cov_cat_num_nonzero: 0,
    code_group_num_nonzero: 0,
    code_num_nonzero: 0,
    proc_code_nonempty: 0,
    no_signal: 0,
  };
  for (const r of coinsuranceRows) {
    const hasCovCat = Number(r.CovCatNum ?? 0) > 0;
    const hasGroup = Number(r.CodeGroupNum ?? 0) > 0;
    const hasCode = Number(r.CodeNum ?? 0) > 0;
    const hasProc = String(r.procCode ?? "").trim().length > 0;
    if (hasCovCat) sig.cov_cat_num_nonzero++;
    if (hasGroup) sig.code_group_num_nonzero++;
    if (hasCode) sig.code_num_nonzero++;
    if (hasProc) sig.proc_code_nonempty++;
    if (!hasCovCat && !hasGroup && !hasCode && !hasProc) sig.no_signal++;
  }

  return {
    total: rows.length,
    by_benefit_type: byType,
    coinsurance_count: coinsuranceRows.length,
    limitation_count: limitationRows.length,
    coinsurance_rows: coinsuranceRows,
    limitation_rows: limitationRows,
    signal_distribution: sig,
  };
}

module.exports = {
  sanitizeBenefitRow,
  sanitizeCovcatRow,
  summarizeBenefitRows,
};
