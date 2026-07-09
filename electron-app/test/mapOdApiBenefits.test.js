/**
 * B-014 (2026-07-09, rc.3-adapted) — behavioral tests for the inline
 * mapOdApiBenefits() in main.js (the live function that actually runs
 * during OD sync). main.js cannot be require()'d directly in Node (it boots
 * Electron), so the function source is extracted the same way
 * test/mapper-drift.test.js does, then evaluated with its free-variable
 * dependencies (resolveBenefitCategory, the OD cache globals, log) bound to
 * test doubles.
 *
 * This candidate (release/connect-2.4.0-rc.4) deliberately excludes 5a35003
 * (REST CodeGroup frequency metadata / qualifier-aware Years-Months period
 * synthesis) — a suspect in the rc.2 bridge-hold regression. Limitations
 * rows here use raw Quantity + TimePeriod only, no QuantityQualifier
 * interpretation. See EDIFI-EOS\B014-DEPLOY-PACKET-2026-07-09.md.
 *
 * This is the main entry point registered as `npm test` in package.json.
 * Run: node test/mapOdApiBenefits.test.js (from electron-app/)
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { resolveBenefitCategory } = require("../lib/benefit-category");

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

const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const start = mainSrc.indexOf("function toFiniteNumberOrNull(");
const end = mainSrc.indexOf("\nasync function syncODData(");
assert.ok(start > -1, "toFiniteNumberOrNull not found in main.js");
assert.ok(
  end > start,
  "end anchor (syncODData) lost — extraction window invalid",
);
const inlineSrc = mainSrc.slice(start, end);

const mapOdApiBenefits = new Function(
  "resolveBenefitCategory",
  "odCovCatCache",
  "odProcCodeCache",
  "log",
  `${inlineSrc}\nreturn mapOdApiBenefits;`,
)(resolveBenefitCategory, null, null, () => {});

console.log(
  "\nmapOdApiBenefits (main.js inline, rc.4) — B-014 behavioral tests",
);

// One OD REST /benefits row of a given type with sane defaults.
const row = (type, over = {}) => ({
  BenefitNum: 1,
  PlanNum: 9001,
  PatPlanNum: 0,
  BenefitType: type,
  CovCatNum: 2,
  CoverageLevel: "Individual",
  ...over,
});

// --- 1. Explicit-zero preservation (the original root cause) ---

test("CoInsurance Percent=0 is preserved, not dropped", () => {
  const result = mapOdApiBenefits([row(1, { Percent: "0" })]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].percent, 0);
  assert.strictEqual(result._dropped, 0);
});

test("Deductible MonetaryAmt=0 is preserved, not dropped", () => {
  const result = mapOdApiBenefits([row(2, { MonetaryAmt: "0" })]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].amount_cents, 0);
  assert.strictEqual(result._dropped, 0);
});

test("Limitations Quantity=0 is preserved, not dropped", () => {
  const result = mapOdApiBenefits([row(3, { Quantity: "0", TimePeriod: 2 })]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].quantity, 0);
  assert.strictEqual(result[0].period, "CalendarYear");
  assert.strictEqual(result._dropped, 0);
});

test("Limitations MonetaryAmt=0 alone (no quantity) is preserved, not dropped", () => {
  const result = mapOdApiBenefits([
    row(3, { Quantity: null, MonetaryAmt: "0" }),
  ]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].amount_cents, 0);
  assert.strictEqual(result._dropped, 0);
});

// --- 2. Malformed / non-finite numeric rejection ---

test("CoInsurance Percent=NaN-string is dropped with a reason", () => {
  const result = mapOdApiBenefits([row(1, { Percent: "not-a-number" })]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped, 1);
  assert.strictEqual(result._dropped_reasons.coinsurance_invalid_percent, 1);
});

test("CoInsurance Percent=Infinity (number) is dropped with a reason", () => {
  const result = mapOdApiBenefits([row(1, { Percent: Infinity })]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped_reasons.coinsurance_invalid_percent, 1);
});

test("CoInsurance Percent=[] (array) is dropped, not coerced", () => {
  const result = mapOdApiBenefits([row(1, { Percent: [] })]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped_reasons.coinsurance_invalid_percent, 1);
});

test("CoInsurance Percent=true (boolean) is dropped, not coerced to 1", () => {
  const result = mapOdApiBenefits([row(1, { Percent: true })]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped_reasons.coinsurance_invalid_percent, 1);
});

test("CoInsurance Percent='' (empty string) is dropped", () => {
  const result = mapOdApiBenefits([row(1, { Percent: "" })]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped_reasons.coinsurance_invalid_percent, 1);
});

test("Deductible MonetaryAmt=null is dropped with a reason", () => {
  const result = mapOdApiBenefits([row(2, { MonetaryAmt: null })]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped_reasons.deductible_invalid_amount, 1);
});

test("Limitations malformed Quantity and no MonetaryAmt is dropped", () => {
  const result = mapOdApiBenefits([
    row(3, { Quantity: "not-a-number", MonetaryAmt: null }),
  ]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped_reasons.limitations_no_valid_value, 1);
});

test("Limitations malformed MonetaryAmt and no Quantity is dropped", () => {
  const result = mapOdApiBenefits([
    row(3, { Quantity: null, MonetaryAmt: "garbage" }),
  ]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped_reasons.limitations_no_valid_value, 1);
});

// --- 3. Negative sentinel rejection (OD "not entered" convention) ---

test("CoInsurance Percent=-1 (OD not-entered sentinel) is dropped, not fabricated", () => {
  const result = mapOdApiBenefits([row(1, { Percent: "-1" })]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped_reasons.coinsurance_invalid_percent, 1);
});

test("Deductible MonetaryAmt=-50 is dropped, not treated as a real amount", () => {
  const result = mapOdApiBenefits([row(2, { MonetaryAmt: "-50" })]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped_reasons.deductible_invalid_amount, 1);
});

// --- 4. Unmapped BenefitType fallback (root cause #1) ---

test("Unmapped BenefitType is preserved as Other, never dropped", () => {
  const result = mapOdApiBenefits([row(99, { Percent: "100" })]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].type, "Other");
  assert.strictEqual(result._dropped, 0);
});

test("Unmapped BenefitType is counted in fallback_reason_counts, never dropped_reasons", () => {
  const result = mapOdApiBenefits([row(99, {})]);
  assert.strictEqual(result._fallback_reasons.type_99_unmapped_fallback, 1);
  assert.deepStrictEqual(result._dropped_reasons, {});
});

test("Other row carries no interpreted value fields, by design — the row's own BenefitType is unrecognized, so no field can be safely assumed to mean percent/amount/quantity", () => {
  const result = mapOdApiBenefits([
    row(99, { Percent: "100", MonetaryAmt: "50", Quantity: "2" }),
  ]);
  assert.strictEqual(result[0].type, "Other");
  assert.strictEqual(result[0].percent, undefined);
  assert.strictEqual(result[0].amount_cents, undefined);
  assert.strictEqual(result[0].quantity, undefined);
});

// --- 5. Limitations quantity/period (rc.3 baseline: raw Quantity + TimePeriod, no qualifier) ---

test("Limitations Quantity=2, TimePeriod=2 → quantity/period forwarded", () => {
  const result = mapOdApiBenefits([row(3, { Quantity: "2", TimePeriod: 2 })]);
  assert.strictEqual(result[0].quantity, 2);
  assert.strictEqual(result[0].period, "CalendarYear");
});

test("Limitations with no valid quantity or amount is dropped with a reason", () => {
  const result = mapOdApiBenefits([
    row(3, { Quantity: null, MonetaryAmt: null }),
  ]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped_reasons.limitations_no_valid_value, 1);
});

test("rc.3 baseline negative control: QuantityQualifier/CodeGroupNum/CodeGroupDesc on a raw row are silently ignored, not read or forwarded", () => {
  const result = mapOdApiBenefits([
    row(3, {
      Quantity: "2",
      TimePeriod: 2,
      QuantityQualifier: "Years", // would matter on the wizard-branch/5a35003 baseline; must be inert here
      CodeGroupNum: 5,
      CodeGroupDesc: "BW",
    }),
  ]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].quantity, 2);
  assert.strictEqual(result[0].period, "CalendarYear"); // NOT "Years2" — proves qualifier is not consulted
  assert.strictEqual(result[0].qualifier, undefined);
  assert.strictEqual(result[0].code_group_num, undefined);
  assert.strictEqual(result[0].code_group_desc, undefined);
});

// --- 6. Two-counter invariant ---

test("sum(dropped_reasons) equals true drop count; fallback rows never inflate it", () => {
  const rawBenefits = [
    row(1, { BenefitNum: 1, Percent: "80" }), // kept
    row(1, { BenefitNum: 2, Percent: "-1" }), // dropped (coinsurance_invalid_percent)
    row(1, { BenefitNum: 3, Percent: "bad" }), // dropped (coinsurance_invalid_percent)
    row(2, { BenefitNum: 4, MonetaryAmt: null }), // dropped (deductible_invalid_amount)
    row(3, { BenefitNum: 5, Quantity: null, MonetaryAmt: null }), // dropped (limitations_no_valid_value)
    row(99, { BenefitNum: 6 }), // preserved as Other (fallback, not dropped)
  ];
  const result = mapOdApiBenefits(rawBenefits);
  assert.strictEqual(result._raw_received, 6);
  assert.strictEqual(result.length, 2); // 80% kept, Other kept
  assert.strictEqual(result._dropped, 4);
  assert.deepStrictEqual(result._dropped_reasons, {
    coinsurance_invalid_percent: 2,
    deductible_invalid_amount: 1,
    limitations_no_valid_value: 1,
  });
  const droppedSum = Object.values(result._dropped_reasons).reduce(
    (a, b) => a + b,
    0,
  );
  assert.strictEqual(droppedSum, result._dropped);
  const fallbackSum = Object.values(result._fallback_reasons).reduce(
    (a, b) => a + b,
    0,
  );
  assert.strictEqual(fallbackSum, 1); // type_99 only
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
