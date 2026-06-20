/**
 * Phase 6E-1 — MySQL benefit row mapper tests (CodeGroup identity forwarding).
 * Pure function, synthetic rows, no database connection.
 * Run: node test/mysql-benefit-row.test.js
 */

const assert = require("assert");
const { mapMysqlBenefitRow } = require("../od-mysql");

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

const row = (over = {}) => ({
  BenefitNum: 700,
  CovCatNum: 0,
  CodeNum: 87,
  BenefitType: 1,
  CoverageLevel: 1,
  Percent: "80",
  MonetaryAmt: null,
  Quantity: null,
  QuantityQualifier: null,
  TimePeriod: 0,
  CategoryDesc: null,
  EbenefitCat: null,
  ProcCode: "D1110",
  ...over,
});

console.log("\nPhase 6E-1 MySQL benefit row mapper");

test("full row maps with code_num and proc_code", () => {
  const b = mapMysqlBenefitRow(row());
  assert.strictEqual(b.code_num, 87);
  assert.strictEqual(b.proc_code, "D1110");
  assert.strictEqual(b.benefit_num, 700);
  assert.strictEqual(b.percent, 80);
});

test("NULL ProcCode from LEFT JOIN miss → proc_code null, row survives", () => {
  const b = mapMysqlBenefitRow(row({ ProcCode: null }));
  assert.strictEqual(b.proc_code, null);
  assert.strictEqual(b.code_num, 87);
});

test("empty-string ProcCode → null", () => {
  const b = mapMysqlBenefitRow(row({ ProcCode: "" }));
  assert.strictEqual(b.proc_code, null);
});

test("CodeNum=0 (category-attached row) → code_num null", () => {
  const b = mapMysqlBenefitRow(
    row({ CodeNum: 0, CovCatNum: 5, ProcCode: null }),
  );
  assert.strictEqual(b.code_num, null);
  assert.strictEqual(b.cov_cat_num, 5);
});

test("string CodeNum normalizes to number", () => {
  const b = mapMysqlBenefitRow(row({ CodeNum: "87" }));
  assert.strictEqual(b.code_num, 87);
});

test("Percent=-1 (OD not-entered sentinel) drops the row as before", () => {
  const b = mapMysqlBenefitRow(row({ Percent: "-1" }));
  assert.strictEqual(b, null);
});

test("unknown BenefitType drops the row as before", () => {
  const b = mapMysqlBenefitRow(row({ BenefitType: 9 }));
  assert.strictEqual(b, null);
});

test("Limitations frequency row keeps quantity/period/qualifier with linkage", () => {
  const b = mapMysqlBenefitRow(
    row({
      BenefitType: 3,
      Percent: null,
      Quantity: 2,
      QuantityQualifier: 2,
      TimePeriod: 2,
      CodeNum: 744,
      ProcCode: "D4341",
    }),
  );
  assert.strictEqual(b.type, "Limitations");
  assert.strictEqual(b.quantity, 2);
  assert.strictEqual(b.period, "CalendarYear");
  assert.strictEqual(b.code_num, 744);
  assert.strictEqual(b.proc_code, "D4341");
});

test("ebenefitcat passes through verbatim alongside the new fields", () => {
  // NOTE (6D-1B finding): the MySQL CATEGORY_MAP interprets EbenefitCat on a
  // shifted scale vs OD's actual enum (and vs the REST path + backend) —
  // e.g. 6 produces ORAL_SURGERY here but Periodontics in OD's enum. That
  // pre-existing misalignment is documented for its own gate; this test only
  // pins that the raw ebenefitcat value is forwarded unchanged so the
  // backend can resolve truthfully regardless of the local label.
  const b = mapMysqlBenefitRow(
    row({ EbenefitCat: 6, CodeNum: 0, ProcCode: null }),
  );
  assert.strictEqual(b.ebenefitcat, 6);
});

// ── 6E-1 CodeGroup identity forwarding additions ───────────────────────────────

test("Limitations row with CodeGroupNum > 0 and CodeNum=0 emits code_group fields", () => {
  const b = mapMysqlBenefitRow(
    row({
      BenefitType: 3,
      Percent: null,
      Quantity: 2,
      QuantityQualifier: 2,
      TimePeriod: 2,
      CodeNum: 0,
      ProcCode: null,
      CodeGroupNum: 42,
      CodeGroupDesc: "Exams / Bitewings",
    }),
  );
  assert.strictEqual(b.type, "Limitations");
  assert.strictEqual(b.code_num, null);
  assert.strictEqual(b.proc_code, null);
  assert.strictEqual(b.code_group_num, 42);
  assert.strictEqual(b.code_group_desc, "Exams / Bitewings");
  assert.strictEqual(b.quantity, 2);
  assert.strictEqual(b.period, "CalendarYear");
});

test("CoInsurance output unchanged when CodeGroup fields are absent", () => {
  const b = mapMysqlBenefitRow(row({ BenefitType: 1, Percent: "80" }));
  assert.strictEqual(b.type, "CoInsurance");
  assert.strictEqual(b.percent, 80);
  assert.strictEqual(b.code_num, 87);
  assert.strictEqual(b.proc_code, "D1110");
  assert.strictEqual(b.code_group_num, null);
  assert.strictEqual(b.code_group_desc, null);
});

test("missing CodeGroup columns fall back safely with code_group fields null", () => {
  // Simulates the fallback SELECT path (older OD schema without CodeGroupNum).
  const b = mapMysqlBenefitRow(
    row({ CodeGroupNum: undefined, CodeGroupDesc: undefined }),
  );
  assert.strictEqual(b.code_group_num, null);
  assert.strictEqual(b.code_group_desc, null);
});

test("empty CodeGroupDesc becomes null", () => {
  const b = mapMysqlBenefitRow(
    row({ CodeGroupNum: 7, CodeGroupDesc: "" }),
  );
  assert.strictEqual(b.code_group_num, 7);
  assert.strictEqual(b.code_group_desc, null);
});

test("CodeGroupNum=0 becomes null", () => {
  const b = mapMysqlBenefitRow(
    row({ CodeGroupNum: 0, CodeGroupDesc: "Crowns" }),
  );
  assert.strictEqual(b.code_group_num, null);
  assert.strictEqual(b.code_group_desc, "Crowns");
});

test("exact key set pinned for a mapped CoInsurance entry (additive contract, 6E-1)", () => {
  const b = mapMysqlBenefitRow(row({ CodeGroupNum: 5, CodeGroupDesc: "Implants" }));
  assert.deepStrictEqual(Object.keys(b).sort(), [
    "benefit_num",
    "category",
    "code_group_desc",
    "code_group_num",
    "code_num",
    "cov_cat_num",
    "coverage_level",
    "ebenefitcat",
    "percent",
    "proc_code",
    "type",
  ]);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
