/**
 * decideSyncCommandStatus — pure SYNC_OD_NOW outcome decision.
 * Proves COMPLETED only on success, last_error cleared only on full success,
 * and that any non-success (including malformed) fails safe without clearing.
 * Run: node test/sync-command-status.test.js
 */

const assert = require("assert");
const { decideSyncCommandStatus } = require("../lib/sync-command-status");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n   ${e.message}`);
  }
}

test("full success → COMPLETED and clears last_error", () => {
  const d = decideSyncCommandStatus({ ok: true, errors: [], pushes: 3 });
  assert.strictEqual(d.commandStatus, "COMPLETED");
  assert.strictEqual(d.clearLastError, true);
  assert.strictEqual(d.errorCode, null);
  assert.strictEqual(d.datesFailed, 0);
});

test("partial failure → FAILED, preserves last_error, counts failed dates", () => {
  const d = decideSyncCommandStatus({
    ok: false,
    errors: [{ date: "2026-07-15", msg: "boom" }],
    pushes: 2,
  });
  assert.strictEqual(d.commandStatus, "FAILED");
  assert.strictEqual(d.clearLastError, false);
  assert.strictEqual(d.errorCode, "SYNC_PARTIAL_FAILURE");
  assert.strictEqual(d.datesFailed, 1);
  assert.strictEqual(d.appointmentCount, 2);
});

test("all dates fail → FAILED, clearLastError false, all dates counted", () => {
  const d = decideSyncCommandStatus({
    ok: false,
    errors: [{ date: "a" }, { date: "b" }, { date: "c" }],
    pushes: 0,
  });
  assert.strictEqual(d.commandStatus, "FAILED");
  assert.strictEqual(d.clearLastError, false);
  assert.strictEqual(d.datesFailed, 3);
  assert.strictEqual(d.appointmentCount, 0);
});

test("skipped result → COMPLETED and clears last_error (existing behavior)", () => {
  const d = decideSyncCommandStatus({ ok: true, skipped: true });
  assert.strictEqual(d.commandStatus, "COMPLETED");
  assert.strictEqual(d.clearLastError, true);
  assert.strictEqual(d.appointmentCount, 0);
});

test("success with multiple pushes reports the push count", () => {
  const d = decideSyncCommandStatus({ ok: true, errors: [], pushes: 17 });
  assert.strictEqual(d.commandStatus, "COMPLETED");
  assert.strictEqual(d.appointmentCount, 17);
});

test("failure with zero pushes → FAILED with appointmentCount 0", () => {
  const d = decideSyncCommandStatus({ ok: false, errors: [{}], pushes: 0 });
  assert.strictEqual(d.commandStatus, "FAILED");
  assert.strictEqual(d.appointmentCount, 0);
});

test("malformed result (null) fails closed — FAILED, 1/0, no clear", () => {
  const d = decideSyncCommandStatus(null);
  assert.strictEqual(d.commandStatus, "FAILED");
  assert.strictEqual(d.clearLastError, false);
  assert.strictEqual(d.datesFailed, 1);
  assert.strictEqual(d.appointmentCount, 0);
});

test("malformed (missing ok) fails closed — never carries stray pushes", () => {
  const d = decideSyncCommandStatus({ pushes: 5 });
  assert.strictEqual(d.commandStatus, "FAILED");
  assert.strictEqual(d.clearLastError, false);
  assert.strictEqual(d.datesFailed, 1);
  assert.strictEqual(d.appointmentCount, 0); // NOT 5
});

test("malformed (missing ok, errors:[]) fails closed — 1 failed, 0 appts", () => {
  const d = decideSyncCommandStatus({ errors: [], pushes: 5 });
  assert.strictEqual(d.commandStatus, "FAILED");
  assert.strictEqual(d.datesFailed, 1); // NOT 0
  assert.strictEqual(d.appointmentCount, 0); // NOT 5
});

test("malformed (non-boolean ok) fails closed — 1/0", () => {
  const d = decideSyncCommandStatus({ ok: "yes", errors: [{}], pushes: 3 });
  assert.strictEqual(d.commandStatus, "FAILED");
  assert.strictEqual(d.clearLastError, false);
  assert.strictEqual(d.datesFailed, 1);
  assert.strictEqual(d.appointmentCount, 0);
});

test("ok:false is the ONLY thing that fails when object well-formed", () => {
  assert.strictEqual(
    decideSyncCommandStatus({ ok: true, errors: [], pushes: 0 }).commandStatus,
    "COMPLETED",
  );
  assert.strictEqual(
    decideSyncCommandStatus({ ok: false, errors: [], pushes: 0 }).commandStatus,
    "FAILED",
  );
});

test("no failure path (success) always returns clearLastError=true", () => {
  for (const r of [
    { ok: true, errors: [], pushes: 0 },
    { ok: true, errors: [], pushes: 9 },
    { ok: true, skipped: true },
  ]) {
    assert.strictEqual(decideSyncCommandStatus(r).clearLastError, true);
  }
});

test("every failure path returns clearLastError=false", () => {
  for (const r of [
    { ok: false, errors: [{}], pushes: 0 },
    { ok: false, errors: [], pushes: 1 },
    null,
    undefined,
    { pushes: 3 },
    "garbage",
  ]) {
    assert.strictEqual(decideSyncCommandStatus(r).clearLastError, false);
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
