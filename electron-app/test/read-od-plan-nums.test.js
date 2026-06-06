/**
 * G-09M: READ_OD_PLAN_NUMS sanitizer and parity tests.
 * Imports sanitizers from lib — tests PHI safety and output field contract.
 * Run: node test/read-od-plan-nums.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const {
  sanitizeRestRow,
  sanitizeMysqlRow,
  sanitizeRestRowWithCarrier,
  sanitizeMysqlRowFiltered,
  sanitizeFilter,
} = require("../lib/od-plan-nums");

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

console.log("\nREAD_OD_PLAN_NUMS sanitizer + parity (G-09M)\n");

// ── T1: REST output contains only allowlisted fields ─────────────────────────
test("T1: REST sanitizer outputs only allowlisted fields", () => {
  const raw = {
    PlanNum: 47,
    GroupName: "All Smiles",
    PlanType: "PPO",
    FeeSched: 53,
    PlanNote: "some note",
    GroupNum: 999,
    CarrierNum: 12,
    EmployerNum: 3,
    SecUserNumEntry: 7,
    PatNum: 555,
    SubscriberID: "MBR123",
    PatPlanNum: 1,
    InsSub: "X",
    InsSubNum: 8,
  };
  const out = sanitizeRestRow(raw, 0);
  assert.ok(out !== null);
  const allowed = new Set([
    "row_label",
    "plan_num",
    "carrier_name",
    "group_name",
    "plan_type",
    "fee_sched",
    "plan_note_present",
    "plan_note_length",
  ]);
  for (const k of Object.keys(out)) {
    assert.ok(allowed.has(k), `Unexpected field in REST output: ${k}`);
  }
});

// ── T2: REST carrier_name is always null ─────────────────────────────────────
test("T2: REST sanitizer sets carrier_name to null (REST returns CarrierNum not CarrierName)", () => {
  const out = sanitizeRestRow({ PlanNum: 47, CarrierNum: 12, CarrierName: "Delta" }, 0);
  assert.strictEqual(out.carrier_name, null);
});

// ── T3: GroupName capped at 80 chars ─────────────────────────────────────────
test("T3: REST sanitizer caps GroupName at 80 characters", () => {
  const out = sanitizeRestRow({ PlanNum: 1, GroupName: "A".repeat(120) }, 0);
  assert.strictEqual(out.group_name.length, 80);
});

// ── T4: Nested objects coerced to empty string ───────────────────────────────
test("T4: REST sanitizer coerces nested objects and arrays to empty string", () => {
  const out = sanitizeRestRow(
    { PlanNum: 1, GroupName: { nested: "object" }, PlanType: [1, 2] },
    0,
  );
  assert.strictEqual(out.group_name, "");
  assert.strictEqual(out.plan_type, "");
});

// ── T5: PlanNote stripped — only metadata returned ───────────────────────────
test("T5: REST sanitizer does not expose PlanNote value", () => {
  const out = sanitizeRestRow({ PlanNum: 1, PlanNote: "Call insurer first" }, 0);
  assert.ok(!("PlanNote" in out), "PlanNote must not appear in output");
  assert.strictEqual(out.plan_note_present, true);
  assert.strictEqual(out.plan_note_length, 18);
});

// ── T6: GroupNum not in output ───────────────────────────────────────────────
test("T6: REST sanitizer removes GroupNum", () => {
  const out = sanitizeRestRow({ PlanNum: 1, GroupNum: 7777 }, 0);
  assert.ok(!("GroupNum" in out), "GroupNum must not appear in output");
});

// ── T7: CarrierNum not in output ─────────────────────────────────────────────
test("T7: REST sanitizer removes CarrierNum", () => {
  const out = sanitizeRestRow({ PlanNum: 1, CarrierNum: 12 }, 0);
  assert.ok(!("CarrierNum" in out), "CarrierNum must not appear in output");
});

// ── T8: PHI fields stripped ──────────────────────────────────────────────────
test("T8: REST sanitizer strips EmployerNum, SecUserNumEntry, PatNum, SubscriberID, PatPlanNum, InsSub, InsSubNum", () => {
  const out = sanitizeRestRow(
    {
      PlanNum: 1,
      EmployerNum: 3,
      SecUserNumEntry: 7,
      PatNum: 555,
      SubscriberID: "MBR",
      PatPlanNum: 1,
      InsSub: "X",
      InsSubNum: 8,
    },
    0,
  );
  const forbidden = [
    "EmployerNum",
    "SecUserNumEntry",
    "PatNum",
    "SubscriberID",
    "PatPlanNum",
    "InsSub",
    "InsSubNum",
  ];
  for (const f of forbidden) {
    assert.ok(!(f in out), `${f} must not appear in output`);
  }
});

// ── T9: row_label pattern P001, P002 ─────────────────────────────────────────
test("T9: REST sanitizer row_label is P001 for index 0, P002 for index 1", () => {
  const r0 = sanitizeRestRow({ PlanNum: 10 }, 0);
  const r1 = sanitizeRestRow({ PlanNum: 11 }, 1);
  assert.strictEqual(r0.row_label, "P001");
  assert.strictEqual(r1.row_label, "P002");
});

// ── T10: Null/invalid PlanNum returns null ───────────────────────────────────
test("T10: REST sanitizer returns null for missing, zero, or negative PlanNum", () => {
  assert.strictEqual(sanitizeRestRow({ PlanNum: 0, GroupName: "X" }, 0), null);
  assert.strictEqual(sanitizeRestRow({ GroupName: "X" }, 0), null);
  assert.strictEqual(sanitizeRestRow({ PlanNum: -1 }, 0), null);
  assert.strictEqual(sanitizeRestRow(null, 0), null);
});

// ── T11: MySQL carrier_name populated from join ───────────────────────────────
test("T11: MySQL sanitizer populates carrier_name from CarrierName column", () => {
  const out = sanitizeMysqlRow(
    {
      PlanNum: 47,
      CarrierName: "MetLife PPO",
      GroupName: "All Smiles",
      FeeSched: 53,
      PlanType: "PPO",
      PlanNotePresent: 0,
      PlanNoteLength: 0,
    },
    0,
  );
  assert.strictEqual(out.carrier_name, "MetLife PPO");
});

// ── T12: MySQL PlanNotePresent=1 → true ──────────────────────────────────────
test("T12: MySQL sanitizer maps PlanNotePresent=1 to plan_note_present=true", () => {
  const out = sanitizeMysqlRow(
    { PlanNum: 1, PlanNotePresent: 1, PlanNoteLength: 42 },
    0,
  );
  assert.strictEqual(out.plan_note_present, true);
  assert.strictEqual(out.plan_note_length, 42);
});

// ── T13: MySQL PlanNotePresent=0 → false ─────────────────────────────────────
test("T13: MySQL sanitizer maps PlanNotePresent=0 to plan_note_present=false", () => {
  const out = sanitizeMysqlRow(
    { PlanNum: 1, PlanNotePresent: 0, PlanNoteLength: 0 },
    0,
  );
  assert.strictEqual(out.plan_note_present, false);
  assert.strictEqual(out.plan_note_length, 0);
});

// ── T14: Parity — both runtimes advertise and handle the command ──────────────
test("T14: bridge.js AGENT_CAPABILITIES includes READ_OD_PLAN_NUMS", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../service/bridge.js"),
    "utf8",
  );
  assert.ok(
    src.includes('"READ_OD_PLAN_NUMS"'),
    "bridge.js must include READ_OD_PLAN_NUMS in AGENT_CAPABILITIES",
  );
  assert.ok(
    src.includes('case "READ_OD_PLAN_NUMS"'),
    "bridge.js must include case READ_OD_PLAN_NUMS in switch",
  );
});

test("T14b: main.js AGENT_CAPABILITIES includes READ_OD_PLAN_NUMS (parity)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  assert.ok(
    src.includes('"READ_OD_PLAN_NUMS"'),
    "main.js must include READ_OD_PLAN_NUMS in AGENT_CAPABILITIES",
  );
  assert.ok(
    src.includes('case "READ_OD_PLAN_NUMS"'),
    "main.js must include case READ_OD_PLAN_NUMS in switch",
  );
});

// ── T15: MySQL query uses CHAR_LENGTH, not bare LENGTH ───────────────────────
test("T15: bridge.js MySQL query uses CHAR_LENGTH (not bare LENGTH)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../service/bridge.js"),
    "utf8",
  );
  const idx = src.indexOf("async function handleReadOdPlanNums");
  assert.ok(idx > -1, "async function handleReadOdPlanNums must exist in bridge.js");
  const handlerSrc = src.slice(idx, idx + 12000);
  assert.ok(
    handlerSrc.includes("CHAR_LENGTH"),
    "bridge.js handler must use CHAR_LENGTH",
  );
  // Remove CHAR_LENGTH occurrences, then confirm no bare LENGTH( remains
  const stripped = handlerSrc.replace(/CHAR_LENGTH/g, "CHARLEN");
  assert.ok(
    !stripped.includes("LENGTH("),
    "bridge.js handler must not use bare LENGTH()",
  );
});

test("T15b: main.js MySQL query uses CHAR_LENGTH (not bare LENGTH)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const idx = src.indexOf("async function handleReadOdPlanNums");
  assert.ok(idx > -1, "async function handleReadOdPlanNums must exist in main.js");
  const handlerSrc = src.slice(idx, idx + 12000);
  assert.ok(
    handlerSrc.includes("CHAR_LENGTH"),
    "main.js handler must use CHAR_LENGTH",
  );
  const stripped = handlerSrc.replace(/CHAR_LENGTH/g, "CHARLEN");
  assert.ok(
    !stripped.includes("LENGTH("),
    "main.js handler must not use bare LENGTH()",
  );
});

// ── T16: REST rows capped at 100 ─────────────────────────────────────────────
test("T16: bridge.js REST path caps rows at 100 via .slice(0, 100)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../service/bridge.js"),
    "utf8",
  );
  const idx = src.indexOf("async function handleReadOdPlanNums");
  const handlerSrc = src.slice(idx, idx + 5000);
  assert.ok(
    handlerSrc.includes(".slice(0, 100)"),
    "bridge.js REST path must slice to 100",
  );
});

// ── T17: MySQL sanitizer returns null for invalid PlanNum ────────────────────
test("T17: MySQL sanitizer returns null for zero or non-integer PlanNum", () => {
  assert.strictEqual(sanitizeMysqlRow({ PlanNum: 0 }, 0), null);
  assert.strictEqual(sanitizeMysqlRow({ PlanNum: -5 }, 0), null);
  assert.strictEqual(sanitizeMysqlRow(null, 0), null);
});

// ── T18: REST empty PlanNote → plan_note_present false ───────────────────────
test("T18: REST sanitizer: empty PlanNote string → plan_note_present false, length 0", () => {
  const out = sanitizeRestRow({ PlanNum: 1, PlanNote: "" }, 0);
  assert.strictEqual(out.plan_note_present, false);
  assert.strictEqual(out.plan_note_length, 0);
});

// ── CF1: sanitizeFilter strips non-allowed characters ────────────────────────
test("CF1: sanitizeFilter strips chars outside alphanumeric/space/hyphen/period", () => {
  const result = sanitizeFilter("met<script>life!@#$%^&*()=+[]{}|;:'\",<>?/\\~`");
  assert.ok(!result.includes("<"), "< must be stripped");
  assert.ok(!result.includes(">"), "> must be stripped");
  assert.ok(!result.includes("!"), "! must be stripped");
  assert.ok(result.includes("met"), "alphanumeric content must survive");
  assert.ok(result.includes("life"), "alphanumeric content must survive");
});

// ── CF2: sanitizeFilter lowercases output ─────────────────────────────────────
test("CF2: sanitizeFilter lowercases the result", () => {
  const result = sanitizeFilter("MetLife PPO");
  assert.strictEqual(result, "metlife ppo");
});

// ── CF3: sanitizeFilter trims whitespace ──────────────────────────────────────
test("CF3: sanitizeFilter trims leading and trailing whitespace", () => {
  const result = sanitizeFilter("  metlife  ");
  assert.strictEqual(result, "metlife");
});

// ── CF4: sanitizeFilter caps at 80 characters ─────────────────────────────────
test("CF4: sanitizeFilter output is at most 80 characters", () => {
  const result = sanitizeFilter("a".repeat(120));
  assert.ok(result.length <= 80, "output must be at most 80 chars");
});

// ── CF5: sanitizeFilter returns empty string for null/non-string ──────────────
test("CF5: sanitizeFilter returns empty string for null, undefined, number, object", () => {
  assert.strictEqual(sanitizeFilter(null), "");
  assert.strictEqual(sanitizeFilter(undefined), "");
  assert.strictEqual(sanitizeFilter(42), "");
  assert.strictEqual(sanitizeFilter({}), "");
});

// ── CF6: sanitizeRestRowWithCarrier sets resolved carrier_name ────────────────
test("CF6: sanitizeRestRowWithCarrier populates carrier_name from resolvedCarrierName", () => {
  const out = sanitizeRestRowWithCarrier(
    { PlanNum: 47, GroupName: "All Smiles", PlanType: "PPO", FeeSched: 53 },
    0,
    "MetLife PPO",
    "carrier_name",
  );
  assert.strictEqual(out.carrier_name, "MetLife PPO");
});

// ── CF7: sanitizeRestRowWithCarrier includes match_source ─────────────────────
test("CF7: sanitizeRestRowWithCarrier includes match_source field", () => {
  const out = sanitizeRestRowWithCarrier(
    { PlanNum: 1 },
    0,
    "MetLife",
    "carrier_name",
  );
  assert.ok("match_source" in out, "match_source must be present");
  assert.strictEqual(out.match_source, "carrier_name");
});

// ── CF8: sanitizeRestRowWithCarrier output allowlist ──────────────────────────
test("CF8: sanitizeRestRowWithCarrier output has no CarrierNum, adds match_source to allowlist", () => {
  const out = sanitizeRestRowWithCarrier(
    { PlanNum: 1, CarrierNum: 12, CarrierName: "Delta", GroupNum: 5 },
    0,
    "MetLife",
    "carrier_name",
  );
  assert.ok(!("CarrierNum" in out), "CarrierNum must not appear");
  assert.ok(!("GroupNum" in out), "GroupNum must not appear");
  assert.ok("match_source" in out, "match_source must appear");
  assert.ok("carrier_name" in out, "carrier_name must appear");
});

// ── CF9: sanitizeRestRowWithCarrier null resolvedCarrierName → null ───────────
test("CF9: sanitizeRestRowWithCarrier with null resolvedCarrierName produces null carrier_name", () => {
  const out = sanitizeRestRowWithCarrier({ PlanNum: 1 }, 0, null, "group_name");
  assert.strictEqual(out.carrier_name, null);
  assert.strictEqual(out.match_source, "group_name");
});

// ── CF10: sanitizeMysqlRowFiltered adds match_source ─────────────────────────
test("CF10: sanitizeMysqlRowFiltered includes match_source in output", () => {
  const out = sanitizeMysqlRowFiltered(
    {
      PlanNum: 47,
      CarrierName: "MetLife PPO",
      GroupName: "All Smiles",
      FeeSched: 53,
      PlanType: "PPO",
      PlanNotePresent: 0,
      PlanNoteLength: 0,
    },
    0,
    "carrier_name",
  );
  assert.strictEqual(out.match_source, "carrier_name");
  assert.strictEqual(out.carrier_name, "MetLife PPO");
});

// ── CF11: bridge.js filtered REST cap is post-filter (matched.length >= 100) ──
test("CF11: bridge.js filtered REST path uses post-filter cap (matched.length >= 100)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../service/bridge.js"),
    "utf8",
  );
  const idx = src.indexOf("async function handleReadOdPlanNums");
  const handlerSrc = src.slice(idx, idx + 12000);
  assert.ok(
    handlerSrc.includes("matched.length >= 100"),
    "bridge.js must cap filtered results at 100 post-filter using matched.length >= 100",
  );
});

// ── CF12: bridge.js carrier lookup uses 2000ms timeout ───────────────────────
test("CF12: bridge.js carrier resolution uses timeout: 2000 (not odGet 8000ms path)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../service/bridge.js"),
    "utf8",
  );
  const idx = src.indexOf("async function handleReadOdPlanNums");
  const handlerSrc = src.slice(idx, idx + 12000);
  assert.ok(
    handlerSrc.includes("timeout: 2000"),
    "bridge.js carrier resolution must use timeout: 2000",
  );
});

// ── CF13: sanitizeFilter preserves hyphens and spaces ────────────────────────
test("CF13: sanitizeFilter preserves hyphens and spaces (needed for carrier names)", () => {
  const result = sanitizeFilter("delta-dental");
  assert.ok(result.includes("-"), "hyphen must survive sanitizeFilter");
  const result2 = sanitizeFilter("united healthcare");
  assert.ok(result2.includes(" "), "space must survive sanitizeFilter");
});

// ── CF14: bridge.js MySQL filtered query uses LIMIT 1000 ─────────────────────
test("CF14: bridge.js MySQL filtered query uses LIMIT 1000 (not 100)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../service/bridge.js"),
    "utf8",
  );
  const idx = src.indexOf("async function handleReadOdPlanNums");
  const handlerSrc = src.slice(idx, idx + 12000);
  assert.ok(
    handlerSrc.includes("LIMIT 1000"),
    "bridge.js filtered MySQL path must use LIMIT 1000",
  );
});

// ── CF15: bridge.js MySQL filtered query uses parameterized placeholders ──────
test("CF15: bridge.js MySQL filtered query uses ? placeholders (no string interpolation)", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "../../service/bridge.js"),
    "utf8",
  );
  const idx = src.indexOf("async function handleReadOdPlanNums");
  const handlerSrc = src.slice(idx, idx + 12000);
  assert.ok(
    handlerSrc.includes("LIKE ?"),
    "bridge.js filtered MySQL path must use parameterized ? for LIKE clause",
  );
  // filterParam must be passed as array param, not interpolated into SQL string
  assert.ok(
    handlerSrc.includes("filterParam"),
    "bridge.js must use filterParam variable passed as query parameter",
  );
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
