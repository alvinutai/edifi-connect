/**
 * OD Benefit Replay Harness — 5 scenario tests
 *
 * Proves:
 *   T-Sandbox        : well-configured plan produces all key categories via CovCatNum
 *   T-PilotOffice-WithEben : CovCatNum=0 + EbenefitCat present → BASIC/ENDO/PERIO appear
 *   T-PilotOffice-NoEben   : CovCatNum=0 + EbenefitCat absent → those rows stay GENERAL
 *   T-EbenFallback       : CovCatNum=0 + EbenefitCat=4 → BASIC (v2.3.64 path works)
 *   T-NoEbenFallback     : CovCatNum=0 + EbenefitCat absent → GENERAL (field is required)
 *
 * Run: node tools/od-benefit-replay/harness.test.js (from C:\Users\elite\edifi-connect\)
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const {
  buildCatMap,
  mapBenefits,
} = require("../../electron-app/lib/benefit-mapper");

const FIXTURE_DIR = path.join(__dirname, "fixtures");

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

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), "utf8"));
}

function coverageMatrix(fixture) {
  const catMap = buildCatMap(fixture.covcat);
  const mapped = mapBenefits(fixture.benefits, catMap);
  const coinRows = mapped.filter(
    (r) =>
      r.type === "CoInsurance" &&
      r.percent > 0 &&
      r.coverage_level !== "Family",
  );
  const best = {};
  for (const r of coinRows) {
    if (!best[r.category] || r.percent > best[r.category].percent)
      best[r.category] = r;
  }
  return Object.values(best);
}

console.log("\nOD Benefit Replay Harness");

// --- T-Sandbox ---
console.log("\nT-Sandbox: sandbox plan with correct CovCatNum mappings");
{
  const f = loadFixture("sandbox.json");
  const matrix = coverageMatrix(f);
  const cats = new Set(matrix.map((r) => r.category));

  test("T-Sandbox: PREVENTIVE present", () =>
    assert.ok(cats.has("PREVENTIVE"), "PREVENTIVE missing"));
  test("T-Sandbox: BASIC present", () =>
    assert.ok(cats.has("BASIC"), "BASIC missing"));
  test("T-Sandbox: ENDODONTIC present", () =>
    assert.ok(cats.has("ENDODONTIC"), "ENDODONTIC missing"));
  test("T-Sandbox: PERIODONTIC present", () =>
    assert.ok(cats.has("PERIODONTIC"), "PERIODONTIC missing"));
  test("T-Sandbox: ORAL_SURGERY present", () =>
    assert.ok(cats.has("ORAL_SURGERY"), "ORAL_SURGERY missing"));
  test("T-Sandbox: MAJOR present", () =>
    assert.ok(cats.has("MAJOR"), "MAJOR missing"));
  test("T-Sandbox: GENERAL not in matrix", () =>
    assert.ok(
      !cats.has("GENERAL"),
      "unexpected GENERAL — sandbox should fully resolve",
    ));
  test("T-Sandbox: category_source=CovCatNum for all", () => {
    const nonCovCat = matrix.filter((r) => r.category_source !== "CovCatNum");
    assert.strictEqual(
      nonCovCat.length,
      0,
      `expected all CovCatNum, got: ${JSON.stringify(nonCovCat.map((r) => r.category_source))}`,
    );
  });
}

// --- T-PilotOffice-WithEben ---
console.log(
  "\nT-PilotOffice-WithEben: Carrier A pattern — CovCatNum=0 but EbenefitCat present",
);
{
  const f = loadFixture("pilot-office-with-eben.json");
  const matrix = coverageMatrix(f);
  const cats = new Set(matrix.map((r) => r.category));
  const ebenRows = matrix.filter((r) => r.category_source === "EbenefitCat");

  test("T-PilotOffice-WithEben: BASIC present", () =>
    assert.ok(
      cats.has("BASIC"),
      "BASIC missing — EbenefitCat=4 should resolve",
    ));
  test("T-PilotOffice-WithEben: ENDODONTIC present", () =>
    assert.ok(
      cats.has("ENDODONTIC"),
      "ENDODONTIC missing — EbenefitCat=5 should resolve",
    ));
  test("T-PilotOffice-WithEben: PERIODONTIC present", () =>
    assert.ok(
      cats.has("PERIODONTIC"),
      "PERIODONTIC missing — EbenefitCat=6 should resolve",
    ));
  test("T-PilotOffice-WithEben: ORAL_SURGERY present", () =>
    assert.ok(
      cats.has("ORAL_SURGERY"),
      "ORAL_SURGERY missing — EbenefitCat=7 should resolve",
    ));
  test("T-PilotOffice-WithEben: at least one EbenefitCat-sourced row", () =>
    assert.ok(
      ebenRows.length > 0,
      "no EbenefitCat rows — v2.3.64 path not triggered",
    ));
  test("T-PilotOffice-WithEben: GENERAL count is 0 for named key categories", () => {
    const generalCount = matrix.filter((r) => r.category === "GENERAL").length;
    assert.strictEqual(
      generalCount,
      0,
      `${generalCount} rows stuck at GENERAL despite EbenefitCat being present`,
    );
  });
}

// --- T-PilotOffice-NoEben ---
console.log(
  "\nT-PilotOffice-NoEben: Carrier A pattern — CovCatNum=0, EbenefitCat ABSENT",
);
{
  const f = loadFixture("pilot-office-no-eben.json");
  const matrix = coverageMatrix(f);
  const cats = new Set(matrix.map((r) => r.category));

  test("T-PilotOffice-NoEben: BASIC absent (stuck at GENERAL)", () =>
    assert.ok(
      !cats.has("BASIC"),
      "BASIC appeared without EbenefitCat — unexpected",
    ));
  test("T-PilotOffice-NoEben: ENDODONTIC absent (stuck at GENERAL)", () =>
    assert.ok(
      !cats.has("ENDODONTIC"),
      "ENDODONTIC appeared without EbenefitCat — unexpected",
    ));
  test("T-PilotOffice-NoEben: PERIODONTIC absent (stuck at GENERAL)", () =>
    assert.ok(
      !cats.has("PERIODONTIC"),
      "PERIODONTIC appeared without EbenefitCat — unexpected",
    ));
  test("T-PilotOffice-NoEben: GENERAL present (unmapped rows accumulate here)", () =>
    assert.ok(
      cats.has("GENERAL"),
      "expected GENERAL to be present for CovCatNum=0 rows",
    ));
  test("T-PilotOffice-NoEben: no EbenefitCat-sourced rows", () => {
    const ebenRows = matrix.filter((r) => r.category_source === "EbenefitCat");
    assert.strictEqual(
      ebenRows.length,
      0,
      `${ebenRows.length} EbenefitCat rows appeared despite field being absent`,
    );
  });
}

// --- T-EbenFallback (unit) ---
console.log(
  "\nT-EbenFallback: CovCatNum=0 + EbenefitCat=4 → BASIC (v2.3.64 path)",
);
{
  const singleRow = [
    {
      BenefitNum: 1,
      PlanNum: 9001,
      PatPlanNum: 0,
      BenefitType: 1,
      CovCatNum: 0,
      Percent: "80",
      CoverageLevel: "Individual",
      EbenefitCat: 4,
    },
  ];
  const mapped = mapBenefits(singleRow, {});

  test("T-EbenFallback: category=BASIC", () =>
    assert.strictEqual(mapped[0].category, "BASIC"));
  test("T-EbenFallback: category_source=EbenefitCat", () =>
    assert.strictEqual(mapped[0].category_source, "EbenefitCat"));
  test("T-EbenFallback: ebenefitcat=4", () =>
    assert.strictEqual(mapped[0].ebenefitcat, 4));
}

// --- T-NoEbenFallback (unit) ---
console.log("\nT-NoEbenFallback: CovCatNum=0 + EbenefitCat absent → GENERAL");
{
  const singleRow = [
    {
      BenefitNum: 1,
      PlanNum: 9001,
      PatPlanNum: 0,
      BenefitType: 1,
      CovCatNum: 0,
      Percent: "80",
      CoverageLevel: "Individual",
    },
  ];
  const mapped = mapBenefits(singleRow, {});

  test("T-NoEbenFallback: category=GENERAL", () =>
    assert.strictEqual(mapped[0].category, "GENERAL"));
  test("T-NoEbenFallback: category_source=fallback", () =>
    assert.strictEqual(mapped[0].category_source, "fallback"));
  test("T-NoEbenFallback: ebenefitcat=null (absent field → null)", () =>
    assert.strictEqual(mapped[0].ebenefitcat, null));
}

// --- T-CodeNum (Phase 6D-1) ---
console.log(
  "\nT-CodeNum: Pilot Office shape + CodeNum forwarding — UNMAPPED→mappable conversion",
);
{
  const f = loadFixture("pilot-office-codenum.json");
  const catMap = buildCatMap(f.covcat);
  const mapped = mapBenefits(f.benefits, catMap, f.proccodes);
  const coin = mapped.filter((r) => r.type === "CoInsurance");
  const lims = mapped.filter((r) => r.type === "Limitations");

  test("T-CodeNum: all 9 CoInsurance rows survive mapping", () =>
    assert.strictEqual(coin.length, 9));
  test("T-CodeNum: 5 of 6 CovCatNum=0 coverage rows now carry proc_code", () => {
    const zeroRows = coin.filter((r) => r.cov_cat_num === 0);
    const withProc = zeroRows.filter((r) => r.proc_code != null);
    assert.strictEqual(zeroRows.length, 6);
    assert.strictEqual(withProc.length, 5); // row 309 is a true blank (CodeNum=0)
  });
  test("T-CodeNum: resolved proc codes are the expected CDT strings", () => {
    const procs = coin
      .map((r) => r.proc_code)
      .filter(Boolean)
      .sort();
    assert.deepStrictEqual(procs, [
      "D0220",
      "D0274",
      "D1110",
      "D2750",
      "D3310",
    ]);
  });
  test("T-CodeNum: true-blank row (CovCatNum=0, CodeNum=0) stays unresolvable", () => {
    const blank = coin.find((r) => r.benefit_num === 309);
    assert.strictEqual(blank.code_num, null);
    assert.strictEqual(blank.proc_code, null);
    assert.strictEqual(blank.category, "GENERAL");
  });
  test("T-CodeNum: category-attached rows unchanged (CovCat precedence intact)", () => {
    const prev = coin.find((r) => r.benefit_num === 301);
    assert.strictEqual(prev.category, "PREVENTIVE");
    assert.strictEqual(prev.code_num, null);
  });
  test("T-CodeNum: frequency rows carry proc_code (D1110 2x/yr, D4341 4x/yr)", () => {
    const freq = lims.map((r) => [r.proc_code, r.quantity]);
    assert.deepStrictEqual(freq.sort(), [
      ["D1110", 2],
      ["D4341", 4],
    ]);
  });
  test("T-CodeNum: conversion summary — 7 of 8 previously-unmappable rows unlocked", () => {
    // 6 CovCatNum=0 coverage rows + 2 CovCatNum=0 frequency rows = 8 blocked pre-6D.
    // With proc_code: 5 coverage + 2 frequency = 7 resolvable by the backend CDT
    // rung; 1 true blank remains honestly unmapped.
    const blocked = mapped.filter((r) => r.cov_cat_num === 0);
    const unlocked = blocked.filter((r) => r.proc_code != null);
    assert.strictEqual(blocked.length, 8);
    assert.strictEqual(unlocked.length, 7);
  });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
