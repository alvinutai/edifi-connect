// Tests for appointment-window date logic.
// Pure functions only — no Electron, no network, no PHI.
// Run: node test/appointment-window.test.js

const assert = require("assert");
const {
  DEFAULT_LOOKAHEAD_DAYS,
  isValidTimezone,
  resolveOfficeTimezone,
  getOfficeLocalDateISO,
  getAppointmentDateWindow,
} = require("../lib/appointment-window");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

console.log("\nappointment-window");

// ─── Timezone validation ────────────────────────────────────────────────────

test("valid IANA timezone is accepted", () => {
  assert.strictEqual(isValidTimezone("America/Denver"), true);
});

test("invalid timezone is rejected", () => {
  assert.strictEqual(isValidTimezone("Mars/Phobos"), false);
});

test("empty/null timezone is rejected", () => {
  assert.strictEqual(isValidTimezone(""), false);
  assert.strictEqual(isValidTimezone(null), false);
  assert.strictEqual(isValidTimezone(undefined), false);
});

// ─── Office timezone resolution ─────────────────────────────────────────────

test("resolveOfficeTimezone accepts valid IANA timezone", () => {
  const result = resolveOfficeTimezone("America/Denver");
  assert.deepStrictEqual(result, {
    timezone: "America/Denver",
    source: "config",
  });
});

test("resolveOfficeTimezone falls back to UTC when timezone is missing", () => {
  const result = resolveOfficeTimezone(null);
  assert.deepStrictEqual(result, {
    timezone: "UTC",
    source: "utc_fallback",
  });
});

test("resolveOfficeTimezone falls back to UTC when timezone is empty", () => {
  const result = resolveOfficeTimezone("");
  assert.deepStrictEqual(result, {
    timezone: "UTC",
    source: "utc_fallback",
  });
});

test("resolveOfficeTimezone falls back to UTC when timezone is invalid", () => {
  const result = resolveOfficeTimezone("Mars/Phobos");
  assert.deepStrictEqual(result, {
    timezone: "UTC",
    source: "utc_fallback",
  });
});

// The caller (main.js / bridge.js) is responsible for emitting a prominent
// WARNING log whenever source === "utc_fallback". These pure-function tests
// confirm the observable source flag that drives that warning.

// ─── Office-local date resolution ───────────────────────────────────────────

test("Denver local date before UTC midnight is still previous local date", () => {
  // 2026-06-18 05:30 UTC = 2026-06-17 23:30 MDT (UTC-6)
  const anchor = new Date("2026-06-18T05:30:00.000Z");
  const local = getOfficeLocalDateISO("America/Denver", anchor);
  assert.strictEqual(local, "2026-06-17");
});

test("Denver local date after UTC midnight is current local date", () => {
  // 2026-06-17 12:00 UTC = 2026-06-17 06:00 MDT
  const anchor = new Date("2026-06-17T12:00:00.000Z");
  const local = getOfficeLocalDateISO("America/Denver", anchor);
  assert.strictEqual(local, "2026-06-17");
});

test("invalid timezone falls back to UTC", () => {
  const anchor = new Date("2026-06-17T12:00:00.000Z");
  const local = getOfficeLocalDateISO("Invalid/Zone", anchor);
  assert.strictEqual(local, "2026-06-17");
});

// ─── Window generation ──────────────────────────────────────────────────────

test("default lookahead returns 3 dates starting from office-local today", () => {
  const anchor = new Date("2026-06-17T12:00:00.000Z");
  const dates = getAppointmentDateWindow("America/Denver", DEFAULT_LOOKAHEAD_DAYS, anchor);
  assert.strictEqual(dates.length, 3);
  assert.strictEqual(dates[0], "2026-06-17");
  assert.strictEqual(dates[1], "2026-06-18");
  assert.strictEqual(dates[2], "2026-06-19");
});

test("lookahead=0 returns only office-local today", () => {
  const anchor = new Date("2026-06-17T12:00:00.000Z");
  const dates = getAppointmentDateWindow("America/Denver", 0, anchor);
  assert.deepStrictEqual(dates, ["2026-06-17"]);
});

test("lookahead=6 returns 7 dates", () => {
  const anchor = new Date("2026-06-17T12:00:00.000Z");
  const dates = getAppointmentDateWindow("America/Denver", 6, anchor);
  assert.strictEqual(dates.length, 7);
  assert.strictEqual(dates[0], "2026-06-17");
  assert.strictEqual(dates[6], "2026-06-23");
});

test("negative lookahead falls back to default", () => {
  const anchor = new Date("2026-06-17T12:00:00.000Z");
  const dates = getAppointmentDateWindow("America/Denver", -1, anchor);
  assert.strictEqual(dates.length, 3);
});

test("non-numeric lookahead falls back to default", () => {
  const anchor = new Date("2026-06-17T12:00:00.000Z");
  const dates = getAppointmentDateWindow("America/Denver", "abc", anchor);
  assert.strictEqual(dates.length, 3);
});

// ─── DST edge cases ─────────────────────────────────────────────────────────

test("Denver fall-back DST transition: day after transition is correct", () => {
  // DST ends 2026-11-01 02:00 MDT -> 01:00 MST
  // 2026-11-01 12:00 UTC = 2026-11-01 06:00 MDT (before fallback)
  const anchor = new Date("2026-11-01T12:00:00.000Z");
  const dates = getAppointmentDateWindow("America/Denver", 2, anchor);
  assert.deepStrictEqual(dates, ["2026-11-01", "2026-11-02", "2026-11-03"]);
});

test("Denver spring-forward DST transition: day after transition is correct", () => {
  // DST starts 2026-03-08 02:00 MST -> 03:00 MDT
  // 2026-03-08 12:00 UTC = 2026-03-08 06:00 MDT
  const anchor = new Date("2026-03-08T12:00:00.000Z");
  const dates = getAppointmentDateWindow("America/Denver", 2, anchor);
  assert.deepStrictEqual(dates, ["2026-03-08", "2026-03-09", "2026-03-10"]);
});

// ─── Eastern timezone ───────────────────────────────────────────────────────

test("Eastern timezone window resolves correctly", () => {
  // 2026-06-17 05:30 UTC = 2026-06-17 01:30 EDT
  const anchor = new Date("2026-06-17T05:30:00.000Z");
  const dates = getAppointmentDateWindow("America/New_York", 2, anchor);
  assert.deepStrictEqual(dates, ["2026-06-17", "2026-06-18", "2026-06-19"]);
});

// ─── Config-driven default ──────────────────────────────────────────────────

test("DEFAULT_LOOKAHEAD_DAYS is 2", () => {
  assert.strictEqual(DEFAULT_LOOKAHEAD_DAYS, 2);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
