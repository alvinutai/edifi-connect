/**
 * F2-A — the raw OD EbenefitCat must survive serialization, ZERO included.
 *
 * `Number(x ?? 0) || null` turned a legitimate 0 into null on all three sender
 * surfaces. OD's 0 is "None" — the office assigned no category — so nulling it
 * made the backend read ABSENCE and fall back to the agent's own (misaligned)
 * category label. The backend's fail-closed rule was unreachable for exactly
 * the value it exists for, and a backend test that manufactured a numeric zero
 * after the wire boundary passed while no real sender could produce it.
 *
 * This runs the REAL mappers and asserts what survives JSON. The backend half
 * (agentext-ebenefitcat-composed.spec.ts) takes these same serialized values
 * into real persistence.
 *
 * No OD connection, no network, no PHI.
 *
 * Run: node test/ebenefitcat-wire.test.js (from electron-app/)
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { mapBenefits, odRawEbenefitCat } = require("../lib/benefit-mapper");
const { mapMysqlBenefits } = require("../od-mysql");

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

console.log("\nF2-A — raw EbenefitCat on the wire (all three senders)\n");

// The REST inline mapper, lifted from the shipping source so this exercises
// main.js's own copy rather than a stand-in.
const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const { resolveBenefitCategory } = require("../lib/benefit-category");
const mapOdApiBenefits = new Function(
  "deps",
  `
  const { log, odProcCodeCache, odCovCatCache, resolveBenefitCategory } = deps;
  ${mainSrc.slice(
    mainSrc.indexOf("function toFiniteNumberOrNull("),
    mainSrc.indexOf("async function syncODData("),
  )}
  return mapOdApiBenefits;
  `,
)({
  log: () => {},
  odProcCodeCache: null,
  odCovCatCache: null,
  resolveBenefitCategory,
});

/** What actually reaches the backend for a given OD EbenefitCat value. */
function overTheWire(entry) {
  return JSON.parse(JSON.stringify(entry)).ebenefitcat;
}

const mysqlRow = (EbenefitCat) => ({
  BenefitNum: 700,
  CovCatNum: 3,
  CodeNum: 0,
  BenefitType: 1,
  CoverageLevel: 1,
  Percent: "80",
  TimePeriod: 0,
  CategoryDesc: "Restorative",
  EbenefitCat,
  ProcCode: null,
});

const restRow = (EbenefitCat) => ({
  BenefitNum: 700,
  PlanNum: 1,
  PatPlanNum: 0,
  BenefitType: "CoInsurance",
  CovCatNum: 3,
  CoverageLevel: "Individual",
  Percent: 80,
  EbenefitCat,
});

// A row with no EbenefitCat key at all — the true-absence case.
function withoutEbenefitCat(row) {
  const copy = { ...row };
  delete copy.EbenefitCat;
  return copy;
}

// ── The MySQL path (the one ruling R2 prefers) ──────────────────────────────

test("MySQL: a real zero survives to the wire as zero", () => {
  // The whole defect in one assertion.
  const out = mapMysqlBenefits([mysqlRow(0)]);
  assert.strictEqual(overTheWire(out[0]), 0);
});

test("MySQL: a valid category survives unchanged", () => {
  const out = mapMysqlBenefits([mysqlRow(6)]);
  assert.strictEqual(overTheWire(out[0]), 6);
});

test("MySQL: true absence stays null", () => {
  const out = mapMysqlBenefits([withoutEbenefitCat(mysqlRow(0))]);
  assert.strictEqual(overTheWire(out[0]), null);
});

test("MySQL: an explicit null stays null", () => {
  const out = mapMysqlBenefits([mysqlRow(null)]);
  assert.strictEqual(overTheWire(out[0]), null);
});

test("MySQL: a malformed value stays PRESENT so the backend can fail closed", () => {
  // Nulling this would be indistinguishable from absence, and absence is the
  // one case allowed to use the agent's category.
  const out = mapMysqlBenefits([mysqlRow("PERIO")]);
  assert.strictEqual(overTheWire(out[0]), "PERIO");
});

test("MySQL: a blank string is absence, not a malformed value", () => {
  const out = mapMysqlBenefits([mysqlRow("   ")]);
  assert.strictEqual(overTheWire(out[0]), null);
});

test("MySQL: a numeric string normalizes to a number", () => {
  const out = mapMysqlBenefits([mysqlRow("6")]);
  assert.strictEqual(overTheWire(out[0]), 6);
});

// ── The shared library mapper ───────────────────────────────────────────────

test("shared mapper: a real zero survives to the wire as zero", () => {
  const out = mapBenefits([restRow(0)], {}, null);
  assert.strictEqual(overTheWire(out[0]), 0);
});

test("shared mapper: true absence stays null", () => {
  const out = mapBenefits([withoutEbenefitCat(restRow(0))], {}, null);
  assert.strictEqual(overTheWire(out[0]), null);
});

test("shared mapper: a malformed value stays present", () => {
  const out = mapBenefits([restRow("PERIO")], {}, null);
  assert.strictEqual(overTheWire(out[0]), "PERIO");
});

// ── The REST inline mapper in main.js ───────────────────────────────────────

test("REST inline: a real zero survives to the wire as zero", () => {
  const out = mapOdApiBenefits([restRow(0)]);
  assert.strictEqual(overTheWire(out[0]), 0);
});

test("REST inline: true absence stays null", () => {
  const out = mapOdApiBenefits([withoutEbenefitCat(restRow(0))]);
  assert.strictEqual(overTheWire(out[0]), null);
});

test("REST inline: a malformed value stays present", () => {
  const out = mapOdApiBenefits([restRow("PERIO")]);
  assert.strictEqual(overTheWire(out[0]), "PERIO");
});

// ── The three surfaces agree ────────────────────────────────────────────────

test("all three senders agree on every raw case", () => {
  // Codex called this parity-sensitive: one line fixed in isolation would let
  // the paths drift on the value the backend now depends on.
  for (const raw of [0, 6, null, "PERIO", "  ", "6", undefined]) {
    const mysql = overTheWire(mapMysqlBenefits([mysqlRow(raw)])[0]);
    const shared = overTheWire(mapBenefits([restRow(raw)], {}, null)[0]);
    const rest = overTheWire(mapOdApiBenefits([restRow(raw)])[0]);
    assert.strictEqual(shared, mysql, `shared disagrees on ${String(raw)}`);
    assert.strictEqual(rest, mysql, `REST disagrees on ${String(raw)}`);
  }
});

test("the helper itself is the one that decides, on every surface", () => {
  // If a surface stops calling it, the parity loop above still passes only if
  // the replacement happens to agree — pin the helper's own contract too.
  assert.strictEqual(odRawEbenefitCat(0), 0);
  assert.strictEqual(odRawEbenefitCat(null), null);
  assert.strictEqual(odRawEbenefitCat(undefined), null);
  assert.strictEqual(odRawEbenefitCat(""), null);
  assert.strictEqual(odRawEbenefitCat("PERIO"), "PERIO");
  assert.strictEqual(odRawEbenefitCat("6"), 6);
});

test("no sender still uses the falsy-coercion form", () => {
  const odSrc = fs.readFileSync(
    path.join(__dirname, "..", "od-mysql.js"),
    "utf8",
  );
  const libSrc = fs.readFileSync(
    path.join(__dirname, "..", "lib", "benefit-mapper.js"),
    "utf8",
  );
  for (const [name, src] of [
    ["main.js", mainSrc],
    ["od-mysql.js", odSrc],
    ["lib/benefit-mapper.js", libSrc],
  ]) {
    assert.ok(
      !/Number\(\w+\.EbenefitCat \?\? 0\) \|\| null/.test(src),
      `${name} still nulls a real zero`,
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
