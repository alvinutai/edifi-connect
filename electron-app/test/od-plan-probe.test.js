/**
 * G-09I: od-plan-probe sanitization tests.
 * Imports from actual production module — not a copy.
 * Run: node test/od-plan-probe.test.js
 */

const assert = require("assert");
const { sanitizeBenefitRow, sanitizeCovcatRow, summarizeBenefitRows } = require("../lib/od-plan-probe");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
}

console.log("\nod-plan-probe sanitization (G-09I)\n");

// ── T1: PatPlanNum > 0 is redacted ───────────────────────────────────────────
test("T1: PatPlanNum > 0 is REDACTED", () => {
  const row = sanitizeBenefitRow({ BenefitNum: 1, PlanNum: 100, PatPlanNum: 5, BenefitType: 1, Percent: 80, CovCatNum: 0, CodeGroupNum: 3, CodeNum: 0, procCode: "" }, 0);
  assert.strictEqual(row.PatPlanNum, "REDACTED");
});

// ── T2: PatPlanNum = 0 is kept ────────────────────────────────────────────────
test("T2: PatPlanNum = 0 is kept (plan-level, not patient)", () => {
  const row = sanitizeBenefitRow({ BenefitNum: 1, PlanNum: 100, PatPlanNum: 0, BenefitType: 1, Percent: 80 }, 0);
  assert.strictEqual(row.PatPlanNum, 0);
});

// ── T3: SubscriberID removed ──────────────────────────────────────────────────
test("T3: SubscriberID removed entirely", () => {
  const row = sanitizeBenefitRow({ BenefitNum: 1, PlanNum: 100, PatPlanNum: 0, SubscriberID: "MBR123456", BenefitType: 1 }, 0);
  assert.ok(!("SubscriberID" in row), "SubscriberID must not appear in output");
});

// ── T4: PatNum removed ────────────────────────────────────────────────────────
test("T4: PatNum removed entirely", () => {
  const row = sanitizeBenefitRow({ BenefitNum: 1, PlanNum: 100, PatPlanNum: 0, PatNum: 9876, BenefitType: 1 }, 0);
  assert.ok(!("PatNum" in row), "PatNum must not appear in output");
});

// ── T5: CodeGroupNum preserved ────────────────────────────────────────────────
test("T5: CodeGroupNum preserved (critical for evidence)", () => {
  const row = sanitizeBenefitRow({ BenefitNum: 1, PlanNum: 100, PatPlanNum: 0, BenefitType: 1, CodeGroupNum: 7, Percent: 50 }, 0);
  assert.strictEqual(row.CodeGroupNum, 7);
});

// ── T6: CodeNum preserved ─────────────────────────────────────────────────────
test("T6: CodeNum preserved", () => {
  const row = sanitizeBenefitRow({ BenefitNum: 1, PlanNum: 100, PatPlanNum: 0, BenefitType: 1, CodeNum: 2740 }, 0);
  assert.strictEqual(row.CodeNum, 2740);
});

// ── T7: procCode preserved ────────────────────────────────────────────────────
test("T7: procCode preserved", () => {
  const row = sanitizeBenefitRow({ BenefitNum: 1, PlanNum: 100, PatPlanNum: 0, BenefitType: 1, procCode: "D2740" }, 0);
  assert.strictEqual(row.procCode, "D2740");
});

// ── T8: Safe plan fields preserved ────────────────────────────────────────────
test("T8: CovCatNum, BenefitType, Percent, CoverageLevel all preserved", () => {
  const row = sanitizeBenefitRow({ BenefitNum: 1, PlanNum: 100, PatPlanNum: 0, CovCatNum: 3, BenefitType: 1, Percent: 80, CoverageLevel: "Individual" }, 0);
  assert.strictEqual(row.CovCatNum, 3);
  assert.strictEqual(row.BenefitType, 1);
  assert.strictEqual(row.Percent, 80);
  assert.strictEqual(row.CoverageLevel, "Individual");
});

// ── T9: All field keys reported in AllKeys ────────────────────────────────────
test("T9: AllKeys field reports original key names", () => {
  const row = sanitizeBenefitRow({ BenefitNum: 1, PlanNum: 100, PatPlanNum: 0, CovCatNum: 0, CodeGroupNum: 3, MyCustomField: "hello" }, 0);
  assert.ok(row.AllKeys.includes("CovCatNum"), "AllKeys should include CovCatNum");
  assert.ok(row.AllKeys.includes("CodeGroupNum"), "AllKeys should include CodeGroupNum");
  assert.ok(row.AllKeys.includes("MyCustomField"), "AllKeys should include unknown fields");
});

// ── T10: BenefitNote free-text: present+length, NOT value ────────────────────
test("T10: BenefitNote returns { present, length } — value not exposed", () => {
  const row = sanitizeBenefitRow({ BenefitNum: 1, PlanNum: 100, PatPlanNum: 0, BenefitType: 1, BenefitNote: "Check with insurer" }, 0);
  assert.ok(typeof row.BenefitNote === "object", "BenefitNote must be an object");
  assert.strictEqual(row.BenefitNote.present, true);
  assert.strictEqual(row.BenefitNote.length, 18);
  assert.ok(!("value" in row.BenefitNote), "value must not appear in BenefitNote output");
});

// ── T11: BenefitNum/PlanNum get synthetic IDs ─────────────────────────────────
test("T11: BenefitNum → synthetic B0, PlanNum → P001", () => {
  const row = sanitizeBenefitRow({ BenefitNum: 99999, PlanNum: 55555, PatPlanNum: 0, BenefitType: 1 }, 0);
  assert.strictEqual(row.BenefitNum, "B0");
  assert.strictEqual(row.PlanNum, "P001");
});

// ── T12: summarizeBenefitRows signal distribution ─────────────────────────────
test("T12: summarizeBenefitRows signal_distribution counts correctly", () => {
  const rows = [
    sanitizeBenefitRow({ BenefitNum: 1, PlanNum: 100, PatPlanNum: 0, BenefitType: "CoInsurance", CovCatNum: 2, CodeGroupNum: 0, CodeNum: 0, procCode: "", Percent: 100 }, 0),
    sanitizeBenefitRow({ BenefitNum: 2, PlanNum: 100, PatPlanNum: 0, BenefitType: "CoInsurance", CovCatNum: 0, CodeGroupNum: 3, CodeNum: 0, procCode: "", Percent: 80 }, 1),
    sanitizeBenefitRow({ BenefitNum: 3, PlanNum: 100, PatPlanNum: 0, BenefitType: "CoInsurance", CovCatNum: 0, CodeGroupNum: 0, CodeNum: 0, procCode: "", Percent: 50 }, 2),
  ];
  const s = summarizeBenefitRows(rows);
  assert.strictEqual(s.signal_distribution.cov_cat_num_nonzero, 1);
  assert.strictEqual(s.signal_distribution.code_group_num_nonzero, 1);
  assert.strictEqual(s.signal_distribution.no_signal, 1);
  assert.strictEqual(s.coinsurance_count, 3);
});

// ── T13: No category names inferred in summary ────────────────────────────────
test("T13: summarizeBenefitRows does not output category name strings", () => {
  const rows = [sanitizeBenefitRow({ BenefitNum: 1, PlanNum: 100, PatPlanNum: 0, BenefitType: "CoInsurance", CovCatNum: 0, CodeGroupNum: 3, Percent: 80 }, 0)];
  const s = summarizeBenefitRows(rows);
  const str = JSON.stringify(s);
  assert.ok(!str.includes("BASIC"), "No BASIC inference");
  assert.ok(!str.includes("ENDODONTIC"), "No ENDODONTIC inference");
  assert.ok(!str.includes("PERIODONTIC"), "No PERIODONTIC inference");
});

// ── T14: Both main.js and bridge.js have READ_OD_PLAN_BENEFITS ────────────────
test("T14: main.js AGENT_CAPABILITIES includes READ_OD_PLAN_BENEFITS", () => {
  const fs = require("fs");
  const main = fs.readFileSync(require("path").join(__dirname, "../main.js"), "utf8");
  assert.ok(main.includes('"READ_OD_PLAN_BENEFITS"'), "main.js must include READ_OD_PLAN_BENEFITS in AGENT_CAPABILITIES");
  assert.ok(main.includes('case "READ_OD_PLAN_BENEFITS"'), "main.js must include case READ_OD_PLAN_BENEFITS in switch");
});

test("T14b: bridge.js AGENT_CAPABILITIES includes READ_OD_PLAN_BENEFITS (parity)", () => {
  const fs = require("fs");
  const bridge = fs.readFileSync(require("path").join(__dirname, "../../service/bridge.js"), "utf8");
  assert.ok(bridge.includes('"READ_OD_PLAN_BENEFITS"'), "bridge.js must include READ_OD_PLAN_BENEFITS in AGENT_CAPABILITIES");
  assert.ok(bridge.includes('case "READ_OD_PLAN_BENEFITS"'), "bridge.js must include case READ_OD_PLAN_BENEFITS in switch");
});

// ── T15: covcat sanitizer keeps all fields ────────────────────────────────────
test("T15: sanitizeCovcatRow keeps all fields (no PHI in covcat)", () => {
  const raw = { CovCatNum: 3, Description: "Restorative", EbenefitCat: 4, IsHidden: false };
  const out = sanitizeCovcatRow(raw);
  assert.deepStrictEqual(out, raw);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
