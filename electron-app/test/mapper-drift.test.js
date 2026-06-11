/**
 * Phase 6D-1B — main.js ↔ lib/benefit-mapper.js drift guard (6D-2 finding 4).
 * The parity test compares lib output against a frozen baseline, which cannot
 * catch drift in the LIVE inline mapper. This source-contract check pins the
 * inline mapOdApiBenefits entry construction to the lib's field set, so a
 * field added or renamed in one place but not the other fails CI.
 * Run: node test/mapper-drift.test.js (from electron-app/)
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
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

console.log("\nPhase 6D-1B mapper drift guard");

const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

// Extract the inline mapOdApiBenefits function body from main.js source.
const start = mainSrc.indexOf("function mapOdApiBenefits(");
const end = mainSrc.indexOf("\nasync function syncODData(");
const inlineSrc = mainSrc.slice(start, end);

// The lib's authoritative field set for a CoInsurance entry.
const [libEntry] = mapBenefits(
  [
    {
      BenefitNum: 1,
      PlanNum: 1,
      PatPlanNum: 0,
      BenefitType: 1,
      CovCatNum: 0,
      CodeNum: 87,
      Percent: "80",
      CoverageLevel: "Individual",
    },
  ],
  null,
  { 87: "D1110" },
);
const libKeys = Object.keys(libEntry).filter((k) => k !== "percent");

test("inline mapOdApiBenefits exists and was extracted", () => {
  assert.ok(start > -1, "mapOdApiBenefits not found in main.js");
  // 6D-1C: a lost end anchor would make the window near-whole-file and every
  // per-key check vacuously true — fail hard instead.
  assert.ok(
    end > start,
    "end anchor (syncODData) lost — extraction window invalid",
  );
  assert.ok(inlineSrc.length > 200, "extraction window suspiciously small");
  assert.ok(
    inlineSrc.length < 20000,
    "extraction window suspiciously large — anchors drifted",
  );
});

for (const key of libKeys) {
  test(`inline mapper constructs field "${key}" (lib has it)`, () => {
    assert.ok(
      new RegExp(`${key}\\s*[:,]`).test(inlineSrc),
      `field "${key}" present in lib/benefit-mapper but not in main.js inline mapper`,
    );
  });
}

test("inline mapper guards proc_code with the same null-safe string check as lib", () => {
  assert.ok(
    inlineSrc.includes("typeof odProcCodeCache[code_num]"),
    "inline proc_code lookup lost its typeof-string guard",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
