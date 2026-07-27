/**
 * Phase 6D-1 — CodeNum/ProcCode forwarding tests. Synthetic data only.
 * Run: node test/codenum-forwarding.test.js (from electron-app/)
 */

const assert = require("assert");
const { mapBenefits, buildCatMap } = require("../lib/benefit-mapper");

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

const coins = (over = {}) => ({
  BenefitNum: 100,
  PlanNum: 9001,
  PatPlanNum: 0,
  BenefitType: 1,
  CovCatNum: 0,
  Percent: "80",
  CoverageLevel: "Individual",
  ...over,
});

const PROC_MAP = { 87: "D1110", 233: "D0274", 510: "D2750" };

console.log("\nPhase 6D-1 CodeNum/ProcCode forwarding");

test("CodeNum copied onto entry as code_num", () => {
  const [e] = mapBenefits([coins({ CodeNum: 87 })], null, PROC_MAP);
  assert.strictEqual(e.code_num, 87);
});

test("proc_code resolved from the CodeNum map (D1110)", () => {
  const [e] = mapBenefits([coins({ CodeNum: 87 })], null, PROC_MAP);
  assert.strictEqual(e.proc_code, "D1110");
});

test("cache miss: code_num still forwarded, proc_code null, row NOT dropped", () => {
  const [e] = mapBenefits([coins({ CodeNum: 999 })], null, PROC_MAP);
  assert.strictEqual(e.code_num, 999);
  assert.strictEqual(e.proc_code, null);
});

test("no procCodeMap at all (cold cache): push continues, fields null-safe", () => {
  const out = mapBenefits([coins({ CodeNum: 87 })], null, null);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].code_num, 87);
  assert.strictEqual(out[0].proc_code, null);
});

test("CodeNum=0 (category-attached row) → both fields null", () => {
  const [e] = mapBenefits(
    [coins({ CodeNum: 0, CovCatNum: 2 })],
    null,
    PROC_MAP,
  );
  assert.strictEqual(e.code_num, null);
  assert.strictEqual(e.proc_code, null);
});

test("CodeNum absent entirely (old OD payload shape) → null, no throw", () => {
  const [e] = mapBenefits([coins({})], null, PROC_MAP);
  assert.strictEqual(e.code_num, null);
  assert.strictEqual(e.proc_code, null);
});

test("CovCatNum category resolution unchanged when CodeNum also present", () => {
  // category metadata must keep precedence downstream — the agent's category
  // field is computed exactly as before, proc linkage is purely additive
  const catMap = buildCatMap([
    { CovCatNum: 2, Description: "Preventive", EbenefitCat: 2 },
  ]);
  const [e] = mapBenefits(
    [coins({ CovCatNum: 2, CodeNum: 510 })],
    catMap,
    PROC_MAP,
  );
  assert.strictEqual(e.category, "PREVENTIVE");
  assert.strictEqual(e.category_source, "CovCatNum");
  assert.strictEqual(e.proc_code, "D2750");
});

test("Limitations row carries code_num/proc_code with frequency fields intact", () => {
  const [e] = mapBenefits(
    [
      {
        BenefitNum: 401,
        PlanNum: 9001,
        PatPlanNum: 0,
        BenefitType: 3,
        CovCatNum: 0,
        CodeNum: 233,
        Quantity: 2,
        TimePeriod: 2,
        CoverageLevel: "Individual",
      },
    ],
    null,
    PROC_MAP,
  );
  assert.strictEqual(e.type, "Limitations");
  assert.strictEqual(e.quantity, 2);
  assert.strictEqual(e.period, "CalendarYear");
  assert.strictEqual(e.code_num, 233);
  assert.strictEqual(e.proc_code, "D0274");
});

test("proc_code map values that are not strings are ignored safely", () => {
  const [e] = mapBenefits([coins({ CodeNum: 87 })], null, { 87: 12345 });
  assert.strictEqual(e.proc_code, null);
});

test("existing fields unchanged: additive contract holds", () => {
  const [e] = mapBenefits([coins({ CodeNum: 87 })], null, PROC_MAP);
  assert.strictEqual(e.type, "CoInsurance");
  assert.strictEqual(e.percent, 80);
  assert.strictEqual(e.benefit_num, 100);
  assert.strictEqual(e.cov_cat_num, 0);
  assert.strictEqual(e.plan_num, 9001);
});

// ── 6D-1B review-fix additions ────────────────────────────────────────────────

test("exact key set pinned for a mapped CoInsurance entry (additive contract, 6D-1B)", () => {
  const [e] = mapBenefits([coins({ CodeNum: 87 })], null, PROC_MAP);
  // B-014 fix cycle 1: code_group_num/code_group_desc joined the shared base
  // shape (forwarded from the row, never fetched). Additive, same as 6D-1's
  // code_num/proc_code before them.
  assert.deepStrictEqual(Object.keys(e).sort(), [
    "benefit_num",
    "category",
    "category_source",
    "code_group_desc",
    "code_group_num",
    "code_num",
    "cov_cat_num",
    "coverage_level",
    "ebenefitcat",
    "pat_plan_num",
    "percent",
    "plan_num",
    "proc_code",
    "type",
  ]);
});

test("string CodeNum normalizes to number and still resolves (6D-1B)", () => {
  const [e] = mapBenefits([coins({ CodeNum: "87" })], null, PROC_MAP);
  assert.strictEqual(e.code_num, 87);
  assert.strictEqual(e.proc_code, "D1110");
});

test("empty-string proc-map value is rejected to null (6D-1B)", () => {
  const [e] = mapBenefits([coins({ CodeNum: 87 })], null, { 87: "" });
  assert.strictEqual(e.code_num, 87);
  assert.strictEqual(e.proc_code, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
