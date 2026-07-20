/**
 * setManualMysqlConfig / clearManualMysqlConfig tests.
 * Verifies a failed SET_MYSQL_CONFIG can be rolled back to file-scan config
 * when there was no prior override (the null-prior case).
 * Run: node test/mysql-manual-config.test.js
 */

const assert = require("assert");
const odMysql = require("../od-mysql");

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const cfg = {
  host: "127.0.0.1",
  port: 3306,
  database: "opendental",
  user: "root",
  password: "pw",
};

test("readOdConfig returns the manual override once set", async () => {
  odMysql.setManualMysqlConfig(cfg);
  const c = await odMysql.readOdConfig();
  assert.strictEqual(c.host, "127.0.0.1");
  assert.strictEqual(c.configPath, "manual");
});

test("clearManualMysqlConfig removes the manual override", async () => {
  odMysql.setManualMysqlConfig(cfg);
  odMysql.clearManualMysqlConfig();
  const c = await odMysql.readOdConfig();
  // override gone → readOdConfig no longer reports the manual sentinel
  assert.ok(!c || c.configPath !== "manual", "override still present");
});

test("setManualMysqlConfig ignores an incomplete config", async () => {
  odMysql.clearManualMysqlConfig();
  odMysql.setManualMysqlConfig({ host: "h" });
  const c = await odMysql.readOdConfig();
  assert.ok(!c || c.configPath !== "manual", "incomplete config was accepted");
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}: ${e.message}`);
      failed++;
    } finally {
      odMysql.clearManualMysqlConfig();
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
