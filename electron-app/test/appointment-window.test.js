/**
 * Appointment window utilities — timezone / DST / lookahead / loop-isolation tests.
 * Pure functions, no database, no Electron.
 * Run: node test/appointment-window.test.js
 */

const assert = require("assert");
const {
  DEFAULT_LOOKAHEAD_DAYS,
  resolveOfficeTimezone,
  getOfficeLocalDateISO,
  getAppointmentDateWindow,
  groupAppointmentsByLocalDate,
  runPerDateSync,
} = require("../lib/appointment-window");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n   ${e.message}`);
  }
}

// Calendar dates must be strictly consecutive — this catches a DST skip or dup.
function assertConsecutive(dates) {
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(`${dates[i - 1]}T00:00:00Z`);
    const cur = new Date(`${dates[i]}T00:00:00Z`);
    const diffDays = (cur - prev) / (24 * 3600 * 1000);
    assert.strictEqual(
      diffDays,
      1,
      `dates not consecutive: ${dates[i - 1]} -> ${dates[i]}`,
    );
  }
}

(async () => {
  // ─── Lookahead sizing ───────────────────────────────────────────────────────

  await test("lookahead 0 → today only (backward compatible)", () => {
    const tz = "America/Denver";
    const anchor = new Date("2026-07-13T19:00:00Z");
    const w = getAppointmentDateWindow(tz, 0, anchor);
    assert.strictEqual(w.length, 1);
    assert.strictEqual(w[0], getOfficeLocalDateISO(tz, anchor));
  });

  await test("lookahead 2 → today + next 2 days, consecutive", () => {
    const tz = "America/Denver";
    const anchor = new Date("2026-07-13T19:00:00Z");
    const w = getAppointmentDateWindow(tz, 2, anchor);
    assert.strictEqual(w.length, 3);
    assert.strictEqual(w[0], getOfficeLocalDateISO(tz, anchor));
    assertConsecutive(w);
  });

  await test("invalid lookahead (string) → today only", () => {
    const w = getAppointmentDateWindow("America/Denver", "foo", new Date());
    assert.strictEqual(w.length, 1);
  });

  await test("invalid lookahead (NaN) → today only", () => {
    const w = getAppointmentDateWindow("America/Denver", NaN, new Date());
    assert.strictEqual(w.length, 1);
  });

  await test("negative lookahead (-3) → today only (fail-safe)", () => {
    const w = getAppointmentDateWindow("America/Denver", -3, new Date());
    assert.strictEqual(w.length, 1);
  });

  await test("fractional lookahead floors (2.9 → 3 dates)", () => {
    const w = getAppointmentDateWindow("America/Denver", 2.9, new Date());
    assert.strictEqual(w.length, 3);
  });

  await test("DEFAULT_LOOKAHEAD_DAYS is 0 (fleet-safe default)", () => {
    assert.strictEqual(DEFAULT_LOOKAHEAD_DAYS, 0);
  });

  // ─── DST transitions ────────────────────────────────────────────────────────

  await test("DST spring-forward (America/Denver 2026-03-08) stays consecutive", () => {
    const tz = "America/Denver";
    // 2026-03-07 12:00 MST = 2026-03-07 19:00 UTC. Window crosses the DST start.
    const anchor = new Date("2026-03-07T19:00:00Z");
    const w = getAppointmentDateWindow(tz, 2, anchor);
    assert.deepStrictEqual(w, ["2026-03-07", "2026-03-08", "2026-03-09"]);
  });

  await test("DST fall-back (America/Denver 2026-11-01) stays consecutive", () => {
    const tz = "America/Denver";
    // 2026-10-31 12:00 MDT = 2026-10-31 18:00 UTC. Window crosses the DST end.
    const anchor = new Date("2026-10-31T18:00:00Z");
    const w = getAppointmentDateWindow(tz, 2, anchor);
    assert.deepStrictEqual(w, ["2026-10-31", "2026-11-01", "2026-11-02"]);
  });

  // ─── Timezone offset extremes ───────────────────────────────────────────────

  await test("office tz ahead of UTC (Pacific/Kiritimati UTC+14)", () => {
    const tz = "Pacific/Kiritimati";
    // 2026-07-13 12:00 UTC = 2026-07-14 02:00 local (+14).
    const anchor = new Date("2026-07-13T12:00:00Z");
    const w = getAppointmentDateWindow(tz, 2, anchor);
    assert.strictEqual(w[0], "2026-07-14");
    assert.strictEqual(w[0], getOfficeLocalDateISO(tz, anchor));
    assertConsecutive(w);
    assert.deepStrictEqual(w, ["2026-07-14", "2026-07-15", "2026-07-16"]);
  });

  await test("office tz behind UTC (Pacific/Honolulu UTC-10)", () => {
    const tz = "Pacific/Honolulu";
    // 2026-07-13 06:00 UTC = 2026-07-12 20:00 local (-10).
    const anchor = new Date("2026-07-13T06:00:00Z");
    const w = getAppointmentDateWindow(tz, 1, anchor);
    assert.strictEqual(w[0], "2026-07-12");
    assert.strictEqual(w[0], getOfficeLocalDateISO(tz, anchor));
    assert.deepStrictEqual(w, ["2026-07-12", "2026-07-13"]);
  });

  await test("window dates are unique (repeated-date normalization)", () => {
    const w = getAppointmentDateWindow("America/Denver", 2, new Date());
    assert.strictEqual(new Set(w).size, w.length);
  });

  // ─── Timezone resolution ────────────────────────────────────────────────────

  await test("resolveOfficeTimezone(null) → UTC fallback", () => {
    const r = resolveOfficeTimezone(null);
    assert.strictEqual(r.timezone, "UTC");
    assert.strictEqual(r.source, "utc_fallback");
  });

  await test("resolveOfficeTimezone(valid) → config source", () => {
    const r = resolveOfficeTimezone("America/Denver");
    assert.strictEqual(r.timezone, "America/Denver");
    assert.strictEqual(r.source, "config");
  });

  await test("resolveOfficeTimezone(garbage) → UTC fallback", () => {
    assert.strictEqual(resolveOfficeTimezone("Not/AZone").source, "utc_fallback");
    assert.strictEqual(resolveOfficeTimezone("").source, "utc_fallback");
  });

  await test(
    "default config (tz unset, lookahead 0) matches old UTC today — no fleet behavior change",
    () => {
      const { timezone } = resolveOfficeTimezone(null); // UTC
      const anchor = new Date("2026-07-13T23:30:00Z");
      const w = getAppointmentDateWindow(timezone, 0, anchor);
      // Old code used new Date().toISOString().split("T")[0] — UTC calendar date.
      assert.deepStrictEqual(w, [anchor.toISOString().slice(0, 10)]);
    },
  );

  // ─── MySQL grouping (JS Date AptDateTime → string keys) ─────────────────────

  await test("groupAppointmentsByLocalDate keys by office-local date string", () => {
    const tz = "America/Denver";
    const rows = [
      { AptNum: 1, AptDateTime: new Date("2026-07-13T15:00:00.000Z") },
      { AptNum: 2, AptDateTime: new Date("2026-07-14T15:00:00.000Z") },
      { AptNum: 3, AptDateTime: new Date("2026-07-13T22:00:00.000Z") },
    ];
    const g = groupAppointmentsByLocalDate(rows, tz);
    assert.deepStrictEqual([...g.keys()], ["2026-07-13", "2026-07-14"]);
    assert.strictEqual(g.get("2026-07-13").length, 2);
    assert.strictEqual(g.get("2026-07-14").length, 1);
    for (const key of g.keys()) assert.strictEqual(typeof key, "string");
  });

  await test("groupAppointmentsByLocalDate maps into every window date", () => {
    const tz = "America/Denver";
    const anchor = new Date("2026-07-13T19:00:00Z");
    const window = getAppointmentDateWindow(tz, 2, anchor);
    const rows = window.map((d, i) => ({
      AptNum: i,
      AptDateTime: new Date(`${d}T18:00:00.000Z`),
    }));
    const g = groupAppointmentsByLocalDate(rows, tz);
    for (const d of window) assert.ok(g.has(d), `missing group ${d}`);
    // One group per distinct date — never more than the window size.
    assert.ok(g.size <= window.length);
  });

  // ─── Per-date loop: isolation, one-run-per-date, no error hiding ────────────

  await test("runPerDateSync runs each date once and sums pushes", async () => {
    const seen = [];
    const r = await runPerDateSync(["d1", "d2", "d3"], async (d) => {
      seen.push(d);
      return 1;
    });
    assert.deepStrictEqual(seen, ["d1", "d2", "d3"]);
    assert.strictEqual(r.pushes, 3);
    assert.deepStrictEqual(r.datesRun, ["d1", "d2", "d3"]);
    assert.strictEqual(r.errors.length, 0);
  });

  await test("runPerDateSync dedups repeated dates — one push per date", async () => {
    const seen = [];
    const r = await runPerDateSync(["d1", "d1", "d2", "d1"], async (d) => {
      seen.push(d);
      return 1;
    });
    assert.deepStrictEqual(seen, ["d1", "d2"]);
    assert.strictEqual(r.pushes, 2);
    assert.deepStrictEqual(r.datesRun, ["d1", "d2"]);
  });

  await test("runPerDateSync isolates one failing date, still runs the rest", async () => {
    const seen = [];
    const r = await runPerDateSync(["d1", "d2", "d3"], async (d) => {
      seen.push(d);
      if (d === "d2") throw new Error("boom d2");
      return 1;
    });
    // All three attempted despite d2 throwing.
    assert.deepStrictEqual(seen, ["d1", "d2", "d3"]);
    assert.strictEqual(r.pushes, 2); // d1 + d3 pushed
    assert.strictEqual(r.errors.length, 1);
    assert.strictEqual(r.errors[0].date, "d2");
    assert.match(r.errors[0].msg, /boom d2/);
  });

  await test("runPerDateSync — a later success never hides an earlier failure", async () => {
    const r = await runPerDateSync(["d1", "d2"], async (d) => {
      if (d === "d1") throw new Error("early fail");
      return 5;
    });
    assert.strictEqual(r.pushes, 5); // d2 succeeded
    assert.strictEqual(r.errors.length, 1); // d1 error preserved
    assert.strictEqual(r.errors[0].date, "d1");
  });

  await test("runPerDateSync handles a non-array safely", async () => {
    const r = await runPerDateSync(null, async () => 1);
    assert.deepStrictEqual(r, { pushes: 0, errors: [], datesRun: [] });
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
