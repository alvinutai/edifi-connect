/**
 * AGENT-EXT converge — Codex F2 (capability-cache lifecycle) and F3 (sync-path
 * selection, Fable ruling R2), plus the balance-source honesty conditional.
 *
 * The probe is driven through a mocked pool, so this is behavior, not a
 * source-text assertion. No OD connection, no network, no PHI.
 *
 * Run: node test/agentext-lifecycle.test.js (from electron-app/)
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
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

console.log("\nAGENT-EXT capability lifecycle + sync path (converge)\n");

// ── Loading od-mysql with a stubbed mysql2 so getPool() yields our fake ───────

// getPool() requires mysql2 lazily, at call time — so the stub has to stay
// installed for the whole run, not just across the require().
let activePool = null;
const realLoad = Module._load;
Module._load = function (request) {
  if (request === "mysql2/promise") {
    return { createPool: () => activePool };
  }
  return realLoad.apply(this, arguments);
};

// `connectionImpl` overrides what a borrowed connection does; the default is a
// healthy `SELECT 1`, which is what every pre-F3 test in this file assumes.
function loadOdMysqlWith(queryImpl, connectionImpl) {
  const calls = [];
  const fakePool = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return queryImpl(sql, params);
    },
    getConnection: async () => ({
      query: async () => {
        if (connectionImpl) return connectionImpl();
        return [[{ ok: 1 }]];
      },
      release: () => {},
    }),
    end: async () => {},
  };
  activePool = fakePool;
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
  return { od, calls, fakePool };
}

/** information_schema response for a given set of present columns. */
function schemaRows(present) {
  return present.map((full) => {
    const [TABLE_NAME, COLUMN_NAME] = full.split(".");
    return { TABLE_NAME, COLUMN_NAME };
  });
}

const SCHEMA_A = schemaRows([
  "appointment.Confirmed",
  "appointment.DateTimeArrived",
  "patient.Premed",
  "patient.BalTotal",
  "provider.ProvColor",
]);
const SCHEMA_B = schemaRows([
  "appointment.Confirmed",
  "patient.Premed",
  // no BalTotal, no ProvColor — the "database B" case
]);

(async () => {
  // ── F2: cache is bound to the connection, not the process ────────────────

  await test("probes once and caches for a stable target", async () => {
    let probes = 0;
    const { od } = loadOdMysqlWith((sql) => {
      if (/information_schema\.COLUMNS/.test(sql)) {
        probes++;
        return [SCHEMA_A];
      }
      return [[]];
    });
    await od.probeAgentExtColumns();
    await od.probeAgentExtColumns();
    assert.strictEqual(probes, 1, "second call should hit the cache");
  });

  await test("A→B schema change: setManualMysqlConfig re-probes", async () => {
    let current = SCHEMA_A;
    const { od } = loadOdMysqlWith((sql) => {
      if (/information_schema\.COLUMNS/.test(sql)) return [current];
      return [[]];
    });

    const a = await od.probeAgentExtColumns();
    assert.ok(a.patient.includes("BalTotal"), "A should expose BalTotal");

    // Switch to database B and re-point the agent at it.
    current = SCHEMA_B;
    od.setManualMysqlConfig({
      host: "127.0.0.1",
      database: "other",
      user: "u",
      password: "p",
    });

    const b = await od.probeAgentExtColumns();
    // The failure this prevents: still selecting p.BalTotal on a database that
    // does not have it makes the appointment SELECT throw and the board blank.
    assert.ok(!b.patient.includes("BalTotal"), "stale capability survived");
    assert.ok(!b.provider.includes("ProvColor"), "stale capability survived");
    assert.ok(b.patient.includes("Premed"), "B's real column should be kept");
  });

  await test("clearManualMysqlConfig also drops the capability cache", async () => {
    let current = SCHEMA_A;
    const { od } = loadOdMysqlWith((sql) => {
      if (/information_schema\.COLUMNS/.test(sql)) return [current];
      return [[]];
    });
    await od.probeAgentExtColumns();
    current = SCHEMA_B;
    od.clearManualMysqlConfig();
    od.setManualMysqlConfig({
      host: "127.0.0.1",
      database: "opendental",
      user: "u",
      password: "p",
    });
    const after = await od.probeAgentExtColumns();
    assert.ok(!after.patient.includes("BalTotal"));
  });

  await test("a transient probe failure is retried, not cached forever", async () => {
    let failNext = true;
    const { od } = loadOdMysqlWith((sql) => {
      if (/information_schema\.COLUMNS/.test(sql)) {
        if (failNext) {
          failNext = false;
          throw new Error("information_schema temporarily unavailable");
        }
        return [SCHEMA_A];
      }
      return [[]];
    });

    const first = await od.probeAgentExtColumns();
    assert.strictEqual(first.patient.length, 0, "failure degrades to none");

    // The database recovers. Caching the failure would have left this office
    // permanently board-less until the process restarted.
    const second = await od.probeAgentExtColumns();
    assert.ok(second.patient.includes("BalTotal"), "no retry after recovery");
  });

  await test("the SELECT fragment follows the re-probed capability", async () => {
    let current = SCHEMA_A;
    const { od } = loadOdMysqlWith((sql) => {
      if (/information_schema\.COLUMNS/.test(sql)) return [current];
      return [[]];
    });
    const a = od.agentExtSelectFragment(await od.probeAgentExtColumns());
    assert.ok(a.includes("p.BalTotal"));

    current = SCHEMA_B;
    od.setManualMysqlConfig({
      host: "127.0.0.1",
      database: "other",
      user: "u",
      password: "p",
    });
    const b = od.agentExtSelectFragment(await od.probeAgentExtColumns());
    assert.ok(!b.includes("BalTotal"));
  });

  // ── F3: availability must be answerable again, not cached true forever ────

  await test("isAvailable caches a healthy answer — recheck is why failover works", async () => {
    // Pinning the reason recheckAvailability exists. The 5-minute reset only
    // clears a FALSE, so once this returns true nothing re-tests it and a
    // database that dies is never noticed by isAvailable().
    let connects = 0;
    const { od } = loadOdMysqlWith(
      () => [[]],
      () => {
        connects++;
        return [[{ ok: 1 }]];
      },
    );
    await od.isAvailable();
    const before = connects;
    await od.isAvailable();
    assert.strictEqual(connects, before, "isAvailable re-probed unexpectedly");
  });

  await test("recheckAvailability asks the live pool every time", async () => {
    let connects = 0;
    const { od } = loadOdMysqlWith(
      () => [[]],
      () => {
        connects++;
        return [[{ ok: 1 }]];
      },
    );
    // Build the pool first — getPool()'s own SELECT 1 is not a recheck.
    await od.isAvailable();
    const base = connects;
    await od.recheckAvailability();
    await od.recheckAvailability();
    await od.recheckAvailability();
    assert.strictEqual(connects - base, 3);
  });

  await test("a database that dies after a healthy start is reported unavailable", async () => {
    let alive = true;
    const { od } = loadOdMysqlWith(
      () => [[]],
      () => {
        if (!alive)
          throw Object.assign(new Error("gone"), { code: "ECONNRESET" });
        return [[{ ok: 1 }]];
      },
    );
    assert.strictEqual(await od.recheckAvailability(), true);
    alive = false;
    assert.strictEqual(await od.recheckAvailability(), false);
  });

  await test("a recovered database is picked up without a restart", async () => {
    let alive = true;
    const { od } = loadOdMysqlWith(
      () => [[]],
      () => {
        if (!alive)
          throw Object.assign(new Error("gone"), { code: "ECONNRESET" });
        return [[{ ok: 1 }]];
      },
    );
    await od.recheckAvailability();
    alive = false;
    await od.recheckAvailability();
    alive = true;
    // Without the reset to "unknown" this would stay false until the 5-minute
    // timer, and the agent would keep syncing over REST in the meantime.
    assert.strictEqual(await od.recheckAvailability(), true);
  });

  await test("a failed liveness check drops the capability caches too", async () => {
    // The pool is rebuilt after a failure, so capabilities probed against the
    // old target must not survive — that is the blank-board failure mode.
    let alive = true;
    let current = SCHEMA_A;
    const { od } = loadOdMysqlWith(
      (sql) => {
        if (/information_schema\.COLUMNS/.test(sql)) return [current];
        return [[]];
      },
      () => {
        if (!alive) throw new Error("gone");
        return [[{ ok: 1 }]];
      },
    );
    const a = await od.probeAgentExtColumns();
    assert.ok(a.patient.includes("BalTotal"));

    alive = false;
    await od.recheckAvailability();
    alive = true;
    current = SCHEMA_B;

    const b = await od.probeAgentExtColumns();
    assert.ok(!b.patient.includes("BalTotal"), "stale capability survived");
  });

  // ── F3 / R2: sync-path selection ─────────────────────────────────────────

  const mainSrc = fs.readFileSync(
    path.join(__dirname, "..", "main.js"),
    "utf8",
  );
  const selectSyncPath = new Function(
    "sel",
    mainSrc.slice(
      mainSrc.indexOf("function selectSyncPath("),
      mainSrc.indexOf("/** One non-PHI line per selection"),
    ) + "\nreturn selectSyncPath(sel);",
  );

  await test("MySQL wins when healthy, even with REST configured", () => {
    // The design path. This is the case that was previously choosing REST on
    // the startup/interval branch and silently dropping every board field.
    assert.deepStrictEqual(
      selectSyncPath({ mysqlOk: true, hasRestConfig: true }),
      { path: "mysql", reason: "mysql_healthy_preferred" },
    );
  });

  await test("MySQL alone selects MySQL", () => {
    assert.deepStrictEqual(
      selectSyncPath({ mysqlOk: true, hasRestConfig: false }),
      { path: "mysql", reason: "mysql_only" },
    );
  });

  await test("REST is the fallback when MySQL is unavailable", () => {
    assert.deepStrictEqual(
      selectSyncPath({ mysqlOk: false, hasRestConfig: true }),
      { path: "rest", reason: "mysql_unavailable_rest_fallback" },
    );
  });

  await test("neither configured is reported, not silently treated as REST", () => {
    assert.deepStrictEqual(
      selectSyncPath({ mysqlOk: false, hasRestConfig: false }),
      { path: "none", reason: "no_mysql_no_rest_config" },
    );
  });

  await test("selection and dispatch happen in exactly one place", () => {
    // F3 rewrote this assertion. It used to require TWO selectSyncPath call
    // sites, which was the shape of the defect: two branches each deciding for
    // themselves what to do with the result, and disagreeing. Both sites now
    // route through runSelectedSync, so there is one selector call, one log
    // call, and one three-way branch. Runtime behavior — including that `none`
    // runs nothing — is asserted in sync-path-runtime.test.js.
    const uses = mainSrc.match(/= selectSyncPath\(\{/g) ?? [];
    assert.strictEqual(uses.length, 1, "expected one selection site");
    // The call, not the declaration.
    const logs = mainSrc.match(/logSyncPath\(selection, context\);/g) ?? [];
    assert.strictEqual(logs.length, 1);
    // The old REST-first branch must be gone.
    assert.ok(
      !/if \(config\.od_api_url\) \{\s*syncODData\(\);/.test(mainSrc),
      "startup still prefers REST",
    );
  });

  await test("the log line carries path and reason, and no PHI", () => {
    // The emitted template only — a wider window swallows the next function's
    // doc comment, which legitimately says "patient balance".
    const line = mainSrc
      .split(String.fromCharCode(10))
      .find((l) => l.includes("[OD Sync] sync_path="));
    assert.ok(line, "no sync_path log line found");
    assert.ok(line.includes("sync_path=${selection.path}"));
    assert.ok(line.includes("reason=${selection.reason}"));
    assert.ok(line.includes("context=${context}"));
    assert.ok(!/patient|PatNum|FName|LName|member/i.test(line));
  });

  // ── Balance source honesty (Codex conditional) ────────────────────────────

  const selectOdBalance = new Function(
    "row",
    mainSrc.slice(
      mainSrc.indexOf("function odBalanceToCents("),
      mainSrc.indexOf("// B-014 fix (2026-07-09)"),
    ) + "\nreturn selectOdBalance(row);",
  );

  await test("names the column that actually answered", () => {
    assert.deepStrictEqual(selectOdBalance({ BalTotal: 45 }), {
      balance_cents: 4500,
      balance_source: "BalTotal",
    });
  });

  await test("a blank primary falls through to a valid fallback", () => {
    // Previously "" parsed to 0 and claimed balance_source: "BalTotal",
    // shadowing a perfectly good EstBalance.
    assert.deepStrictEqual(
      selectOdBalance({ BalTotal: "  ", EstBalance: 12.5 }),
      {
        balance_cents: 1250,
        balance_source: "EstBalance",
      },
    );
  });

  await test("a real zero balance still wins over the fallback", () => {
    assert.deepStrictEqual(selectOdBalance({ BalTotal: 0, EstBalance: 99 }), {
      balance_cents: 0,
      balance_source: "BalTotal",
    });
  });

  await test("no usable column means no claim at all", () => {
    assert.deepStrictEqual(
      selectOdBalance({ BalTotal: "", EstBalance: "n/a" }),
      {
        balance_cents: null,
        balance_source: null,
      },
    );
    assert.deepStrictEqual(selectOdBalance({}), {
      balance_cents: null,
      balance_source: null,
    });
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
