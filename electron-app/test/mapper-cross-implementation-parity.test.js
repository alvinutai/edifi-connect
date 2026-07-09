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

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
