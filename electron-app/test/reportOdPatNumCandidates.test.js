// Tests for REPORT_OD_PATNUM_CANDIDATES extraction logic.
// Run: node test/reportOdPatNumCandidates.test.js

const assert = require("assert");
const { extractPatNumCandidates } = require("../lib/od-patnum-candidates");

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

console.log("\nextractPatNumCandidates");

// T1 — PHI fields in appointment object are ignored; only PatNum returned
test("PHI fields are not read or returned — only PatNum extracted", () => {
  const apts = [[{
    AptStatus: "Scheduled",
    PatNum: 42,
    FName: "Jane",
    LName: "Doe",
    Birthdate: "1990-01-01",
    HmPhone: "555-1234",
    Address: "123 Main St",
    Email: "jane@example.com",
    SubscriberID: "XYZ999",
    InsSub: { InsSubNum: 7 },
    PlanNote: "SECRET PLAN NOTES",
  }]];
  const result = extractPatNumCandidates(apts);
  assert.deepStrictEqual(result, [42]);
  assert.strictEqual(result.length, 1);
  // Confirm no PHI leaks into the returned array elements
  assert.ok(result.every(n => typeof n === "number"));
});

// T2 — Duplicates removed across multiple date arrays
test("Duplicate PatNums deduplicated across date arrays", () => {
  const day1 = [{ AptStatus: "Scheduled", PatNum: 100 }];
  const day2 = [
    { AptStatus: "Scheduled", PatNum: 100 },
    { AptStatus: "Scheduled", PatNum: 200 },
  ];
  const result = extractPatNumCandidates([day1, day2]);
  assert.deepStrictEqual(result, [100, 200]);
});

// T3 — Non-Scheduled statuses filtered (Complete, Broken, etc.)
test("Non-Scheduled AptStatus values are excluded", () => {
  const apts = [[
    { AptStatus: "Complete",     PatNum: 1 },
    { AptStatus: 2,              PatNum: 2 },
    { AptStatus: "2",            PatNum: 3 },
    { AptStatus: "Broken",       PatNum: 4 },
    { AptStatus: "Unscheduled",  PatNum: 5 },
    { AptStatus: "Scheduled",    PatNum: 99 },
  ]];
  const result = extractPatNumCandidates(apts);
  assert.deepStrictEqual(result, [99]);
});

// T4 — Max 10 enforced
test("Max 10 candidates returned even when more are available", () => {
  const apts = [Array.from({ length: 20 }, (_, i) => ({
    AptStatus: "Scheduled",
    PatNum: i + 1,
  }))];
  const result = extractPatNumCandidates(apts);
  assert.strictEqual(result.length, 10);
  assert.deepStrictEqual(result, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

// T5 — Non-positive PatNums rejected
test("Zero and negative PatNums rejected", () => {
  const apts = [[
    { AptStatus: "Scheduled", PatNum: 0 },
    { AptStatus: "Scheduled", PatNum: -1 },
    { AptStatus: "Scheduled", PatNum: -999 },
    { AptStatus: "Scheduled", PatNum: 7 },
  ]];
  const result = extractPatNumCandidates(apts);
  assert.deepStrictEqual(result, [7]);
});

// T6 — Non-numeric PatNums rejected
test("Non-numeric PatNums (null, undefined, string) rejected", () => {
  const apts = [[
    { AptStatus: "Scheduled", PatNum: null },
    { AptStatus: "Scheduled", PatNum: undefined },
    { AptStatus: "Scheduled", PatNum: "abc" },
    { AptStatus: "Scheduled", PatNum: "" },
    { AptStatus: "Scheduled", PatNum: NaN },
    { AptStatus: "Scheduled", PatNum: 55 },
  ]];
  const result = extractPatNumCandidates(apts);
  assert.deepStrictEqual(result, [55]);
});

// T7 — Integer-as-string PatNum accepted
test("PatNum as numeric string '123' accepted as integer 123", () => {
  const apts = [[{ AptStatus: "Scheduled", PatNum: "123" }]];
  const result = extractPatNumCandidates(apts);
  assert.deepStrictEqual(result, [123]);
  assert.strictEqual(typeof result[0], "number");
});

// T8 — AptStatus integer 1 treated as Scheduled
test("AptStatus=1 (integer) treated as Scheduled", () => {
  const apts = [[
    { AptStatus: 1,   PatNum: 11 },
    { AptStatus: "1", PatNum: 22 },
  ]];
  const result = extractPatNumCandidates(apts);
  assert.deepStrictEqual(result, [11, 22]);
});

// T9 — Empty/null arrays handled safely
test("Empty or null arrays return empty result without throwing", () => {
  assert.doesNotThrow(() => {
    const r1 = extractPatNumCandidates([]);
    assert.deepStrictEqual(r1, []);
    const r2 = extractPatNumCandidates([null, [], null]);
    assert.deepStrictEqual(r2, []);
  });
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
