/**
 * F3 — the runtime branches must OBEY the sync-path selection.
 *
 * The selector already returned mysql/rest/none correctly, but the two call
 * sites implemented it as a two-way branch: every non-mysql result, including
 * `none`, invoked the REST sync. The scheduled branch additionally chose its
 * sync function ONCE at startup and reused it for every 15-minute tick, so a
 * MySQL that died after the first probe never failed over, and one that
 * recovered was never picked up again without a restart.
 *
 * These tests drive the real `runSelectedSync` source with injected
 * dependencies and assert which sync function actually ran — not that a
 * selector returns the right string, and not that a log line exists.
 *
 * No OD connection, no network, no PHI.
 *
 * Run: node test/sync-path-runtime.test.js (from electron-app/)
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

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

console.log("\nF3 — sync-path selection is obeyed at runtime\n");

const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

// The real selection/dispatch block, lifted verbatim. Everything it reaches for
// is passed in, so this exercises the shipping logic rather than a copy of it.
const selectionBlock = mainSrc.slice(
  mainSrc.indexOf("function selectSyncPath("),
  mainSrc.indexOf("function odBalanceToCents("),
);

/**
 * One harness run. `probeResults` is consumed one value per sync call, so a
 * single harness can model a database that goes away and comes back.
 */
function makeRuntime({ probeResults, hasRestConfig }) {
  const ran = [];
  const logs = [];
  const probes = [...probeResults];
  const factory = new Function(
    "deps",
    `
    const { log, config, recheckMysqlAvailability, syncODMySql, syncODData } = deps;
    ${selectionBlock}
    return { runSelectedSync, SYNC_METHOD_BY_PATH, selectSyncPath };
    `,
  );
  return {
    ran,
    logs,
    ...factory({
      log: (m) => logs.push(m),
      config: { od_api_url: hasRestConfig ? "https://od.example" : null },
      recheckMysqlAvailability: async () => {
        if (probes.length === 0) throw new Error("probe called too many times");
        return probes.shift();
      },
      syncODMySql: async () => {
        ran.push("mysql");
      },
      syncODData: async () => {
        ran.push("rest");
      },
    }),
  };
}

(async () => {
  // ── Three-way dispatch ────────────────────────────────────────────────────

  await test("a healthy MySQL runs the MySQL sync", async () => {
    const rt = makeRuntime({ probeResults: [true], hasRestConfig: true });
    await rt.runSelectedSync(null, "test");
    assert.deepStrictEqual(rt.ran, ["mysql"]);
  });

  await test("an unavailable MySQL falls back to the REST sync", async () => {
    const rt = makeRuntime({ probeResults: [false], hasRestConfig: true });
    await rt.runSelectedSync(null, "test");
    assert.deepStrictEqual(rt.ran, ["rest"]);
  });

  await test("`none` runs NO sync at all", async () => {
    // The defect: this case used to call syncODData(), so an office with
    // nothing configured silently exercised the legacy path.
    const rt = makeRuntime({ probeResults: [false], hasRestConfig: false });
    await rt.runSelectedSync(null, "test");
    assert.deepStrictEqual(rt.ran, []);
  });

  await test("`none` still emits exactly one non-PHI line saying so", async () => {
    const rt = makeRuntime({ probeResults: [false], hasRestConfig: false });
    await rt.runSelectedSync(null, "startup");
    assert.deepStrictEqual(rt.logs, [
      "[OD Sync] sync_path=none reason=no_mysql_no_rest_config context=startup",
    ]);
  });

  await test("the reported sync_method is the path actually taken", async () => {
    const rt = makeRuntime({ probeResults: [false], hasRestConfig: true });
    const selection = await rt.runSelectedSync(null, "sync_od_now");
    assert.strictEqual(rt.SYNC_METHOD_BY_PATH[selection.path], "od_rest_api");
  });

  await test("a `none` run reports none, not a sync method it never used", async () => {
    const rt = makeRuntime({ probeResults: [false], hasRestConfig: false });
    const selection = await rt.runSelectedSync(null, "sync_od_now");
    assert.strictEqual(rt.SYNC_METHOD_BY_PATH[selection.path], "none");
  });

  // ── Per-run re-evaluation: failover and recovery ──────────────────────────

  await test("MySQL failing after a healthy start fails over on the next run", async () => {
    const rt = makeRuntime({
      probeResults: [true, false],
      hasRestConfig: true,
    });
    await rt.runSelectedSync(null, "startup");
    await rt.runSelectedSync(null, "scheduled");
    assert.deepStrictEqual(rt.ran, ["mysql", "rest"]);
  });

  await test("MySQL recovering after a failed start returns to MySQL", async () => {
    const rt = makeRuntime({
      probeResults: [false, true],
      hasRestConfig: true,
    });
    await rt.runSelectedSync(null, "startup");
    await rt.runSelectedSync(null, "scheduled");
    assert.deepStrictEqual(rt.ran, ["rest", "mysql"]);
  });

  await test("availability is probed once per run, never captured once", async () => {
    const rt = makeRuntime({
      probeResults: [true, true, true],
      hasRestConfig: true,
    });
    await rt.runSelectedSync(null, "startup");
    await rt.runSelectedSync(null, "scheduled");
    await rt.runSelectedSync(null, "scheduled");
    // A fourth call would exhaust the probe queue and throw; three runs
    // consuming exactly three probes is the assertion.
    assert.deepStrictEqual(rt.ran, ["mysql", "mysql", "mysql"]);
  });

  await test("a flapping database is followed run by run", async () => {
    const rt = makeRuntime({
      probeResults: [true, false, true, false],
      hasRestConfig: true,
    });
    for (const ctx of ["startup", "scheduled", "scheduled", "scheduled"]) {
      await rt.runSelectedSync(null, ctx);
    }
    assert.deepStrictEqual(rt.ran, ["mysql", "rest", "mysql", "rest"]);
  });

  await test("each run logs its own selection line", async () => {
    const rt = makeRuntime({
      probeResults: [true, false],
      hasRestConfig: true,
    });
    await rt.runSelectedSync(null, "startup");
    await rt.runSelectedSync(null, "scheduled");
    assert.deepStrictEqual(rt.logs, [
      "[OD Sync] sync_path=mysql reason=mysql_healthy_preferred context=startup",
      "[OD Sync] sync_path=rest reason=mysql_unavailable_rest_fallback context=scheduled",
    ]);
  });

  await test("a probe that throws degrades to unavailable, not to a crash", async () => {
    const rt = makeRuntime({ probeResults: [], hasRestConfig: true });
    await rt.runSelectedSync(null, "scheduled");
    assert.deepStrictEqual(rt.ran, ["rest"]);
  });

  // ── The scheduled branch wiring ───────────────────────────────────────────

  await test("the interval calls the selector-driven runner, not a captured function", () => {
    // The old shape chose once and reused it forever; if it comes back, the
    // failover tests above would still pass while the shipping agent did not.
    assert.ok(
      !/const run = selection\.path === "mysql"/.test(mainSrc),
      "the startup branch still captures one sync function",
    );
    assert.ok(mainSrc.includes('runSelectedSync(null, "scheduled")'));
    assert.ok(mainSrc.includes('runSelectedSync(null, "startup")'));
  });

  await test("both call sites route through the one runner", () => {
    const calls = mainSrc.match(/runSelectedSync\(/g) ?? [];
    // definition + startup + scheduled + on-demand
    assert.strictEqual(calls.length, 4);
  });

  await test("the on-demand command result no longer derives its method from the probe", () => {
    assert.ok(
      !/sync_method: mysqlOk \?/.test(mainSrc),
      "sync_method is still derived from the availability boolean",
    );
    assert.ok(
      mainSrc.includes("sync_method: SYNC_METHOD_BY_PATH[selection.path]"),
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
