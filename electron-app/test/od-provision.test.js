/**
 * od-provision pure-helper tests (discovery parsing + my.ini transforms + SQL/pw).
 * Run: node test/od-provision.test.js
 */
const assert = require("assert");
const p = require("../lib/od-provision");

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

const SC_QUERY = `
SERVICE_NAME: Themes
        STATE              : 4  RUNNING
SERVICE_NAME: MySQL
        STATE              : 4  RUNNING
SERVICE_NAME: MSSQL$OLD
        STATE              : 1  STOPPED
`;

test("parseDbServices returns only mysql/maria services with running state", () => {
  const r = p.parseDbServices(SC_QUERY);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].name, "MySQL");
  assert.strictEqual(r[0].running, true);
});

test("parseDbServices marks a stopped MariaDB service not-running", () => {
  const r = p.parseDbServices("SERVICE_NAME: MariaDB\n  STATE : 1 STOPPED");
  assert.strictEqual(r[0].name, "MariaDB");
  assert.strictEqual(r[0].running, false);
});

test("parseDbServices returns [] when no DB service present", () => {
  assert.deepStrictEqual(
    p.parseDbServices("SERVICE_NAME: Spooler\n STATE: 4 RUNNING"),
    [],
  );
});

const SC_QC = `[SC] QueryServiceConfig SUCCESS
SERVICE_NAME: MySQL
        BINARY_PATH_NAME   : "C:\\Program Files\\MariaDB 10.11\\bin\\mysqld.exe" "--defaults-file=C:\\Program Files\\MariaDB 10.11\\my.ini" "MySQL"
        START_TYPE         : 2   AUTO_START`;

test("parseServicePaths extracts mysqld exe, bin dir, and my.ini (spaces in path)", () => {
  const r = p.parseServicePaths(SC_QC);
  assert.ok(/mysqld\.exe$/i.test(r.exePath), "exePath");
  assert.strictEqual(r.binDir, "C:\\Program Files\\MariaDB 10.11\\bin");
  assert.strictEqual(r.iniPath, "C:\\Program Files\\MariaDB 10.11\\my.ini");
});

test("injectInitFile inserts init_file directly under [mysqld]", () => {
  const ini = "[client]\nport=3306\n[mysqld]\ndatadir=C:/x\nport=3306\n";
  const { text, injected } = p.injectInitFile(
    ini,
    "C:/ProgramData/edifi-provision.sql",
  );
  assert.ok(injected);
  const lines = text.split(/\r?\n/);
  const i = lines.indexOf("[mysqld]");
  assert.strictEqual(
    lines[i + 1],
    'init_file="C:/ProgramData/edifi-provision.sql"',
  );
});

test("injectInitFile does not stack a second directive (strips existing first)", () => {
  const ini = '[mysqld]\ninit_file="C:/old.sql"\ndatadir=C:/x\n';
  const { text } = p.injectInitFile(ini, "C:/new.sql");
  assert.strictEqual((text.match(/init_file=/g) || []).length, 1);
  assert.ok(!text.includes("C:/old.sql"));
});

test("injectInitFile reports injected=false when no [mysqld] section", () => {
  assert.strictEqual(
    p.injectInitFile("[client]\nport=3306\n", "C:/x.sql").injected,
    false,
  );
});

test("hasInitFile detects an operator-managed init_file", () => {
  assert.strictEqual(p.hasInitFile("[mysqld]\ninit_file=C:/ops.sql\n"), true);
  assert.strictEqual(p.hasInitFile("[mysqld]\ndatadir=C:/x\n"), false);
});

test("removeInitFile strips the directive, leaving the rest intact", () => {
  const out = p.removeInitFile(
    '[mysqld]\ninit_file="C:/x.sql"\ndatadir=C:/x\n',
  );
  assert.ok(!/init[_-]file/i.test(out));
  assert.ok(out.includes("datadir=C:/x"));
});

test("assertSafeDbName accepts a normal identifier and rejects injection", () => {
  assert.strictEqual(p.assertSafeDbName("opendental"), "opendental");
  assert.throws(() => p.assertSafeDbName("od`; DROP USER root; --"), /unsafe/);
  assert.throws(() => p.assertSafeDbName(""), /unsafe/);
});

test("buildInitSql DROP+CREATEs edifi_ro, grants SELECT only, never touches root", () => {
  const sql = p.buildInitSql("opendental", "PW123");
  assert.ok(sql.includes("DROP USER IF EXISTS 'edifi_ro'@'localhost'"));
  assert.ok(
    sql.includes("CREATE USER 'edifi_ro'@'127.0.0.1' IDENTIFIED BY 'PW123'"),
  );
  assert.ok(
    sql.includes("GRANT SELECT ON `opendental`.* TO 'edifi_ro'@'localhost'"),
  );
  assert.ok(!/root/i.test(sql), "must not touch root");
  assert.ok(!/GRANT ALL/i.test(sql), "read-only only");
});

test("buildInitSql throws on an unsafe db name (no injection route)", () => {
  assert.throws(() => p.buildInitSql("od`; DROP", "PW"), /unsafe/);
});

test("generatePassword yields a safe alphanumeric password (no quotes/metachars)", () => {
  let i = 0;
  const rb = (n) =>
    Buffer.from(Array.from({ length: n }, () => (i++ * 7) % 256));
  const pw = p.generatePassword(rb);
  assert.ok(pw.length >= 24);
  assert.ok(/^[A-Za-z0-9]+$/.test(pw), "alphanumeric only");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
