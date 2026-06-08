/**
 * Tests for benefit category resolution (G-09C/v2.3.64).
 * Imports from the actual production module — not a copy.
 * Run: node test/mapOdApiBenefits.test.js
 */

const assert = require("assert");
const { resolveBenefitCategory, BENEFIT_ROW_EBENCAT_MAP } = require("../lib/benefit-category");

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

console.log("\nresolveBenefitCategory (v2.3.64)");

// T1 — CovCatNum maps to specific category; EbenefitCat ignored
test("CovCatNum=2 (PREVENTIVE) wins even when EbenefitCat=4 (BASIC)", () => {
  const { category, categorySource } = resolveBenefitCategory("PREVENTIVE", 4);
  assert.strictEqual(category, "PREVENTIVE");
  assert.strictEqual(categorySource, "CovCatNum");
});

// T2 — CovCatNum=0 fallback to EbenefitCat=4
test("CovCatNum=0 + EbenefitCat=4 → BASIC", () => {
  const { category, categorySource } = resolveBenefitCategory("GENERAL", 4);
  assert.strictEqual(category, "BASIC");
  assert.strictEqual(categorySource, "EbenefitCat");
});

// T3 — CovCatNum=0 fallback to EbenefitCat=5
test("CovCatNum=0 + EbenefitCat=5 → ENDODONTIC", () => {
  const { category, categorySource } = resolveBenefitCategory("GENERAL", 5);
  assert.strictEqual(category, "ENDODONTIC");
  assert.strictEqual(categorySource, "EbenefitCat");
});

// T4 — CovCatNum=0 fallback to EbenefitCat=6
test("CovCatNum=0 + EbenefitCat=6 → PERIODONTIC", () => {
  const { category, categorySource } = resolveBenefitCategory("GENERAL", 6);
  assert.strictEqual(category, "PERIODONTIC");
  assert.strictEqual(categorySource, "EbenefitCat");
});

// T5 — CovCatNum=0 fallback to EbenefitCat=7
test("CovCatNum=0 + EbenefitCat=7 → ORAL_SURGERY", () => {
  const { category, categorySource } = resolveBenefitCategory("GENERAL", 7);
  assert.strictEqual(category, "ORAL_SURGERY");
  assert.strictEqual(categorySource, "EbenefitCat");
});

// T6 — Missing EbenefitCat stays GENERAL
test("CovCatNum=0 + EbenefitCat absent → GENERAL", () => {
  const { category, categorySource } = resolveBenefitCategory("GENERAL", null);
  assert.strictEqual(category, "GENERAL");
  assert.strictEqual(categorySource, "fallback");
});

// T7 — MAJOR preserved from CovCatNum mapping
test("MAJOR stays MAJOR regardless of EbenefitCat", () => {
  const { category, categorySource } = resolveBenefitCategory("MAJOR", 5);
  assert.strictEqual(category, "MAJOR");
  assert.strictEqual(categorySource, "CovCatNum");
});

// T8 — Unknown EbenefitCat stays GENERAL
test("CovCatNum=0 + EbenefitCat=99 (unknown) → GENERAL, no throw", () => {
  let result;
  assert.doesNotThrow(() => {
    result = resolveBenefitCategory("GENERAL", 99);
  });
  assert.strictEqual(result.category, "GENERAL");
  assert.strictEqual(result.categorySource, "fallback");
});

// T9 — PROSTHODONTIA preserved
test("PROSTHODONTIA stays PROSTHODONTIA regardless of EbenefitCat", () => {
  const { category } = resolveBenefitCategory("PROSTHODONTIA", 6);
  assert.strictEqual(category, "PROSTHODONTIA");
});

// T10 — String EbenefitCat coerced to number safely
test("EbenefitCat as string '4' coerces to BASIC", () => {
  const { category } = resolveBenefitCategory("GENERAL", "4");
  assert.strictEqual(category, "BASIC");
});

// T11 — EbenefitCat=undefined handled safely
test("EbenefitCat=undefined → GENERAL, no throw", () => {
  let result;
  assert.doesNotThrow(() => {
    result = resolveBenefitCategory("GENERAL", undefined);
  });
  assert.strictEqual(result.category, "GENERAL");
});

// T12 — BENEFIT_ROW_EBENCAT_MAP is exported and contains required keys
test("BENEFIT_ROW_EBENCAT_MAP exported with required keys 4-7", () => {
  assert.strictEqual(BENEFIT_ROW_EBENCAT_MAP[4], "BASIC");
  assert.strictEqual(BENEFIT_ROW_EBENCAT_MAP[5], "ENDODONTIC");
  assert.strictEqual(BENEFIT_ROW_EBENCAT_MAP[6], "PERIODONTIC");
  assert.strictEqual(BENEFIT_ROW_EBENCAT_MAP[7], "ORAL_SURGERY");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
