/**
 * Phase 6E — REST frequency / CodeGroup forwarding tests. Synthetic data only.
 * Mirrors the Harper PatPlanNum 7336 "Frequency Limitation Benefits" panel:
 *   BW 2/yr, Exam 3/yr, Prophy 3/yr, Crown every 5 yr, SRP every 24 mo, Implant every 5 yr.
 * Run: node test/rest-frequency-codegroup.test.js (from electron-app/)
 */

const assert = require("assert");
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

// CodeGroupNum → GroupName map as /codegroups would return for plan 7336.
const CG = { 1: "BW", 2: "Exam", 5: "Prophy", 8: "Crown", 11: "SRP", 12: "Implants" };

// One OD REST /benefits Limitations row (BenefitType 3).
const lim = (over = {}) => ({
  BenefitNum: 400,
  PlanNum: 7336,
  PatPlanNum: 0,
  BenefitType: 3,
  CovCatNum: 0,
  CoverageLevel: "None",
  ...over,
});

// Minimal replica of AptDrawer limitationFreq's derive step (6E-2) — proves the
// mapper output renders the exact screenshot frequency strings end to end.
function renderFreq(e) {
  const quantity = Number(e.quantity ?? 0);
  const period = String(e.period ?? "").toLowerCase();
  if (quantity > 0 && period) {
    if (period === "calendaryear" || period === "serviceyear")
      return `${quantity}x / yr`;
    const y = period.match(/^years(\d+)$/);
    if (y) return `${quantity}x / ${y[1]} yr`;
    const m = period.match(/^months(\d+)$/);
    if (m) return `${quantity}x / ${m[1]} mo`;
  }
  return "—";
}

const map1 = (row) => mapBenefits([row], null, null, CG)[0];

console.log("\nPhase 6E REST frequency / CodeGroup forwarding");

test("BW — 2 per benefit year", () => {
  const e = map1(
    lim({
      CodeGroupNum: 1,
      Quantity: 2,
      QuantityQualifier: "NumberOfServices",
      TimePeriod: "CalendarYear",
    }),
  );
  assert.strictEqual(e.code_group_num, 1);
  assert.strictEqual(e.code_group_desc, "BW");
  assert.strictEqual(e.qualifier, "NumberOfServices");
  assert.strictEqual(e.quantity, 2);
  assert.strictEqual(e.period, "CalendarYear");
  assert.strictEqual(renderFreq(e), "2x / yr");
});

test("Exam — 3 per benefit year", () => {
  const e = map1(
    lim({
      CodeGroupNum: 2,
      Quantity: 3,
      QuantityQualifier: "NumberOfServices",
      TimePeriod: "CalendarYear",
    }),
  );
  assert.strictEqual(e.code_group_desc, "Exam");
  assert.strictEqual(renderFreq(e), "3x / yr");
});

test("Prophy — 3 per benefit year", () => {
  const e = map1(
    lim({
      CodeGroupNum: 5,
      Quantity: 3,
      QuantityQualifier: "NumberOfServices",
      TimePeriod: "CalendarYear",
    }),
  );
  assert.strictEqual(e.code_group_desc, "Prophy");
  assert.strictEqual(renderFreq(e), "3x / yr");
});

test("Crown — every 5 years (interval collapses count to 1)", () => {
  const e = map1(
    lim({
      CodeGroupNum: 8,
      Quantity: 5,
      QuantityQualifier: "Years",
      TimePeriod: "None",
    }),
  );
  assert.strictEqual(e.code_group_desc, "Crown");
  assert.strictEqual(e.qualifier, "Years");
  assert.strictEqual(e.quantity, 1);
  assert.strictEqual(e.period, "Years5");
  assert.strictEqual(renderFreq(e), "1x / 5 yr");
});

test("SRP — every 24 months", () => {
  const e = map1(
    lim({
      CodeGroupNum: 11,
      Quantity: 24,
      QuantityQualifier: "Months",
      TimePeriod: "None",
    }),
  );
  assert.strictEqual(e.code_group_desc, "SRP");
  assert.strictEqual(e.quantity, 1);
  assert.strictEqual(e.period, "Months24");
  assert.strictEqual(renderFreq(e), "1x / 24 mo");
});

test("Implant — every 5 years", () => {
  const e = map1(
    lim({
      CodeGroupNum: 12,
      Quantity: 5,
      QuantityQualifier: "Years",
      TimePeriod: "None",
    }),
  );
  assert.strictEqual(e.code_group_desc, "Implants");
  assert.strictEqual(e.period, "Years5");
  assert.strictEqual(renderFreq(e), "1x / 5 yr");
});

// ── Null-safety / edge cases ──────────────────────────────────────────────────

test("cold CodeGroup cache: code_group_num still forwarded, desc null, row kept", () => {
  const e = mapBenefits(
    [
      lim({
        CodeGroupNum: 8,
        Quantity: 5,
        QuantityQualifier: "Years",
        TimePeriod: "None",
      }),
    ],
    null,
    null,
    null,
  )[0];
  assert.strictEqual(e.code_group_num, 8);
  assert.strictEqual(e.code_group_desc, null);
  assert.strictEqual(e.period, "Years5");
});

test("CodeGroupNum=0 → both code_group fields null", () => {
  const e = map1(
    lim({
      CodeGroupNum: 0,
      Quantity: 1,
      QuantityQualifier: "NumberOfServices",
      TimePeriod: "CalendarYear",
    }),
  );
  assert.strictEqual(e.code_group_num, null);
  assert.strictEqual(e.code_group_desc, null);
});

test("AgeLimit row is not rendered as a frequency", () => {
  const e = map1(
    lim({
      CodeGroupNum: 6,
      Quantity: 99,
      QuantityQualifier: "AgeLimit",
      TimePeriod: "None",
    }),
  );
  assert.strictEqual(e.qualifier, "AgeLimit");
  assert.strictEqual(e.period, "None");
  assert.strictEqual(renderFreq(e), "—");
});

test("qualifier is forwarded on every limitation row", () => {
  const e = map1(
    lim({
      CodeGroupNum: 1,
      Quantity: 2,
      QuantityQualifier: "NumberOfServices",
      TimePeriod: "ServiceYear",
    }),
  );
  assert.strictEqual(e.qualifier, "NumberOfServices");
  assert.strictEqual(renderFreq(e), "2x / yr");
});

test("CoInsurance rows are unaffected (additive contract)", () => {
  const e = mapBenefits(
    [
      {
        BenefitNum: 1,
        BenefitType: 1,
        CovCatNum: 2,
        Percent: "80",
        CoverageLevel: "Individual",
      },
    ],
    null,
    null,
    CG,
  )[0];
  assert.strictEqual(e.type, "CoInsurance");
  assert.strictEqual(e.percent, 80);
  assert.strictEqual(e.code_group_num, null);
  assert.strictEqual(e.code_group_desc, null);
  assert.strictEqual(e.qualifier, undefined);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
