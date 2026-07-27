/**
 * F1 — OD date/time values must reach the backend as WALL-CLOCK strings.
 *
 * The defect: mysql2 inflates DATE/DATETIME columns into JavaScript Date
 * objects bound to the connection's timezone. JSON.stringify then serializes
 * that Date as a zoned UTC string, and the backend — which correctly reads an
 * OD value as office-local wall time — applies the office offset a second time.
 * A Denver 09:15 arrival lands at 21:15Z and the card's waiting timer lies.
 *
 * This half of the contract proves the agent never puts a zoned value on the
 * wire. The backend half (agentext-datetime-wire.spec.ts) proves a value with
 * no zone designator converts exactly once. The two compose: this file asserts
 * what the frame carries, that file asserts what the frame means.
 *
 * Fake pool, no mysql2, no OD connection, no network, no PHI.
 *
 * Run: node test/mysql-datetime-wire.test.js (from electron-app/)
 */

const assert = require("assert");
const Module = require("module");

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((e) => {
      console.error(`  ✗ ${name}: ${e.message}`);
      failed++;
    });
}

console.log("\nF1 — OD datetime wall-clock contract on the wire\n");

let activePool = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "mysql2/promise") {
    return { createPool: () => activePool };
  }
  return realLoad.apply(this, arguments);
};

function loadOdMysqlWith(queryImpl) {
  const calls = [];
  activePool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return queryImpl(sql, params);
    },
    getConnection: async () => ({
      query: async () => [[{ ok: 1 }]],
      release: () => {},
    }),
    end: async () => {},
  };
  const modPath = require.resolve("../od-mysql.js");
  delete require.cache[modPath];
  const od = require(modPath);
  od.setLogger(() => {});
  od.setManualMysqlConfig({
    host: "127.0.0.1",
    database: "opendental",
    user: "u",
    password: "p",
  });
  return { od, calls };
}

const ALL_EXT = [
  "appointment.Confirmed",
  "appointment.DateTimeArrived",
  "appointment.DateTimeSeated",
  "appointment.DateTimeDismissed",
  "appointment.IsNewPatient",
  "appointment.IsHygiene",
  "patient.Premed",
  "patient.MedUrgNote",
  "patient.Preferred",
  "patient.BalTotal",
  "provider.ProvColor",
];

function schemaRows(present) {
  return present.map((full) => {
    const [TABLE_NAME, COLUMN_NAME] = full.split(".");
    return { TABLE_NAME, COLUMN_NAME };
  });
}

/** The appointment SELECT the agent actually issued. */
async function captureAppointmentSql(present = ALL_EXT) {
  const { od, calls } = loadOdMysqlWith((sql) => {
    if (sql.includes("information_schema")) return [schemaRows(present)];
    return [[]];
  });
  await od.getAppointmentsForDate("2026-07-27");
  const call = calls.find((c) => c.sql.includes("FROM appointment a"));
  assert.ok(call, "no appointment query was issued");
  return call.sql;
}

(async () => {
  // ── The SELECT formats the wire-bound date columns ────────────────────────

  await test("AptDateTime leaves the database already formatted as wall clock", async () => {
    const sql = await captureAppointmentSql();
    assert.ok(
      sql.includes("DATE_FORMAT(a.AptDateTime, '%Y-%m-%d %H:%i:%s')"),
      "AptDateTime is not formatted — the driver would parse it into a Date",
    );
  });

  await test("the formatted AptDateTime keeps its original column name", async () => {
    // The frame and every downstream reader index by AptDateTime; an alias
    // change would silently blank the appointment time rather than shift it.
    const sql = await captureAppointmentSql();
    assert.ok(sql.includes("') AS AptDateTime"));
  });

  await test("Birthdate is formatted as a date with no clock fields", async () => {
    const sql = await captureAppointmentSql();
    assert.ok(
      sql.includes("DATE_FORMAT(p.Birthdate, '%Y-%m-%d') AS Birthdate"),
    );
  });

  await test("all three AGENT-EXT event times are formatted", async () => {
    const sql = await captureAppointmentSql();
    const formatted = [
      "DateTimeArrived",
      "DateTimeSeated",
      "DateTimeDismissed",
    ].filter((c) =>
      sql.includes(`DATE_FORMAT(a.${c}, '%Y-%m-%d %H:%i:%s') AS ${c}`),
    );
    assert.deepStrictEqual(formatted, [
      "DateTimeArrived",
      "DateTimeSeated",
      "DateTimeDismissed",
    ]);
  });

  await test("no raw datetime column is left in the select list", async () => {
    // A bare `a.DateTimeSeated` anywhere in the projection means that column
    // still reaches the driver's date parser.
    const sql = await captureAppointmentSql();
    const projection = sql.slice(0, sql.indexOf("FROM appointment a"));
    for (const c of [
      "AptDateTime",
      "Birthdate",
      "DateTimeArrived",
      "DateTimeSeated",
      "DateTimeDismissed",
    ]) {
      assert.ok(
        !new RegExp(`(?<!DATE_FORMAT\\()[ap]\\.${c}\\b`).test(projection),
        `${c} appears unformatted in the projection`,
      );
    }
  });

  await test("filtering and ordering still use the real column, not the alias", async () => {
    // DATE_FORMAT in the projection must not turn the day filter or the sort
    // into a string comparison against a formatted value.
    const sql = await captureAppointmentSql();
    assert.ok(sql.includes("WHERE DATE(a.AptDateTime) = ?"));
    assert.ok(sql.trimEnd().endsWith("ORDER BY a.AptDateTime"));
  });

  await test("a column this Open Dental lacks is still simply absent", async () => {
    // The formatting must not defeat the per-column probe: an OD without
    // DateTimeSeated must not have it appear formatted-but-missing.
    const sql = await captureAppointmentSql(
      ALL_EXT.filter((c) => c !== "appointment.DateTimeSeated"),
    );
    assert.ok(!sql.includes("DateTimeSeated"));
  });

  await test("non-datetime AGENT-EXT columns are untouched", async () => {
    const sql = await captureAppointmentSql();
    assert.ok(sql.includes("a.Confirmed"));
    assert.ok(!sql.includes("DATE_FORMAT(a.Confirmed"));
  });

  // ── The fragment helper decides per column, not per table ─────────────────

  await test("agentExtSelectFragment formats exactly the datetime columns", () => {
    const { od } = loadOdMysqlWith(() => [[]]);
    const fragment = od.agentExtSelectFragment({
      appointment: ["Confirmed", "DateTimeArrived", "IsHygiene"],
      patient: ["Premed"],
      provider: ["ProvColor"],
    });
    const wrapped = (fragment.match(/DATE_FORMAT\(/g) ?? []).length;
    assert.strictEqual(wrapped, 1);
  });

  await test("the datetime column set is exactly the three OD event times", () => {
    const { od } = loadOdMysqlWith(() => [[]]);
    assert.deepStrictEqual([...od.AGENT_EXT_DATETIME_COLUMNS].sort(), [
      "DateTimeArrived",
      "DateTimeDismissed",
      "DateTimeSeated",
    ]);
  });

  // ── What survives JSON.stringify — the actual wire step ───────────────────

  await test("a wall-clock string crosses the wire with no zone designator", () => {
    // This is the contract the backend's wall-time branch depends on. If a
    // zone ever appears here, the backend is entitled to treat the value as an
    // instant and the office offset is never applied.
    const wire = JSON.parse(
      JSON.stringify({ arrived_at: "2026-07-27 09:15:00" }),
    );
    assert.strictEqual(wire.arrived_at, "2026-07-27 09:15:00");
  });

  await test("the pre-fix Date shape is what introduced the zone", () => {
    // Negative control: without the SQL formatting the driver hands back a
    // Date, and JSON.stringify converts it to a zoned UTC string — the exact
    // value the backend then shifted a second time.
    const driverDate = new Date("2026-07-27T15:15:00.000Z");
    const wire = JSON.parse(JSON.stringify({ arrived_at: driverDate }));
    assert.ok(/Z$/.test(wire.arrived_at));
  });

  await test("a formatted zero-date stays the sentinel the backend rejects", () => {
    // OD writes 0001-01-01 for "never happened". DATE_FORMAT preserves it, so
    // the backend's sentinel check still sees it rather than a driver's
    // Invalid Date or a silently shifted year-1 instant.
    const wire = JSON.parse(
      JSON.stringify({ seated_at: "0001-01-01 00:00:00" }),
    );
    assert.ok(wire.seated_at.startsWith("0001-01-01"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
