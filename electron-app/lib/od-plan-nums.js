// G-09M: Sanitizers for READ_OD_PLAN_NUMS command.
// Builds fresh output objects from OD REST /insplans or MySQL insplan rows.
// No spread, no Object.assign, no forwarding of raw rows.

// Scalar coercion for string fields. Objects/arrays → empty string (no nested data).
function toSafeStr(val, maxLen) {
  if (val == null) return "";
  if (typeof val === "string") return val.slice(0, maxLen).trim();
  if (typeof val === "number") return String(val);
  return "";
}

// Builds a sanitized row from OD REST GET /insplans response.
// REST returns CarrierNum (FK), not CarrierName — carrier_name is always null here.
// Only explicitly listed fields are included; all other REST fields are dropped.
function sanitizeRestRow(row, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const planNum = Number(row.PlanNum);
  if (!Number.isInteger(planNum) || planNum <= 0) return null;
  return {
    row_label: `P${String(index + 1).padStart(3, "0")}`,
    plan_num: planNum,
    carrier_name: null,
    group_name: toSafeStr(row.GroupName, 80),
    plan_type: toSafeStr(row.PlanType, 40),
    fee_sched: Number.isFinite(Number(row.FeeSched)) ? Number(row.FeeSched) : 0,
    plan_note_present:
      typeof row.PlanNote === "string" ? row.PlanNote.length > 0 : false,
    plan_note_length:
      typeof row.PlanNote === "string" ? row.PlanNote.length : 0,
  };
}

// Builds a sanitized row from MySQL insplan + carrier query result.
// carrier_name populated via LEFT JOIN carrier — may be null if no match.
// PlanNotePresent and PlanNoteLength come from CASE/CHAR_LENGTH in the query.
function sanitizeMysqlRow(row, index) {
  if (!row || typeof row !== "object") return null;
  const planNum = Number(row.PlanNum);
  if (!Number.isInteger(planNum) || planNum <= 0) return null;
  return {
    row_label: `P${String(index + 1).padStart(3, "0")}`,
    plan_num: planNum,
    carrier_name: row.CarrierName ? toSafeStr(row.CarrierName, 120) : null,
    group_name: toSafeStr(row.GroupName, 80),
    plan_type: toSafeStr(row.PlanType, 40),
    fee_sched: Number.isFinite(Number(row.FeeSched)) ? Number(row.FeeSched) : 0,
    plan_note_present: Number(row.PlanNotePresent) === 1,
    plan_note_length: Number(row.PlanNoteLength) || 0,
  };
}

// Sanitizes carrier_filter payload field.
// Strips chars outside alphanumeric/space/hyphen/period, trims, lowercases, caps 80.
// Returns empty string for null, non-string, or fully stripped input.
function sanitizeFilter(raw) {
  if (raw == null || typeof raw !== "string") return "";
  return raw
    .replace(/[^a-zA-Z0-9 \-\.]/g, "")
    .trim()
    .slice(0, 80)
    .toLowerCase();
}

// Builds a sanitized REST row with a resolved carrier name and match_source.
// Use when carrier_filter is active — resolvedCarrierName from /carriers/{CarrierNum}.
// matchSource: "carrier_name" | "group_name" depending on which field matched the filter.
function sanitizeRestRowWithCarrier(row, index, resolvedCarrierName, matchSource) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const planNum = Number(row.PlanNum);
  if (!Number.isInteger(planNum) || planNum <= 0) return null;
  return {
    row_label: `P${String(index + 1).padStart(3, "0")}`,
    plan_num: planNum,
    carrier_name: resolvedCarrierName ? toSafeStr(resolvedCarrierName, 120) : null,
    group_name: toSafeStr(row.GroupName, 80),
    plan_type: toSafeStr(row.PlanType, 40),
    fee_sched: Number.isFinite(Number(row.FeeSched)) ? Number(row.FeeSched) : 0,
    plan_note_present:
      typeof row.PlanNote === "string" ? row.PlanNote.length > 0 : false,
    plan_note_length:
      typeof row.PlanNote === "string" ? row.PlanNote.length : 0,
    match_source: matchSource ?? null,
  };
}

// Builds a sanitized MySQL row with match_source for filtered queries.
// matchSource: "carrier_name" | "group_name" | null.
function sanitizeMysqlRowFiltered(row, index, matchSource) {
  if (!row || typeof row !== "object") return null;
  const planNum = Number(row.PlanNum);
  if (!Number.isInteger(planNum) || planNum <= 0) return null;
  return {
    row_label: `P${String(index + 1).padStart(3, "0")}`,
    plan_num: planNum,
    carrier_name: row.CarrierName ? toSafeStr(row.CarrierName, 120) : null,
    group_name: toSafeStr(row.GroupName, 80),
    plan_type: toSafeStr(row.PlanType, 40),
    fee_sched: Number.isFinite(Number(row.FeeSched)) ? Number(row.FeeSched) : 0,
    plan_note_present: Number(row.PlanNotePresent) === 1,
    plan_note_length: Number(row.PlanNoteLength) || 0,
    match_source: matchSource ?? null,
  };
}

module.exports = {
  sanitizeRestRow,
  sanitizeMysqlRow,
  sanitizeRestRowWithCarrier,
  sanitizeMysqlRowFiltered,
  sanitizeFilter,
};
