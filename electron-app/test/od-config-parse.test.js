/**
 * FreeDentalConfig.xml parse tests (USE_OD_CONFIG self-provision).
 * Pure function, synthetic XML, no I/O.
 * Run: node test/od-config-parse.test.js
 */

const assert = require("assert");
const { parseOdConfigXml } = require("../lib/od-config-parse");

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

// Realistic FreeDentalConfig with an obfuscated (odv2) hash — matches the live
// All Smiles copy shape verified 2026-07-20 (host localhost, db opendental, user root).
const HASHED = `<?xml version="1.0"?>
<ConnectionSettings>
  <DatabaseConnection>
    <ComputerName>localhost</ComputerName>
    <DatabasePort>3306</DatabasePort>
    <Database>opendental</Database>
    <User>root</User>
    <MySQLPassHash>odv2e$qRfnAJj6gT/SipJo/dMYTw==</MySQLPassHash>
  </DatabaseConnection>
</ConnectionSettings>`;

const PLAINTEXT = `<ConnectionSettings>
  <Server>db.local</Server>
  <Database>od</Database>
  <DatabaseUser>edifi</DatabaseUser>
  <Password>plainpw123</Password>
</ConnectionSettings>`;

test("extracts host from ComputerName", () => {
  assert.strictEqual(parseOdConfigXml(HASHED).host, "localhost");
});

test("extracts database and user", () => {
  const f = parseOdConfigXml(HASHED);
  assert.strictEqual(f.database, "opendental");
  assert.strictEqual(f.user, "root");
});

test("extracts obfuscated passHash including odv2 prefix", () => {
  assert.strictEqual(
    parseOdConfigXml(HASHED).passHash,
    "odv2e$qRfnAJj6gT/SipJo/dMYTw==",
  );
});

test("hashed config yields empty plaintext (caller branches on hash)", () => {
  assert.strictEqual(parseOdConfigXml(HASHED).plaintext, "");
});

test("plaintext config yields plaintext and empty hash", () => {
  const f = parseOdConfigXml(PLAINTEXT);
  assert.strictEqual(f.plaintext, "plainpw123");
  assert.strictEqual(f.passHash, "");
});

test("host tag aliases resolve (Server)", () => {
  assert.strictEqual(parseOdConfigXml(PLAINTEXT).host, "db.local");
});

test("tag matching is case-insensitive", () => {
  const xml = "<x><database>MixedCaseDb</database></x>";
  assert.strictEqual(parseOdConfigXml(xml).database, "MixedCaseDb");
});

test("port defaults to 3306 when absent", () => {
  assert.strictEqual(parseOdConfigXml("<x></x>").port, "3306");
});

test("missing fields are null (host) without throwing", () => {
  const f = parseOdConfigXml("<x></x>");
  assert.strictEqual(f.host, null);
  assert.strictEqual(f.database, null);
});

test("decodes XML entities in a plaintext password", () => {
  const xml =
    "<DatabaseConnection><Password>a&amp;b&lt;c&gt;&quot;</Password></DatabaseConnection>";
  assert.strictEqual(parseOdConfigXml(xml).plaintext, 'a&b<c>"');
});

test("preserves whitespace inside a plaintext password", () => {
  const xml =
    "<DatabaseConnection><Password> pw </Password></DatabaseConnection>";
  assert.strictEqual(parseOdConfigXml(xml).plaintext, " pw ");
});

test("ignores commented-out tags", () => {
  const xml =
    "<DatabaseConnection><!-- <Database>stale</Database> --><Database>live</Database></DatabaseConnection>";
  assert.strictEqual(parseOdConfigXml(xml).database, "live");
});

test("scopes to DatabaseConnection, ignoring other sections", () => {
  const xml =
    "<ServerConnection><User>webuser</User></ServerConnection>" +
    "<DatabaseConnection><User>root</User></DatabaseConnection>";
  assert.strictEqual(parseOdConfigXml(xml).user, "root");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
