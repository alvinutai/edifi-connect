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
SERVICE_NAME: MySQL
        DISPLAY_NAME: MySQL
SERVICE_NAME: W32Time
`;

test("parseDbServiceName finds the MySQL/MariaDB service", () => {
  assert.strictEqual(p.parseDbServiceName(SC_QUERY), "MySQL");
});

test("parseDbServiceName matches a MariaDB-named service", () => {
  assert.strictEqual(
    p.parseDbServiceName("SERVICE_NAME: MariaDB\nSERVICE_NAME: Spooler"),
    "MariaDB",
  );
});

test("parseDbServiceName returns null when none present", () => {
  assert.strictEqual(p.parseDbServiceName("SERVICE_NAME: Spooler"), null);
});

const SC_QC = `[SC] QueryServiceConfig SUCCESS
SERVICE_NAME: MySQL
        BINARY_PATH_NAME   : "C:\\Program Files\\MariaDB 10.11\\bin\\mysqld.exe" "--defaults-file=C:\\Program Files\\MariaDB 10.11\\my.ini" "MySQL"
        START_TYPE         : 2   AUTO_START`;

test("parseServicePaths extracts mysqld exe, bin dir, and my.ini", () => {
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
  assert.ok(text.includes('init_file="C:/new.sql"'));
  assert.ok(!text.includes("C:/old.sql"));
});

test("injectInitFile reports injected=false when no [mysqld] section", () => {
  const { injected } = p.injectInitFile("[client]\nport=3306\n", "C:/x.sql");
  assert.strictEqual(injected, false);
});

test("removeInitFile strips the directive, leaving the rest intact", () => {
  const ini = '[mysqld]\ninit_file="C:/x.sql"\ndatadir=C:/x\n';
  const out = p.removeInitFile(ini);
  assert.ok(!/init[_-]file/i.test(out));
  assert.ok(out.includes("datadir=C:/x"));
});

test("buildInitSql grants SELECT only, both host forms, never alters root", () => {
  const sql = p.buildInitSql("opendental", "PW123");
  assert.ok(sql.includes("CREATE USER IF NOT EXISTS 'edifi_ro'@'localhost'"));
  assert.ok(sql.includes("CREATE USER IF NOT EXISTS 'edifi_ro'@'127.0.0.1'"));
  assert.ok(
    sql.includes("GRANT SELECT ON `opendental`.* TO 'edifi_ro'@'localhost'"),
  );
  assert.ok(!/root/i.test(sql), "must not touch root");
  assert.ok(!/GRANT ALL/i.test(sql), "read-only only");
});

test("buildInitSql strips backticks from db name (no injection via db)", () => {
  const sql = p.buildInitSql("od`; DROP", "PW");
  assert.ok(!sql.includes("DROP TABLE"));
  assert.ok(sql.includes("`od; DROP`.*"));
});

test("generatePassword yields a safe ASCII password with no quotes/metachars", () => {
  let i = 0;
  const rb = (n) =>
    Buffer.from(Array.from({ length: n }, () => (i++ * 7) % 256));
  const pw = p.generatePassword(rb);
  assert.ok(pw.length >= 24);
  assert.ok(/^[A-Za-z0-9]+$/.test(pw), "alphanumeric only");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
