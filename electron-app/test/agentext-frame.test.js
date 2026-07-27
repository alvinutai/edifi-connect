/**
 * AGENT-EXT P4 — OD read + push frame.
 *
 * Two halves, both against the live source:
 *   1. od-mysql.js exports (probe, SELECT fragment, definition Category-2 read)
 *      are imported and driven directly.
 *   2. The main.js frame builder cannot be require()'d (it boots Electron), so
 *      the enriched-row literal is extracted from source and evaluated against
 *      a synthetic OD row — the same technique mapOdApiBenefits.test.js uses.
 *
 * Synthetic values only. No OD connection, no network, no PHI.
 *
 * Run: node test/agentext-frame.test.js (from electron-app/)
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { agentExtSelectFragment, AGENT_EXT_COLUMNS } = require("../od-mysql");

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

console.log("\nAGENT-EXT read query + push frame (P4)\n");

// ── 1. Probed SELECT fragment ────────────────────────────────────────────────

test("every documented AGENT-EXT column is qualified to its own table", () => {
  const frag = agentExtSelectFragment(AGENT_EXT_COLUMNS);
  for (const c of AGENT_EXT_COLUMNS.appointment)
    assert.ok(frag.includes(`a.${c}`), `missing a.${c}`);
  for (const c of AGENT_EXT_COLUMNS.patient)
    assert.ok(frag.includes(`p.${c}`), `missing p.${c}`);
  for (const c of AGENT_EXT_COLUMNS.provider)
    assert.ok(frag.includes(`prov.${c}`), `missing prov.${c}`);
});

test("the fragment starts with a comma so it appends to the base SELECT", () => {
  const frag = agentExtSelectFragment({
    appointment: ["Confirmed"],
    patient: [],
    provider: [],
  });
  assert.ok(frag.trimStart().startsWith(","));
  assert.ok(frag.includes("a.Confirmed"));
});

test("an Open Dental with none of the columns yields an empty fragment", () => {
  // The whole point of probing: the board falls back to exactly today's query
  // instead of throwing and returning zero appointments.
  assert.strictEqual(
    agentExtSelectFragment({ appointment: [], patient: [], provider: [] }),
    "",
  );
});

test("a partial schema contributes only what it has", () => {
  const frag = agentExtSelectFragment({
    appointment: ["DateTimeArrived"],
    patient: ["Premed"],
    provider: [],
  });
  assert.ok(frag.includes("a.DateTimeArrived"));
  assert.ok(frag.includes("p.Premed"));
  assert.ok(!frag.includes("ProvColor"));
  assert.ok(!frag.includes("BalTotal"));
});

test("both balance candidates are probed, neither is assumed", () => {
  // No in-repo helper names OD's balance column and it could not be checked
  // against a real office from here, so the schema decides.
  assert.ok(AGENT_EXT_COLUMNS.patient.includes("BalTotal"));
  assert.ok(AGENT_EXT_COLUMNS.patient.includes("EstBalance"));
});

// ── 2. The live SELECT and the definition read ───────────────────────────────

const mysqlSrc = fs.readFileSync(
  path.join(__dirname, "..", "od-mysql.js"),
  "utf8",
);

test("getAppointmentsForDate splices the probed fragment into its SELECT", () => {
  const fn = mysqlSrc.slice(
    mysqlSrc.indexOf("async function getAppointmentsForDate("),
    mysqlSrc.indexOf("async function getAppointmentsToday("),
  );
  assert.ok(fn.includes("await probeAgentExtColumns()"));
  assert.ok(fn.includes("${agentExtSelectFragment(extCols)}"));
  // Base columns still present — this is additive, not a rewrite.
  assert.ok(fn.includes("a.AptNum, a.PatNum, a.AptDateTime"));
  assert.ok(fn.includes("AS Production"));
});

test("the status-definition read is probe-guarded and Category 2", () => {
  const fn = mysqlSrc.slice(
    mysqlSrc.indexOf("async function getStatusDefinitions("),
    mysqlSrc.indexOf("async function getAppointmentTypesForDate("),
  );
  assert.ok(fn.includes("information_schema.TABLES"));
  assert.ok(fn.includes("TABLE_NAME = 'definition'"));
  assert.ok(fn.includes("d.Category = 2"));
  // Raw ARGB — conversion is the backend's job, one site.
  assert.ok(fn.includes("Number(r.ItemColor)"));
  assert.ok(!/ItemColor[^\n]*#/.test(fn), "agent must not build a hex color");
});

test("a hidden definition is still returned, flagged rather than dropped", () => {
  const fn = mysqlSrc.slice(
    mysqlSrc.indexOf("async function getStatusDefinitions("),
    mysqlSrc.indexOf("async function getAppointmentTypesForDate("),
  );
  assert.ok(fn.includes("is_hidden"));
  assert.ok(!fn.includes("WHERE d.Category = 2 AND d.IsHidden"));
});

// ── 3. The push frame ────────────────────────────────────────────────────────

const mainSrc = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");

/** Evaluates the enriched-row literal from main.js against a synthetic OD row. */
function buildFrameRow(apt) {
  const start = mainSrc.indexOf("        enriched.push({");
  const end = mainSrc.indexOf("      } catch (e) {", start);
  assert.ok(start > -1 && end > start, "enriched.push literal not found");
  const literal = mainSrc
    .slice(start, end)
    .replace("enriched.push(", "return (")
    .replace(/\);\s*$/, ");");
  // The frame literal now calls selectOdBalance (which wraps odBalanceToCents
  // and picks the column that actually parsed). Both live in the same slice.
  const selectOdBalance = new Function(
    "row",
    mainSrc.slice(
      mainSrc.indexOf("function odBalanceToCents("),
      mainSrc.indexOf("// B-014 fix (2026-07-09)"),
    ) + "\nreturn selectOdBalance(row);",
  );
  return new Function(
    "apt",
    "snapshot",
    "procCodes",
    "estPatientCents",
    "feeApptCents",
    "typeByAptNum",
    "selectOdBalance",
    literal,
  )(apt, { plans: [], benefits: [] }, [], 0, 0, new Map(), selectOdBalance);
}

const FULL_ROW = {
  AptNum: 60,
  PatNum: 10,
  AptDateTime: "2026-07-27 09:00:00",
  Confirmed: 34,
  DateTimeArrived: "2026-07-27 08:55:00",
  DateTimeSeated: "2026-07-27 09:02:00",
  DateTimeDismissed: "0001-01-01 00:00:00",
  IsNewPatient: 1,
  IsHygiene: 0,
  ProvColor: -16744448,
  Premed: 1,
  MedUrgNote: "Latex allergy",
  Preferred: "Bobby",
  BalTotal: 45.0,
};

test("a full OD row produces every AGENT-EXT key", () => {
  const row = buildFrameRow(FULL_ROW);
  assert.strictEqual(row.confirmed_def_num, 34);
  assert.strictEqual(row.arrived_at, "2026-07-27 08:55:00");
  assert.strictEqual(row.seated_at, "2026-07-27 09:02:00");
  assert.strictEqual(row.is_new_patient, 1);
  assert.strictEqual(row.is_hygiene, 0);
  assert.strictEqual(row.provider_color, -16744448);
  assert.strictEqual(row.premed, 1);
  assert.strictEqual(row.medical_alert, "Latex allergy");
  assert.strictEqual(row.preferred_name, "Bobby");
});

test("colors and zero-dates travel raw — the agent converts nothing", () => {
  const row = buildFrameRow(FULL_ROW);
  // Signed ARGB, not "#008000": the backend owns the one conversion site.
  assert.strictEqual(typeof row.provider_color, "number");
  // The OD sentinel is passed through; P2 ingest nulls it.
  assert.strictEqual(row.dismissed_at, "0001-01-01 00:00:00");
});

test("balance is sent in cents with the column it came from", () => {
  const row = buildFrameRow(FULL_ROW);
  assert.strictEqual(row.balance_cents, 4500);
  assert.strictEqual(row.balance_source, "BalTotal");
});

test("EstBalance is used and named when BalTotal is absent", () => {
  const row = buildFrameRow({
    ...FULL_ROW,
    BalTotal: undefined,
    EstBalance: 12.5,
  });
  assert.strictEqual(row.balance_cents, 1250);
  assert.strictEqual(row.balance_source, "EstBalance");
});

test("a real zero balance survives as 0, not as absent", () => {
  const row = buildFrameRow({ ...FULL_ROW, BalTotal: 0 });
  assert.strictEqual(row.balance_cents, 0);
  assert.strictEqual(row.balance_source, "BalTotal");
});

test("an Open Dental missing every AGENT-EXT column does not throw", () => {
  const row = buildFrameRow({
    AptNum: 60,
    PatNum: 10,
    AptDateTime: "2026-07-27 09:00:00",
  });
  for (const k of [
    "confirmed_def_num",
    "arrived_at",
    "seated_at",
    "dismissed_at",
    "is_new_patient",
    "is_hygiene",
    "provider_color",
    "premed",
    "medical_alert",
    "preferred_name",
    "balance_cents",
    "balance_source",
  ]) {
    assert.strictEqual(row[k], null, `${k} should be null, got ${row[k]}`);
  }
});

test("the pre-existing frame keys are untouched", () => {
  const row = buildFrameRow(FULL_ROW);
  assert.strictEqual(row.AptNum, 60);
  assert.strictEqual(row.source, "od_mysql");
  assert.ok("appointment_type" in row);
  assert.ok("type_color" in row);
  assert.ok("operatory" in row);
  assert.ok("production_cents" in row);
});

// main.js has TWO OD_DATA_PUSH senders: the REST path (syncODData) and the
// MySQL path (syncODMySql). AGENT-EXT extends the MySQL one — it is the sender
// that reads getAppointmentsForDate and already carries the B1/B1b board work.
// Anchor every source assertion to that sender explicitly, or an indexOf lands
// in the REST path and silently proves nothing.
const MYSQL_PUSH_AT = mainSrc.indexOf("[OD MySQL Sync] Pushing");

test("both senders are accounted for — the REST frame is deliberately untouched", () => {
  const pushes = [...mainSrc.matchAll(/type: "OD_DATA_PUSH"/g)];
  assert.strictEqual(
    pushes.length,
    2,
    "expected exactly two senders in main.js",
  );
  const restPush = mainSrc.slice(pushes[0].index, pushes[0].index + 300);
  assert.ok(!restPush.includes("status_definitions"));
  assert.ok(!restPush.includes("operatories"));
});

test("status_definitions rides the frame once, not per appointment", () => {
  const push = mainSrc.slice(
    mainSrc.indexOf('type: "OD_DATA_PUSH"', MYSQL_PUSH_AT),
    mainSrc.indexOf('type: "OD_DATA_PUSH"', MYSQL_PUSH_AT) + 500,
  );
  assert.ok(push.includes("status_definitions: statusDefinitions"));
  assert.ok(push.includes("appointments: enriched"));
  const literal = mainSrc.slice(
    mainSrc.indexOf("        enriched.push({"),
    mainSrc.indexOf(
      "      } catch (e) {",
      mainSrc.indexOf("        enriched.push({"),
    ),
  );
  assert.ok(!literal.includes("status_definitions"));
});

test("the status-definition read fails open — a throw never blocks the sync", () => {
  const at = mainSrc.indexOf("let statusDefinitions = []");
  const region = mainSrc.slice(at, mainSrc.indexOf("const enriched = []", at));
  assert.ok(region.includes("try {"));
  assert.ok(region.includes("catch (defErr)"));
  assert.ok(region.includes("Status definitions skipped"));
});

// ── 4. RULE ZERO + dead-sender guards ────────────────────────────────────────

test("service/bridge.js is annotated dead and was not extended", () => {
  const bridgeSrc = fs.readFileSync(
    path.join(__dirname, "..", "..", "service", "bridge.js"),
    "utf8",
  );
  assert.ok(bridgeSrc.includes("DEAD CODE since 2026-06-06"));
  assert.ok(bridgeSrc.includes("PKT-FINDINGB-SENDER-FORENSIC"));
  // The AGENT-EXT keys must NOT appear here — a second divergent contract that
  // ships to nobody is exactly what the forensic ruled against.
  for (const k of [
    "confirmed_def_num",
    "status_definitions",
    "balance_cents",
  ]) {
    assert.ok(!bridgeSrc.includes(k), `bridge.js must not carry ${k}`);
  }
});

test("no new network call was introduced alongside the OD read", () => {
  const at = mainSrc.indexOf("let statusDefinitions = []");
  const region = mainSrc.slice(at, mainSrc.indexOf("const enriched = []", at));
  assert.ok(!/fetch\(|axios|https?\.request/.test(region));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
// Explicit exit, like the other suites that require od-mysql: the module keeps
// a handle alive, so falling off the end would hang the runner instead of
// reporting a pass.
process.exit(failed > 0 ? 1 : 0);
