/**
 * B-014 (2026-07-09) — behavioral tests for the inline mapOdApiBenefits()
 * in main.js (the live function that actually runs during OD sync).
 * main.js cannot be require()'d directly in Node (it boots Electron), so the
 * function source is extracted the same way test/mapper-drift.test.js does,
 * then evaluated with its free-variable dependencies (resolveBenefitCategory,
 * the OD cache globals, log) bound to test doubles.
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
  "odCodeGroupCache",
  "log",
  `${inlineSrc}\nreturn mapOdApiBenefits;`,
)(resolveBenefitCategory, null, null, null, () => {});

console.log("\nmapOdApiBenefits (main.js inline) — B-014 behavioral tests");

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
  const result = mapOdApiBenefits([
    row(3, {
      QuantityQualifier: "NumberOfServices",
      Quantity: "0",
      TimePeriod: 2,
    }),
  ]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].quantity, 0);
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

// --- 5. Limitations quantity/period edge cases ---

test("Limitations NumberOfServices → quantity/period forwarded", () => {
  const result = mapOdApiBenefits([
    row(3, {
      QuantityQualifier: "NumberOfServices",
      Quantity: "2",
      TimePeriod: 2,
    }),
  ]);
  assert.strictEqual(result[0].quantity, 2);
  assert.strictEqual(result[0].period, "CalendarYear");
});

test("Limitations Years=5 (integer) → quantity=1, period=Years5", () => {
  const result = mapOdApiBenefits([
    row(3, { QuantityQualifier: "Years", Quantity: "5" }),
  ]);
  assert.strictEqual(result[0].quantity, 1);
  assert.strictEqual(result[0].period, "Years5");
});

test("Limitations Months=24 (integer) → quantity=1, period=Months24", () => {
  const result = mapOdApiBenefits([
    row(3, { QuantityQualifier: "Months", Quantity: "24" }),
  ]);
  assert.strictEqual(result[0].quantity, 1);
  assert.strictEqual(result[0].period, "Months24");
});

test("Limitations Years=1.5 (decimal) → preserved with period=None, tracked as fallback", () => {
  const result = mapOdApiBenefits([
    row(3, { QuantityQualifier: "Years", Quantity: "1.5" }),
  ]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].quantity, 1.5);
  assert.strictEqual(result[0].period, "None");
  assert.strictEqual(result._fallback_reasons.limitations_decimal_years_qty, 1);
  assert.deepStrictEqual(result._dropped_reasons, {});
});

test("Limitations Months=2.5 (decimal) → preserved with period=None, tracked as fallback", () => {
  const result = mapOdApiBenefits([
    row(3, { QuantityQualifier: "Months", Quantity: "2.5" }),
  ]);
  assert.strictEqual(result[0].quantity, 2.5);
  assert.strictEqual(result[0].period, "None");
  assert.strictEqual(
    result._fallback_reasons.limitations_decimal_months_qty,
    1,
  );
});

test("Limitations with no valid quantity or amount is dropped with a reason", () => {
  const result = mapOdApiBenefits([
    row(3, {
      QuantityQualifier: "NumberOfServices",
      Quantity: null,
      MonetaryAmt: null,
    }),
  ]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped_reasons.limitations_no_valid_value, 1);
});

test("Limitations MonetaryAmt=0 alone (no quantity) is preserved, not dropped", () => {
  const result = mapOdApiBenefits([
    row(3, {
      QuantityQualifier: "NumberOfServices",
      Quantity: null,
      MonetaryAmt: "0",
    }),
  ]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].amount_cents, 0);
  assert.strictEqual(result[0].quantity, undefined);
  assert.strictEqual(result._dropped, 0);
});

test("Limitations malformed MonetaryAmt (with no valid quantity either) is dropped", () => {
  const result = mapOdApiBenefits([
    row(3, {
      QuantityQualifier: "NumberOfServices",
      Quantity: null,
      MonetaryAmt: "garbage",
    }),
  ]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped_reasons.limitations_no_valid_value, 1);
});

test("Limitations malformed Quantity (with no MonetaryAmt either) is dropped", () => {
  const result = mapOdApiBenefits([
    row(3, {
      QuantityQualifier: "NumberOfServices",
      Quantity: "not-a-number",
      MonetaryAmt: null,
    }),
  ]);
  assert.strictEqual(result.length, 0);
  assert.strictEqual(result._dropped_reasons.limitations_no_valid_value, 1);
});

test("Limitations NumberOfServices Quantity=2.5 (decimal) is preserved with a real period, no fallback tracking", () => {
  // Unlike Years/Months, NumberOfServices never synthesizes a label string
  // from the raw quantity — it only looks up TimePeriod in a fixed enum — so
  // a decimal count here carries no malformed-label risk and is intentionally
  // not counted in fallback_reason_counts.
  const result = mapOdApiBenefits([
    row(3, {
      QuantityQualifier: "NumberOfServices",
      Quantity: "2.5",
      TimePeriod: 2,
    }),
  ]);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].quantity, 2.5);
  assert.strictEqual(result[0].period, "CalendarYear");
  assert.deepStrictEqual(result._fallback_reasons, {});
});

// --- 6. Two-counter invariant ---

test("sum(dropped_reasons) equals true drop count; fallback rows never inflate it", () => {
  const rawBenefits = [
    row(1, { BenefitNum: 1, Percent: "80" }), // kept
    row(1, { BenefitNum: 2, Percent: "-1" }), // dropped (coinsurance_invalid_percent)
    row(1, { BenefitNum: 3, Percent: "bad" }), // dropped (coinsurance_invalid_percent)
    row(2, { BenefitNum: 4, MonetaryAmt: null }), // dropped (deductible_invalid_amount)
    row(3, {
      BenefitNum: 5,
      QuantityQualifier: "NumberOfServices",
      Quantity: null,
      MonetaryAmt: null,
    }), // dropped (limitations_no_valid_value)
    row(99, { BenefitNum: 6 }), // preserved as Other (fallback, not dropped)
    row(3, { BenefitNum: 7, QuantityQualifier: "Years", Quantity: "1.5" }), // preserved (fallback)
  ];
  const result = mapOdApiBenefits(rawBenefits);
  assert.strictEqual(result._raw_received, 7);
  assert.strictEqual(result.length, 3); // 80% kept, Other kept, decimal-Years kept
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
  assert.strictEqual(fallbackSum, 2); // type_99 + decimal-Years
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
