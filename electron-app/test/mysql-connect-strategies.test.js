/**
 * buildConnectStrategies tests — the ordered connection attempts getPool tries.
 * Run: node test/mysql-connect-strategies.test.js
 */
const assert = require("assert");
const { buildConnectStrategies } = require("../od-mysql");

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

const cfg = (over = {}) => ({
  host: "localhost",
  port: 3306,
  database: "opendental",
  user: "root",
  password: "pw",
  ...over,
});

test("localhost maps first strategy to IPv4 127.0.0.1 (avoids ::1)", () => {
  const s = buildConnectStrategies(cfg());
  assert.strictEqual(s[0].label, "tcp:127.0.0.1");
  assert.strictEqual(s[0].opts.host, "127.0.0.1");
  assert.strictEqual(s[0].opts.port, 3306);
});

test("named pipe is always the final fallback", () => {
  const s = buildConnectStrategies(cfg());
  const last = s[s.length - 1];
  assert.strictEqual(last.label, "pipe");
  assert.strictEqual(last.opts.socketPath, "\\\\.\\pipe\\MySQL");
  assert.strictEqual(last.opts.host, undefined);
});

test("localhost yields exactly two strategies (ipv4 + pipe), no duplicate host", () => {
  const s = buildConnectStrategies(cfg());
  assert.strictEqual(s.length, 2);
  assert.deepStrictEqual(
    s.map((x) => x.label),
    ["tcp:127.0.0.1", "pipe"],
  );
});

test("a remote host is TCP-only — no local named-pipe fallback", () => {
  const s = buildConnectStrategies(cfg({ host: "192.168.68.56" }));
  assert.deepStrictEqual(
    s.map((x) => x.label),
    ["tcp:192.168.68.56"],
  );
  assert.strictEqual(s[0].opts.host, "192.168.68.56");
  assert.ok(
    !s.some((x) => x.opts.socketPath),
    "remote host must not use a pipe",
  );
});

test("127.0.0.1 host still gets the local pipe fallback", () => {
  const s = buildConnectStrategies(cfg({ host: "127.0.0.1" }));
  assert.deepStrictEqual(
    s.map((x) => x.label),
    ["tcp:127.0.0.1", "pipe"],
  );
});

test("every strategy carries the credentials and db", () => {
  for (const s of buildConnectStrategies(cfg())) {
    assert.strictEqual(s.opts.user, "root");
    assert.strictEqual(s.opts.password, "pw");
    assert.strictEqual(s.opts.database, "opendental");
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
