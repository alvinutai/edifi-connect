/**
 * Parity test: lib/benefit-mapper.js vs inline mapOdApiBenefits in main.js.
 *
 * Runs BEFORE any changes to main.js. Proves that mapBenefits() produces
 * identical output to the inline version for the same inputs.
 * Ignores `ebenefitcat` and `category_source` — these are new additive fields
 * present in benefit-mapper.js but not in the pre-v2.3.64 inline version.
 *
 * Run: node test/benefit-mapper-parity.test.js (from electron-app/)
 */

const assert = require("assert");
const { mapBenefits, COV_CAT_NUM_DEFAULTS } = require("../lib/benefit-mapper");

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

// Simulates what the pre-v2.3.64 inline mapOdApiBenefits would produce
// (no EbenefitCat on the row, no resolveBenefitCategory call — raw catMap lookup only).
// Used only to establish parity baseline for the 6 sample inputs.
function inlineMapper(rawBenefits, catMap) {
  const BEN_TYPE = {
    1: "CoInsurance",
    2: "Deductible",
    3: "Limitations",
    CoInsurance: "CoInsurance",
    Deductible: "Deductible",
    Limitations: "Limitations",
    ActiveCoverage: "CoInsurance",
  };
  const COV_LEVEL = {
    0: "None",
    1: "Individual",
    2: "Family",
    None: "None",
    Individual: "Individual",
    Family: "Family",
  };
  const TIME_PERIOD = {
    0: "None",
    1: "ServiceYear",
    2: "CalendarYear",
    3: "Lifetime",
    4: "Years2",
    5: "Years3",
    8: "Months6",
    12: "Months24",
    None: "None",
    ServiceYear: "ServiceYear",
    CalendarYear: "CalendarYear",
    Lifetime: "Lifetime",
    Years: "Years2",
    NumberInLast12Months: "Months12",
  };
  const resolvedCatMap = catMap || COV_CAT_NUM_DEFAULTS;
  const results = [];
  const dropped_reasons = {};

  for (const b of rawBenefits) {
    const type = BEN_TYPE[b.BenefitType];
    if (!type) {
      const key = `type_${b.BenefitType}_unmapped`;
      dropped_reasons[key] = (dropped_reasons[key] || 0) + 1;
      continue;
    }
    // Pre-v2.3.64: category comes only from catMap, no EbenefitCat fallback on the row
    const category = resolvedCatMap[b.CovCatNum] || "GENERAL";
    const coverage_level = COV_LEVEL[b.CoverageLevel] || "None";

    const entry = {
      type,
      category,
      coverage_level,
      benefit_num: b.BenefitNum ?? null,
      cov_cat_num: Number(b.CovCatNum) || 0,
      plan_num: Number(b.PlanNum) || 0,
      pat_plan_num: Number(b.PatPlanNum) || 0,
    };

    if (type === "CoInsurance") {
      entry.percent = Number(b.Percent);
    } else if (type === "Deductible") {
      entry.amount_cents =
        b.MonetaryAmt != null ? Math.round(Number(b.MonetaryAmt) * 100) : null;
    } else if (type === "Limitations") {
      if (b.Quantity != null) {
        entry.quantity = b.Quantity;
        entry.period = TIME_PERIOD[b.TimePeriod] || "None";
      }
      if (b.MonetaryAmt != null && Number(b.MonetaryAmt) > 0) {
        entry.amount_cents = Math.round(Number(b.MonetaryAmt) * 100);
      }
    }
    results.push(entry);
  }

  const filtered = results.filter((b) => {
    if (b.type === "CoInsurance") return b.percent > 0;
    if (b.type === "Deductible") return b.amount_cents != null;
    if (b.type === "Limitations")
      return b.quantity != null || b.amount_cents != null;
    return true;
  });

  filtered._raw_received = rawBenefits.length;
  filtered._dropped = rawBenefits.length - filtered.length;
  filtered._dropped_reasons = dropped_reasons;
  return filtered;
}

// Strips additive-only fields from a benefit-mapper.js entry so we can compare
// against the pre-v2.3.64 inline output without false failures
function stripAdditive(entry) {
  const copy = { ...entry };
  delete copy.ebenefitcat;
  delete copy.category_source;
  return copy;
}

// --- Sample inputs ---
// All use CovCatNum values that map cleanly via COV_CAT_NUM_DEFAULTS.
// EbenefitCat is NOT set on any row — this is the pre-v2.3.64 scenario.
const SAMPLES = [
  // CoInsurance — CovCatNum=2 (PREVENTIVE), 100%
  {
    BenefitNum: 1,
    PlanNum: 9001,
    PatPlanNum: 0,
    BenefitType: 1,
    CovCatNum: 2,
    Percent: "100",
    CoverageLevel: "Individual",
  },
  // CoInsurance — CovCatNum=0 (GENERAL fallback), 80%
  {
    BenefitNum: 2,
    PlanNum: 9001,
    PatPlanNum: 0,
    BenefitType: 1,
    CovCatNum: 0,
    Percent: "80",
    CoverageLevel: "Individual",
  },
  // CoInsurance — CovCatNum=7 (PROSTHODONTIA), 50%
  {
    BenefitNum: 3,
    PlanNum: 9001,
    PatPlanNum: 0,
    BenefitType: 1,
    CovCatNum: 7,
    Percent: "50",
    CoverageLevel: "Individual",
  },
  // Deductible row (no Percent — tested via amount_cents)
  {
    BenefitNum: 4,
    PlanNum: 9001,
    PatPlanNum: 0,
    BenefitType: 2,
    CovCatNum: 0,
    MonetaryAmt: "50",
    CoverageLevel: "Individual",
  },
  // Limitations row — Quantity=2, TimePeriod=2 (CalendarYear)
  {
    BenefitNum: 5,
    PlanNum: 9001,
    PatPlanNum: 0,
    BenefitType: 3,
    CovCatNum: 2,
    Quantity: 2,
    TimePeriod: 2,
    CoverageLevel: "None",
  },
  // Unmapped BenefitType — should be dropped
  {
    BenefitNum: 6,
    PlanNum: 9001,
    PatPlanNum: 0,
    BenefitType: 99,
    CovCatNum: 2,
    Percent: "100",
    CoverageLevel: "Individual",
  },
];

console.log(
  "\nbenefit-mapper.js parity tests (vs inline mapOdApiBenefits baseline)",
);

const defaultCatMap = { ...COV_CAT_NUM_DEFAULTS };
const inlineResult = inlineMapper(SAMPLES, defaultCatMap);
const mapperResult = mapBenefits(SAMPLES, defaultCatMap);

// --- Metadata parity ---
test("_raw_received matches", () => {
  assert.strictEqual(mapperResult._raw_received, inlineResult._raw_received);
});

test("_dropped count matches", () => {
  assert.strictEqual(mapperResult._dropped, inlineResult._dropped);
});

test("_dropped_reasons matches", () => {
  assert.deepStrictEqual(
    mapperResult._dropped_reasons,
    inlineResult._dropped_reasons,
  );
});

test("output array length matches", () => {
  assert.strictEqual(mapperResult.length, inlineResult.length);
});

// --- Per-row parity (ignoring additive fields) ---
for (let i = 0; i < inlineResult.length; i++) {
  const baseline = inlineResult[i];
  const mapped = stripAdditive(mapperResult[i]);
  test(`row[${i}] type=${baseline.type} category=${baseline.category} matches`, () => {
    assert.deepStrictEqual(mapped, baseline);
  });
}

// --- Specific spot checks ---
test("CoInsurance PREVENTIVE (CovCatNum=2) → category=PREVENTIVE, percent=100", () => {
  const row = mapperResult.find(
    (r) => r.cov_cat_num === 2 && r.type === "CoInsurance",
  );
  assert.ok(row, "no PREVENTIVE CoInsurance row");
  assert.strictEqual(row.category, "PREVENTIVE");
  assert.strictEqual(row.percent, 100);
});

test("CoInsurance GENERAL (CovCatNum=0) → category=GENERAL, percent=80", () => {
  const row = mapperResult.find(
    (r) => r.cov_cat_num === 0 && r.type === "CoInsurance",
  );
  assert.ok(row, "no GENERAL CoInsurance row");
  assert.strictEqual(row.category, "GENERAL");
  assert.strictEqual(row.percent, 80);
});

test("Deductible row → amount_cents=5000", () => {
  const row = mapperResult.find((r) => r.type === "Deductible");
  assert.ok(row, "no Deductible row");
  assert.strictEqual(row.amount_cents, 5000);
});

test("Limitations row → quantity=2, period=CalendarYear", () => {
  const row = mapperResult.find((r) => r.type === "Limitations");
  assert.ok(row, "no Limitations row");
  assert.strictEqual(row.quantity, 2);
  assert.strictEqual(row.period, "CalendarYear");
});

test("Unmapped BenefitType=99 dropped (_dropped=1)", () => {
  assert.strictEqual(mapperResult._dropped, 1);
  assert.strictEqual(mapperResult._dropped_reasons["type_99_unmapped"], 1);
});

// --- Additive fields present in mapper output ---
test("category_source field present on CoInsurance rows", () => {
  const row = mapperResult.find((r) => r.type === "CoInsurance");
  assert.ok(row, "no CoInsurance row");
  assert.ok("category_source" in row, "category_source missing");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
