// Appointment window utilities.
// Pure functions — no Electron, no network, no PHI.
// Resolves office-local calendar dates using the configured IANA timezone.

// Safe default: 0 = today only (backward compatible). Set
// appointment_sync_lookahead_days in config.json to widen the window
// (e.g. 2 = today + next 2 days). Malformed/negative/missing collapses to 0.
const DEFAULT_LOOKAHEAD_DAYS = 0;

// Hard ceiling: a bad config value can never create an unbounded sync fan-out.
const MAX_LOOKAHEAD_DAYS = 14;

/**
 * Canonical lookahead parser — the ONLY place lookahead is normalized, so no
 * caller parses independently. Accepts numbers and numeric strings ("2" -> 2).
 * Anything not a finite, non-negative number collapses to 0 (today-only);
 * fractions floor to int; values above MAX_LOOKAHEAD_DAYS clamp to the ceiling.
 *   2 -> 2 | "2" -> 2 | 2.7 -> 2 | -1 -> 0 | "abc" -> 0 | "" -> 0
 *   null -> 0 | undefined -> 0 | 999 -> 14
 * @param {unknown} rawValue
 * @returns {number} integer in [0, MAX_LOOKAHEAD_DAYS]
 */
function parseLookaheadDays(rawValue) {
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_LOOKAHEAD_DAYS;
  return Math.min(Math.floor(n), MAX_LOOKAHEAD_DAYS);
}

/**
 * Validate an IANA timezone string.
 * @param {string|undefined|null} tz
 * @returns {boolean}
 */
function isValidTimezone(tz) {
  if (typeof tz !== "string" || tz.trim() === "") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Return YYYY-MM-DD for the given timezone and anchor instant.
 * Falls back to UTC if the timezone is missing or invalid.
 * @param {string|null|undefined} tz
 * @param {Date} [anchor]
 * @returns {string}
 */
function getOfficeLocalDateISO(tz, anchor = new Date()) {
  const timezone = isValidTimezone(tz) ? tz : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(anchor);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

/**
 * Format a UTC Date as YYYY-MM-DD.
 * @param {Date} date
 * @returns {string}
 */
function formatUTCDateISO(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Add N calendar days to a local ISO date, returning the local ISO date in the
 * same timezone. Robust across DST transitions and offsets from UTC-12 to UTC+14.
 * @param {string} localIso  YYYY-MM-DD in the target timezone
 * @param {string|null|undefined} tz
 * @param {number} n  days to add (non-negative)
 * @returns {string}
 */
function addLocalDays(localIso, tz, n) {
  const [y, m, d] = localIso.split("-").map(Number);
  const expected = new Date(Date.UTC(y, m - 1, d + n));
  const expectedIso = formatUTCDateISO(expected);

  // First guess: noon UTC on the expected calendar date.
  // This is within the expected local date for all common timezones.
  let candidate = new Date(Date.UTC(y, m - 1, d + n, 12, 0, 0));
  let actual = getOfficeLocalDateISO(tz, candidate);

  // Adjust by one day if the first guess crossed a local date boundary
  // (handles UTC+13/14 and far-eastern timezones).
  if (actual > expectedIso) {
    candidate = new Date(candidate.getTime() - 24 * 60 * 60 * 1000);
    actual = getOfficeLocalDateISO(tz, candidate);
  } else if (actual < expectedIso) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
    actual = getOfficeLocalDateISO(tz, candidate);
  }

  return actual;
}

/**
 * Build the appointment sync date window.
 * @param {string|null|undefined} tz  office IANA timezone
 * @param {number} lookaheadDays  0 = today only (default); 2 = today + next 2 days
 * @param {Date} [anchor]
 * @returns {string[]} array of unique YYYY-MM-DD strings, today first
 */
function getAppointmentDateWindow(
  tz,
  lookaheadDays = DEFAULT_LOOKAHEAD_DAYS,
  anchor = new Date(),
) {
  // Normalize via the single canonical parser (accepts "2", clamps to max).
  const days = parseLookaheadDays(lookaheadDays);

  const localToday = getOfficeLocalDateISO(tz, anchor);
  const dates = [localToday];
  for (let n = 1; n <= days; n++) {
    dates.push(addLocalDays(localToday, tz, n));
  }
  return dates;
}

/**
 * Resolve the office timezone from config.
 * Returns the configured timezone if it is a valid IANA string, otherwise
 * returns UTC with source="utc_fallback". The caller is responsible for
 * logging a prominent warning when the fallback is used.
 * @param {string|undefined|null} rawValue
 * @returns {{ timezone: string, source: "config" | "utc_fallback" }}
 */
function resolveOfficeTimezone(rawValue) {
  if (isValidTimezone(rawValue)) {
    return { timezone: rawValue, source: "config" };
  }
  return { timezone: "UTC", source: "utc_fallback" };
}

/**
 * Group appointment rows by their office-local YYYY-MM-DD date.
 * Uses AptDateTime (which mysql2 returns as a JS Date) and ignores any
 * apt_date field, so grouping keys are always strings and always match the
 * window date strings produced by getAppointmentDateWindow().
 * @param {Array<{AptDateTime: Date|string}>} apts
 * @param {string|null|undefined} tz
 * @returns {Map<string, Array<object>>}
 */
function groupAppointmentsByLocalDate(apts, tz) {
  const byDate = new Map();
  for (const apt of apts) {
    // Prefer the DB-derived local date string (DATE_FORMAT(AptDateTime) from the
    // SQL query) so a host-timezone mismatch in mysql2's Date parsing can never
    // move a near-midnight appointment to the wrong day. Fall back to tz
    // conversion for rows that don't carry it (e.g. REST-shaped inputs).
    const aptDate =
      typeof apt.apt_local_date === "string" && apt.apt_local_date
        ? apt.apt_local_date
        : getOfficeLocalDateISO(tz, new Date(apt.AptDateTime));
    if (!byDate.has(aptDate)) byDate.set(aptDate, []);
    byDate.get(aptDate).push(apt);
  }
  return byDate;
}

/**
 * Run a per-date sync callback across a date list with three guarantees the
 * fleet relies on:
 *   1. one run per date — duplicate dates are collapsed, so a date is never
 *      pushed twice;
 *   2. failure isolation — one date throwing never aborts the remaining dates;
 *   3. no error hiding — every failure is collected, so a later date's success
 *      cannot overwrite an earlier date's error in the caller's status record.
 * @param {string[]} dates
 * @param {(date: string) => Promise<number>} syncOne  resolves to pushes emitted for the date
 * @returns {Promise<{ pushes: number, errors: Array<{date: string, msg: string}>, datesRun: string[] }>}
 */
async function runPerDateSync(dates, syncOne) {
  const seen = new Set();
  const errors = [];
  const datesRun = [];
  let pushes = 0;
  for (const date of Array.isArray(dates) ? dates : []) {
    if (seen.has(date)) continue;
    seen.add(date);
    datesRun.push(date);
    try {
      pushes += (await syncOne(date)) || 0;
    } catch (e) {
      errors.push({ date, msg: e.message });
    }
  }
  return { pushes, errors, datesRun };
}

module.exports = {
  DEFAULT_LOOKAHEAD_DAYS,
  MAX_LOOKAHEAD_DAYS,
  parseLookaheadDays,
  isValidTimezone,
  resolveOfficeTimezone,
  getOfficeLocalDateISO,
  getAppointmentDateWindow,
  groupAppointmentsByLocalDate,
  runPerDateSync,
};
