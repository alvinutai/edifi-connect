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
  sanitizePatNum,
  sanitizePatientPlanRestRow,
  sanitizePatientPlanMysqlRow,
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

// ── PP1: sanitizePatNum rejects invalid inputs ────────────────────────────────
test("PP1: sanitizePatNum rejects 0, negative, float, string, null, undefined", () => {
  const bad = [0, -1, -100, 1.5, "abc", "47", "0", null, undefined, {}, []];
  for (const v of bad) {
    assert.throws(() => sanitizePatNum(v), /INVALID_PAT_NUM/, `Expected throw for: ${JSON.stringify(v)}`);
  }
});

// ── PP2: sanitizePatNum accepts positive integer ──────────────────────────────
test("PP2: sanitizePatNum accepts positive integer and returns integer", () => {
  assert.strictEqual(sanitizePatNum(1), 1);
  assert.strictEqual(sanitizePatNum(99999), 99999);
  assert.strictEqual(typeof sanitizePatNum(42), "number");
});

// ── PP3: sanitizePatientPlanRestRow strips PHI fields ────────────────────────
test("PP3: sanitizePatientPlanRestRow strips PatPlanNum, InsSubNum, SubscriberID, PatNum from output", () => {
  const insplan = { GroupName: "All Smiles", PlanType: "PPO", FeeSched: 53, CarrierNum: 12, SubscriberID: "MBR123", PatNum: 555, PatPlanNum: 1, InsSubNum: 8 };
  const out = sanitizePatientPlanRestRow(insplan, 0, 1, 47, "MetLife PPO");
  assert.ok(!("PatPlanNum" in out), "PatPlanNum must not appear");
  assert.ok(!("InsSubNum" in out), "InsSubNum must not appear");
  assert.ok(!("SubscriberID" in out), "SubscriberID must not appear");
  assert.ok(!("PatNum" in out), "PatNum must not appear");
  assert.ok(!("CarrierNum" in out), "CarrierNum must not appear");
});

// ── PP4: sanitizePatientPlanRestRow includes ordinal and plan_num ─────────────
test("PP4: sanitizePatientPlanRestRow includes ordinal and plan_num", () => {
  const out = sanitizePatientPlanRestRow({ GroupName: "X", PlanType: "PPO", FeeSched: 0 }, 0, 1, 47, "MetLife");
  assert.strictEqual(out.ordinal, 1);
  assert.strictEqual(out.plan_num, 47);
});

// ── PP5: is_metlife_match true for MetLife variants ──────────────────────────
test("PP5: is_metlife_match true when carrier_name is Metlife, MetLife, METLIFE", () => {
  for (const name of ["Metlife", "MetLife", "METLIFE", "MetLife PPO", "metlife"]) {
    const out = sanitizePatientPlanRestRow({ GroupName: "X" }, 0, 1, 47, name);
    assert.strictEqual(out.is_metlife_match, true, `Expected match for: ${name}`);
    assert.strictEqual(out.match_source, "carrier_name");
  }
});

// ── PP6: is_metlife_match false for non-MetLife carriers ─────────────────────
test("PP6: is_metlife_match false for Delta Dental", () => {
  const out = sanitizePatientPlanRestRow({ GroupName: "X" }, 0, 1, 47, "Delta Dental");
  assert.strictEqual(out.is_metlife_match, false);
  assert.strictEqual(out.match_source, null);
});

// ── PP7: Result caps at 20 plans ─────────────────────────────────────────────
test("PP7: sanitizePatientPlanMysqlRow row_label for 20th row is P020", () => {
  const row = { PlanNum: 999, CarrierName: "Delta", GroupName: "G", PlanType: "PPO", FeeSched: 0, PlanNotePresent: 0, PlanNoteLength: 0, Ordinal: 2 };
  const out = sanitizePatientPlanMysqlRow(row, 19);
  assert.strictEqual(out.row_label, "P020");
});

// ── PP8: main.js calls /patplans?PatNum= not /patients/{patNum}/insplans ─────
test("PP8: main.js source confirms /patplans?PatNum= is used (not /patients/{patNum}/insplans)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const idx = src.indexOf("async function handleReadOdPatientPlan");
  assert.ok(idx > -1, "async function handleReadOdPatientPlan must exist in main.js");
  const handlerSrc = src.slice(idx, idx + 8000);
  assert.ok(handlerSrc.includes("/patplans?PatNum="), "main.js handler must use /patplans?PatNum=");
  assert.ok(!handlerSrc.includes("/patients/"), "main.js handler must NOT use /patients/{patNum}/insplans");
});

// ── PP9: bridge.js parity — same endpoint as main.js ─────────────────────────
test("PP9: bridge.js source confirms /patplans?PatNum= is used and parity with main.js", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../service/bridge.js"), "utf8");
  const idx = src.indexOf("async function handleReadOdPatientPlan");
  assert.ok(idx > -1, "async function handleReadOdPatientPlan must exist in bridge.js");
  const handlerSrc = src.slice(idx, idx + 8000);
  assert.ok(handlerSrc.includes("/patplans?PatNum="), "bridge.js handler must use /patplans?PatNum=");
  assert.ok(!handlerSrc.includes("/patients/"), "bridge.js handler must NOT use /patients/{patNum}/insplans");
});

// ── PP10: carrier resolution uses timeout: 2000 ───────────────────────────────
test("PP10: main.js handleReadOdPatientPlan carrier resolution uses timeout: 2000", () => {
  const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const idx = src.indexOf("async function handleReadOdPatientPlan");
  const handlerSrc = src.slice(idx, idx + 8000);
  assert.ok(handlerSrc.includes("timeout: 2000"), "carrier resolution must use timeout: 2000");
});

// ── PP11: MySQL query uses ? placeholder ──────────────────────────────────────
test("PP11: main.js MySQL query uses ? placeholder for PatNum (not string interpolation)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const idx = src.indexOf("async function handleReadOdPatientPlan");
  const handlerSrc = src.slice(idx, idx + 8000);
  assert.ok(handlerSrc.includes("WHERE pp.PatNum = ?"), "MySQL must use parameterized ? for PatNum");
});

// ── PP12: MySQL query has LIMIT 20 ───────────────────────────────────────────
test("PP12: main.js MySQL query has LIMIT 20", () => {
  const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const idx = src.indexOf("async function handleReadOdPatientPlan");
  const handlerSrc = src.slice(idx, idx + 8000);
  assert.ok(handlerSrc.includes("LIMIT 20"), "MySQL query must have LIMIT 20");
});

// ── PP13: pat_num absent from sanitized result ────────────────────────────────
test("PP13: sanitizePatientPlanRestRow does not include pat_num in output", () => {
  const out = sanitizePatientPlanRestRow({ GroupName: "X" }, 0, 1, 47, "MetLife");
  assert.ok(!("pat_num" in out), "pat_num must not appear in output (plan_num is the allowed field)");
  assert.ok("plan_num" in out, "plan_num must appear in output");
});

// ── PP14: is_metlife_match survives sanitizePatientPlanMysqlRow ───────────────
test("PP14: sanitizePatientPlanMysqlRow is_metlife_match is true for MetLife carrier", () => {
  const row = { PlanNum: 47, CarrierName: "MetLife PPO", GroupName: "G", PlanType: "PPO", FeeSched: 53, PlanNotePresent: 0, PlanNoteLength: 0, Ordinal: 1 };
  const out = sanitizePatientPlanMysqlRow(row, 0);
  assert.strictEqual(out.is_metlife_match, true);
  assert.strictEqual(out.match_source, "carrier_name");
});

// ── PP15: SubscriberID dropped by sanitizePatientPlanRestRow ─────────────────
test("PP15: sanitizePatientPlanRestRow drops SubscriberID", () => {
  const insplan = { GroupName: "X", SubscriberID: "MBR123", PlanType: "PPO", FeeSched: 0 };
  const out = sanitizePatientPlanRestRow(insplan, 0, 1, 47, "Delta");
  assert.ok(!("SubscriberID" in out), "SubscriberID must not appear in output");
});

// ── PP_NEW1: payload_json stores pat_num as [REDACTED] ────────────────────────
test("PP_NEW1: main.js handleReadOdPatientPlan source — pat_num never in result object", () => {
  // Verify sanitizer does not emit pat_num at any level
  const restRow = sanitizePatientPlanRestRow({ GroupName: "X" }, 0, 1, 47, "MetLife");
  assert.ok(!("pat_num" in restRow), "pat_num must not appear in REST row output");
  const mysqlRow = sanitizePatientPlanMysqlRow({ PlanNum: 47, CarrierName: "MetLife", GroupName: "G", PlanType: "PPO", FeeSched: 0, PlanNotePresent: 0, PlanNoteLength: 0, Ordinal: 1 }, 0);
  assert.ok(!("pat_num" in mysqlRow), "pat_num must not appear in MySQL row output");
});

// ── PP_NEW2: Log step codes used; PatNum value not interpolated in log strings ─
test("PP_NEW2: main.js handler log() calls use step codes, not raw PatNum values", () => {
  const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const idx = src.indexOf("async function handleReadOdPatientPlan");
  const handlerSrc = src.slice(idx, idx + 8000);
  // Extract only log() call lines to check — URL construction is allowed to reference patNum
  const logLines = handlerSrc.split("\n").filter((l) => l.includes("log("));
  for (const line of logLines) {
    assert.ok(!line.includes("${patNum}"), `log() line must not interpolate patNum: ${line.trim()}`);
    assert.ok(!line.includes("${pat_num}"), `log() line must not interpolate pat_num: ${line.trim()}`);
  }
  assert.ok(handlerSrc.includes("PATPLAN_LOOKUP_FAILED"), "must use step code PATPLAN_LOOKUP_FAILED");
  assert.ok(handlerSrc.includes("INSSUB_LOOKUP_FAILED"), "must use step code INSSUB_LOOKUP_FAILED");
  assert.ok(handlerSrc.includes("INSPLAN_LOOKUP_FAILED"), "must use step code INSPLAN_LOOKUP_FAILED");
  assert.ok(handlerSrc.includes("CARRIER_LOOKUP_FAILED"), "must use step code CARRIER_LOOKUP_FAILED");
});

// ── PP_NEW3: main.js calls /patplans?PatNum= (Codex R1 verification) ─────────
test("PP_NEW3: main.js source inspection — calls /patplans?PatNum= (not /patients/{patNum}/insplans)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const idx = src.indexOf("async function handleReadOdPatientPlan");
  const handlerSrc = src.slice(idx, idx + 8000);
  assert.ok(handlerSrc.includes("/patplans?PatNum="), "must call /patplans?PatNum=");
  assert.ok(!handlerSrc.includes("/patients/"), "must NOT call /patients/{patNum}/insplans");
});

// ── PP_NEW4: main.js calls /inssubs/ to resolve InsSubNum → PlanNum ──────────
test("PP_NEW4: main.js source inspection — calls /inssubs/ to resolve InsSubNum to PlanNum", () => {
  const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const idx = src.indexOf("async function handleReadOdPatientPlan");
  const handlerSrc = src.slice(idx, idx + 8000);
  assert.ok(handlerSrc.includes("/inssubs/"), "must call /inssubs/{InsSubNum} to resolve PlanNum");
});

// ── PP_NEW5: MySQL query uses isub.DateTerm, not pp.PatStatus ────────────────
test("PP_NEW5: main.js MySQL query uses isub.DateTerm and does NOT contain pp.PatStatus", () => {
  const src = fs.readFileSync(path.join(__dirname, "../main.js"), "utf8");
  const idx = src.indexOf("async function handleReadOdPatientPlan");
  const handlerSrc = src.slice(idx, idx + 8000);
  assert.ok(handlerSrc.includes("isub.DateTerm"), "MySQL query must use isub.DateTerm for active plan filter");
  assert.ok(!handlerSrc.includes("pp.PatStatus"), "MySQL query must NOT use pp.PatStatus (not on patplan table)");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
