// Appointment window utilities.
// Pure functions — no Electron, no network, no PHI.
// Resolves office-local calendar dates using the configured IANA timezone.

const DEFAULT_LOOKAHEAD_DAYS = 2;

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
 * @param {number} lookaheadDays  0 = today only; default 2 = today + 2 more days
 * @param {Date} [anchor]
 * @returns {string[]} array of YYYY-MM-DD strings
 */
function getAppointmentDateWindow(
  tz,
  lookaheadDays = DEFAULT_LOOKAHEAD_DAYS,
  anchor = new Date(),
) {
  const days =
    Number.isFinite(lookaheadDays) && lookaheadDays >= 0
      ? Math.floor(lookaheadDays)
      : DEFAULT_LOOKAHEAD_DAYS;

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

module.exports = {
  DEFAULT_LOOKAHEAD_DAYS,
  isValidTimezone,
  resolveOfficeTimezone,
  getOfficeLocalDateISO,
  getAppointmentDateWindow,
};
