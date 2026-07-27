/**
 * B-014 (2026-07-09, rc.3-adapted) — live cross-implementation parity check.
 *
 * mapper-drift.test.js only proves the two copies construct the same FIELD
 * NAMES (regex text match). benefit-mapper-parity.test.js only proves
 * lib/benefit-mapper.js matches a hand-maintained duplicate reference, not
 * main.js. Neither actually runs main.js's live inline mapOdApiBenefits()
 * and lib/benefit-mapper.js's mapBenefits() on the same input and diffs the
 * real output — so a behavioral drift between the two copies (the exact
 * risk this duplication creates) could pass every existing test.
 *
 * This file closes that gap: extract the live inline function from main.js
 * (same technique as mapOdApiBenefits.test.js), run it and mapBenefits()
 * against identical raw rows covering the B-014 edge cases, and assert
 * deepStrictEqual on every diagnostic counter and entry field.
 *
 * Run: node test/mapper-cross-implementation-parity.test.js (from electron-app/)
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { resolveBenefitCategory } = require("../lib/benefit-category");
const { mapBenefits } = require("../lib/benefit-mapper");

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
assert.ok(start > -1 && end > start, "extraction anchors not found in main.js");
const inlineSrc = mainSrc.slice(start, end);

const mapOdApiBenefits = new Function(
  "resolveBenefitCategory",
  "odCovCatCache",
  "odProcCodeCache",
  "log",
  `${inlineSrc}\nreturn mapOdApiBenefits;`,
)(resolveBenefitCategory, null, null, () => {});

console.log(
  "\nmain.js inline vs lib/benefit-mapper.js — live cross-implementation parity (rc.4)",
);

const row = (type, over = {}) => ({
  BenefitNum: 1,
  PlanNum: 9001,
  PatPlanNum: 0,
  BenefitType: type,
  CovCatNum: 2,
  CoverageLevel: "Individual",
  ...over,
});

const SAMPLES = [
  row(1, { BenefitNum: 1, Percent: "80" }), // valid CoInsurance
  row(1, { BenefitNum: 2, Percent: "0" }), // explicit zero preserved
  row(1, { BenefitNum: 3, Percent: "-1" }), // negative sentinel dropped
  row(1, { BenefitNum: 4, Percent: "not-a-number" }), // malformed dropped
  row(2, { BenefitNum: 5, MonetaryAmt: "50" }), // valid Deductible
  row(2, { BenefitNum: 6, MonetaryAmt: "0" }), // explicit zero preserved
  row(2, { BenefitNum: 7, MonetaryAmt: null }), // dropped
  row(3, { BenefitNum: 8, Quantity: "2", TimePeriod: 2 }), // valid Limitations
  row(3, { BenefitNum: 9, Quantity: null, MonetaryAmt: null }), // dropped, no valid value
  row(3, { BenefitNum: 10, Quantity: null, MonetaryAmt: "0" }), // Limitations MonetaryAmt=0 alone preserved
  row(3, { BenefitNum: 11, Quantity: "garbage", MonetaryAmt: null }), // Limitations malformed Quantity dropped
  row(99, { BenefitNum: 12, Percent: "100" }), // unmapped BenefitType → Other
  // ── B-014 §2.B qualifier branches — every one crosses the main↔lib gate ──
  row(3, {
    BenefitNum: 13,
    Quantity: "2",
    TimePeriod: 2,
    QuantityQualifier: "NumberOfServices",
  }), // count + window
  row(3, {
    BenefitNum: 14,
    Quantity: "3",
    TimePeriod: 999,
    QuantityQualifier: "NumberOfServices",
  }), // unknown TimePeriod → CalendarYear default
  row(3, { BenefitNum: 15, Quantity: 5, QuantityQualifier: "Years" }), // integral Years
  row(3, { BenefitNum: 16, Quantity: "6", QuantityQualifier: "Months" }), // integral Months
  row(3, { BenefitNum: 17, Quantity: "1.5", QuantityQualifier: "Years" }), // fractional Years
  row(3, { BenefitNum: 18, Quantity: "6.5", QuantityQualifier: "Months" }), // fractional Months
  row(3, {
    BenefitNum: 19,
    Quantity: 0,
    TimePeriod: 1,
    QuantityQualifier: "Years",
  }), // zero → generic branch
  row(3, {
    BenefitNum: 21,
    Quantity: true,
    MonetaryAmt: "75",
    QuantityQualifier: "Years",
  }), // malformed discriminator, kept on amount
  row(3, { BenefitNum: 22, Quantity: "1", TimePeriod: 2, CodeGroupNum: 5 }), // code group forwarded
  row("CoPayment", { BenefitNum: 23, MonetaryAmt: "25" }), // string CoPayment
  row("CoPayment", { BenefitNum: 24, MonetaryAmt: "n/a" }), // malformed copay → dropped
  row(4, { BenefitNum: 25, MonetaryAmt: "25" }), // numeric 4 stays Other
];

const inlineResult = mapOdApiBenefits(SAMPLES);
const libResult = mapBenefits(SAMPLES, null, null);

test("_raw_received matches", () => {
  assert.strictEqual(libResult._raw_received, inlineResult._raw_received);
});

test("_dropped matches", () => {
  assert.strictEqual(libResult._dropped, inlineResult._dropped);
});

test("_dropped_reasons matches", () => {
  assert.deepStrictEqual(
    libResult._dropped_reasons,
    inlineResult._dropped_reasons,
  );
});

test("_fallback_reasons matches", () => {
  assert.deepStrictEqual(
    libResult._fallback_reasons,
    inlineResult._fallback_reasons,
  );
});

test("output array length matches", () => {
  assert.strictEqual(libResult.length, inlineResult.length);
});

for (let i = 0; i < inlineResult.length; i++) {
  test(`row benefit_num=${inlineResult[i].benefit_num} type=${inlineResult[i].type} entry matches`, () => {
    assert.deepStrictEqual(libResult[i], inlineResult[i]);
  });
}

// A populated category map + proc-code cache still produces identical output
// between the two implementations — the SAMPLES-only check above always
// runs with both null/default.
const catMap = { 2: "PREVENTIVE" };
const procCodeMap = { 87: "D1110" };
const procRow = [row(1, { BenefitNum: 20, Percent: "60", CodeNum: 87 })];
const mapOdApiBenefitsWithProcCache = new Function(
  "resolveBenefitCategory",
  "odCovCatCache",
  "odProcCodeCache",
  "log",
  `${inlineSrc}\nreturn mapOdApiBenefits;`,
)(resolveBenefitCategory, catMap, procCodeMap, () => {});
const inlineProcResult = mapOdApiBenefitsWithProcCache(procRow);
const libProcResult = mapBenefits(procRow, catMap, procCodeMap);

test("populated category map + proc-code cache: entries match between implementations", () => {
  assert.deepStrictEqual(libProcResult[0], inlineProcResult[0]);
  assert.strictEqual(inlineProcResult[0].proc_code, "D1110");
});

// Both implementations must agree on the diagnostic maps too, not just rows —
// a drift that only shows up in the counters would otherwise pass.
test("both implementations agree on every qualifier-branch outcome", () => {
  const byNum = (res, n) => res.find((r) => r.benefit_num === n);
  for (const n of [13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25]) {
    assert.deepStrictEqual(
      byNum(libResult, n),
      byNum(inlineResult, n),
      `benefit_num=${n} diverged between main.js and lib`,
    );
  }
  assert.strictEqual(byNum(inlineResult, 13).period, "CalendarYear");
  assert.strictEqual(byNum(inlineResult, 14).period, "CalendarYear");
  assert.strictEqual(byNum(inlineResult, 15).period, "Years5");
  assert.strictEqual(byNum(inlineResult, 16).period, "Months6");
  assert.strictEqual(byNum(inlineResult, 17).period, "None");
  assert.strictEqual(byNum(inlineResult, 19).period, "ServiceYear");
  assert.strictEqual(byNum(inlineResult, 21).quantity, undefined);
  assert.strictEqual(byNum(inlineResult, 22).code_group_num, 5);
  assert.strictEqual(byNum(inlineResult, 23).type, "CoPayment");
  assert.strictEqual(byNum(inlineResult, 23).amount_cents, 2500);
  assert.strictEqual(byNum(inlineResult, 25).type, "Other");
  assert.strictEqual(byNum(inlineResult, 24), undefined); // dropped
});

test("diagnostic maps match exactly across implementations, with both keys populated", () => {
  assert.deepStrictEqual(
    inlineResult._fallback_reasons,
    libResult._fallback_reasons,
  );
  assert.deepStrictEqual(
    inlineResult._dropped_reasons,
    libResult._dropped_reasons,
  );
  assert.strictEqual(
    inlineResult._fallback_reasons.limitations_decimal_years_qty,
    1,
  );
  assert.strictEqual(
    inlineResult._fallback_reasons.limitations_decimal_months_qty,
    1,
  );
  assert.strictEqual(inlineResult._dropped_reasons.copayment_invalid_amount, 1);
  const droppedSum = Object.values(inlineResult._dropped_reasons).reduce(
    (a, b) => a + b,
    0,
  );
  assert.strictEqual(droppedSum, inlineResult._dropped);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
