/**
 * Updater hardening verification — T-UPD-1 through T-UPD-7.
 * Source inspection tests: verify auto-install timer removed, single startup
 * checkForUpdates, and correct guard/install form in remote command handlers.
 * Run: node test/updater-hardening.test.js
 */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

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

const mainPath = path.join(__dirname, "..", "main.js");
const src = fs.readFileSync(mainPath, "utf8");

// Extract an async function body by name (brace-counting).
function extractFn(source, fnName) {
  const needle = `async function ${fnName}(`;
  const start = source.indexOf(needle);
  if (start === -1) return "";
  let depth = 0;
  let i = start;
  while (i < source.length) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
    i++;
  }
  return source.slice(start);
}

console.log("\nUpdater hardening (T-UPD-1 through T-UPD-7)\n");

// T-UPD-1: Auto-install timer form must be absent.
// After patch, only quitAndInstall(false, true) may exist (QUIT_AND_INSTALL handler).
// quitAndInstall(true, true) was the 10-second auto-install — must be gone.
test("T-UPD-1: quitAndInstall(true, true) absent — auto-install timer removed", () => {
  assert(
    !src.includes("quitAndInstall(true, true)"),
    "Found quitAndInstall(true, true) — 10-second auto-install timer was not removed",
  );
});

// T-UPD-2: update-downloaded must set downloaded=true.
test("T-UPD-2: update-downloaded handler sets update_status.downloaded = true", () => {
  const idx = src.indexOf('"update-downloaded"');
  assert(idx !== -1, "update-downloaded event handler not found in main.js");
  const block = src.slice(idx, idx + 400);
  assert(
    block.includes("update_status.downloaded = true"),
    "update_status.downloaded = true not in first update-downloaded handler",
  );
});

// T-UPD-3: update-downloaded must set last_download_at.
test("T-UPD-3: update-downloaded handler sets update_status.last_download_at", () => {
  const idx = src.indexOf('"update-downloaded"');
  assert(idx !== -1, "update-downloaded event handler not found in main.js");
  const block = src.slice(idx, idx + 400);
  assert(
    block.includes("update_status.last_download_at"),
    "update_status.last_download_at not set in update-downloaded handler",
  );
});

// T-UPD-4: Exactly one startup checkForUpdates().catch call.
// Block 1 has one; Block 2's was removed. handleCheckForUpdate uses await (no .catch suffix).
test("T-UPD-4: exactly one checkForUpdates().catch startup call remains", () => {
  const pattern = "checkForUpdates().catch";
  let count = 0;
  let pos = 0;
  while ((pos = src.indexOf(pattern, pos)) !== -1) {
    count++;
    pos += pattern.length;
  }
  assert.strictEqual(
    count,
    1,
    `Expected 1 checkForUpdates().catch call, found ${count} — duplicate startup call may still exist`,
  );
});

// T-UPD-5: handleQuitAndInstall must guard on !update_status.downloaded.
test("T-UPD-5: handleQuitAndInstall guards: returns FAILED when !downloaded", () => {
  const fnSrc = extractFn(src, "handleQuitAndInstall");
  assert(
    fnSrc.length > 0,
    "handleQuitAndInstall function not found in main.js",
  );
  assert(
    fnSrc.includes("!update_status.downloaded"),
    "Guard !update_status.downloaded not found in handleQuitAndInstall",
  );
});

// T-UPD-6: handleQuitAndInstall must call quitAndInstall(false, true), not (true, true).
// (false, true) = user-initiated with force-restart. (true, true) = silent auto-install (removed).
test("T-UPD-6: handleQuitAndInstall calls quitAndInstall(false, true)", () => {
  const fnSrc = extractFn(src, "handleQuitAndInstall");
  assert(
    fnSrc.length > 0,
    "handleQuitAndInstall function not found in main.js",
  );
  assert(
    fnSrc.includes("quitAndInstall(false, true)"),
    "quitAndInstall(false, true) not found in handleQuitAndInstall",
  );
  assert(
    !fnSrc.includes("quitAndInstall(true, true)"),
    "quitAndInstall(true, true) found in handleQuitAndInstall — must use (false, true)",
  );
});

// T-UPD-7: handleReportUpdateStatus must include current_version via app.getVersion().
test("T-UPD-7: handleReportUpdateStatus includes current_version: app.getVersion()", () => {
  const fnSrc = extractFn(src, "handleReportUpdateStatus");
  assert(
    fnSrc.length > 0,
    "handleReportUpdateStatus function not found in main.js",
  );
  assert(
    fnSrc.includes("app.getVersion()"),
    "app.getVersion() not found in handleReportUpdateStatus",
  );
  assert(
    fnSrc.includes("current_version"),
    "current_version field not found in handleReportUpdateStatus",
  );
});

// T-UPD-8: autoInstallOnAppQuit must be false in both updater blocks.
// Prevents installed-update from triggering on normal app quit — install only via quitAndInstall().
test("T-UPD-8: autoInstallOnAppQuit = false in both updater blocks", () => {
  const trueCount = (src.match(/autoInstallOnAppQuit\s*=\s*true/g) ?? [])
    .length;
  const falseCount = (src.match(/autoInstallOnAppQuit\s*=\s*false/g) ?? [])
    .length;
  assert.strictEqual(
    trueCount,
    0,
    `Found ${trueCount} autoInstallOnAppQuit = true — must be 0 after hardening`,
  );
  assert.strictEqual(
    falseCount,
    2,
    `Expected 2 autoInstallOnAppQuit = false (Block 1 + Block 2), found ${falseCount}`,
  );
});

// T-UPD-9: Stale "will install on next restart" log message must be absent.
// After hardening, no handler implies auto-install on quit.
test("T-UPD-9: stale 'will install on next restart' log message absent", () => {
  assert(
    !src.includes("will install on next restart"),
    "Found 'will install on next restart' — misleading log message not cleaned up",
  );
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
