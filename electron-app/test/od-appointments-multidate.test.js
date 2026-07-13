/**
 * getAppointmentsForDates — multi-date query behavior against a mocked pool.
 * Verifies parameterized IN-list, date de-duplication, empty/non-array safety,
 * and that the returned row shape is passed straight through from the driver.
 * Run: node test/od-appointments-multidate.test.js
 */

const assert = require("assert");
const Module = require("module");

// ─── Mock mysql2/promise before od-mysql lazily requires it inside getPool ───
let lastQuery = null;
const fakeRows = [
  {
    AptNum: 1,
    PatNum: 10,
    AptDateTime: new Date("2026-07-13T15:00:00.000Z"),
    FName: "Ada",
    LName: "Lovelace",
    Birthdate: "1990-01-01",
    HmPhone: "",
    WkPhone: "",
    Email: "",
  },
];
const fakeConn = { query: async () => [[{ 1: 1 }]], release() {} };
let queryShouldThrow = false;
const fakePool = {
  getConnection: async () => fakeConn,
  query: async (sql, params) => {
    if (queryShouldThrow) throw new Error("ECONNREFUSED simulated DB failure");
    lastQuery = { sql, params };
    return [fakeRows];
  },
};
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "mysql2/promise") return { createPool: () => fakePool };
  return origRequire.apply(this, arguments);
};

const odMysql = require("../od-mysql");
odMysql.setLogger(() => {}); // silence
// Manual config → readOdConfig skips the file scan and uses these creds.
odMysql.setManualMysqlConfig({
  host: "localhost",
  port: 3306,
  database: "opendental",
  user: "root",
  password: "x",
});

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

(async () => {
  await test("de-duplicates dates and binds a single parameterized IN-list", async () => {
    lastQuery = null;
    const rows = await odMysql.getAppointmentsForDates([
      "2026-07-13",
      "2026-07-14",
      "2026-07-13", // duplicate collapses
    ]);
    assert.ok(lastQuery, "pool.query should have been called");
    assert.match(lastQuery.sql, /DATE\(a\.AptDateTime\) IN \(\?\)/);
    // Single ? placeholder, bound to the unique date array (mysql2 expands it).
    assert.deepStrictEqual(lastQuery.params, [["2026-07-13", "2026-07-14"]]);
    assert.strictEqual(rows, fakeRows);
  });

  await test("single date still binds an array (parity with getAppointmentsForDate)", async () => {
    lastQuery = null;
    await odMysql.getAppointmentsForDates(["2026-07-13"]);
    assert.deepStrictEqual(lastQuery.params, [["2026-07-13"]]);
  });

  await test("row shape matches getAppointmentsForDate columns", async () => {
    lastQuery = null;
    await odMysql.getAppointmentsForDates(["2026-07-13"]);
    // Same SELECT list, minus nothing added (no apt_date column).
    assert.match(lastQuery.sql, /a\.AptNum, a\.PatNum, a\.AptDateTime/);
    assert.ok(
      !/apt_date/.test(lastQuery.sql),
      "must not add an apt_date column",
    );
    assert.match(lastQuery.sql, /a\.AptStatus IN \(1, 2\)/);
  });

  await test("empty list returns [] without querying", async () => {
    lastQuery = null;
    const rows = await odMysql.getAppointmentsForDates([]);
    assert.deepStrictEqual(rows, []);
    assert.strictEqual(
      lastQuery,
      null,
      "pool.query must not run for empty input",
    );
  });

  await test("non-array input returns [] safely", async () => {
    lastQuery = null;
    assert.deepStrictEqual(await odMysql.getAppointmentsForDates(null), []);
    assert.deepStrictEqual(
      await odMysql.getAppointmentsForDates("2026-07-13"),
      [],
    );
    assert.strictEqual(lastQuery, null);
  });

  await test("filters out non-string / empty date entries", async () => {
    lastQuery = null;
    await odMysql.getAppointmentsForDates(["2026-07-13", "", null, 20260714]);
    assert.deepStrictEqual(lastQuery.params, [["2026-07-13"]]);
  });

  await test("DB/query failure THROWS instead of returning [] (no silent empty day)", async () => {
    queryShouldThrow = true;
    await assert.rejects(
      () => odMysql.getAppointmentsForDates(["2026-07-14"]),
      /simulated DB failure/,
    );
    queryShouldThrow = false;
  });

  await test("SELECT carries SQL-derived apt_local_date for safe grouping", async () => {
    lastQuery = null;
    await odMysql.getAppointmentsForDates(["2026-07-14"]);
    assert.match(
      lastQuery.sql,
      /DATE_FORMAT\(a\.AptDateTime, '%Y-%m-%d'\) AS apt_local_date/,
    );
  });

  Module.prototype.require = origRequire; // restore
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
