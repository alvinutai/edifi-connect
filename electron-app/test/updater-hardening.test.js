/**
 * Updater hardening verification.
 * Source inspection tests: verify auto-install timer removed, single startup
 * checkForUpdates, explicit DOWNLOAD_UPDATE gating, and correct guard/install
 * form in remote command handlers.
 * Run: node electron-app/test/updater-hardening.test.js
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

console.log("\nUpdater hardening tests\n");

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
  assert(fnSrc.length > 0, "handleQuitAndInstall function not found in main.js");
  assert(
    fnSrc.includes("!update_status.downloaded"),
    "Guard !update_status.downloaded not found in handleQuitAndInstall",
  );
});

// T-UPD-6: handleQuitAndInstall must call quitAndInstall(false, true), not (true, true).
test("T-UPD-6: handleQuitAndInstall calls quitAndInstall(false, true)", () => {
  const fnSrc = extractFn(src, "handleQuitAndInstall");
  assert(fnSrc.length > 0, "handleQuitAndInstall function not found in main.js");
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
  assert(fnSrc.length > 0, "handleReportUpdateStatus function not found in main.js");
  assert(fnSrc.includes("app.getVersion()"), "app.getVersion() not found in handleReportUpdateStatus");
  assert(fnSrc.includes("current_version"), "current_version field not found in handleReportUpdateStatus");
});

// T-UPD-8: autoInstallOnAppQuit must be false in both updater blocks.
test("T-UPD-8: autoInstallOnAppQuit = false in both updater blocks", () => {
  const trueCount = (src.match(/autoInstallOnAppQuit\s*=\s*true/g) ?? []).length;
  const falseCount = (src.match(/autoInstallOnAppQuit\s*=\s*false/g) ?? []).length;
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

// T-UPD-9: autoDownload must be false in both updater blocks.
test("T-UPD-9: autoDownload = false in both updater blocks", () => {
  const trueCount = (src.match(/autoUpdater\.autoDownload\s*=\s*true/g) ?? []).length;
  const falseCount = (src.match(/autoUpdater\.autoDownload\s*=\s*false/g) ?? []).length;
  assert.strictEqual(
    trueCount,
    0,
    `Found ${trueCount} autoUpdater.autoDownload = true — must be 0 after hardening`,
  );
  assert.strictEqual(
    falseCount,
    2,
    `Expected 2 autoUpdater.autoDownload = false (Block 1 + Block 2), found ${falseCount}`,
  );
});

// T-UPD-10: Stale "will install on next restart" / "auto-installing" log messages absent.
test("T-UPD-10: stale auto-install log messages absent", () => {
  assert(
    !src.includes("will install on next restart"),
    "Found 'will install on next restart' — misleading log message not cleaned up",
  );
  assert(
    !src.includes("auto-installing in 10 seconds"),
    "Found 'auto-installing in 10 seconds' — auto-install timer message not cleaned up",
  );
});

// T-UPD-11: CHECK_FOR_UPDATE must not call downloadUpdate.
test("T-UPD-11: handleCheckForUpdate does not call downloadUpdate", () => {
  const fnSrc = extractFn(src, "handleCheckForUpdate");
  assert(fnSrc.length > 0, "handleCheckForUpdate function not found in main.js");
  assert(
    !fnSrc.includes("downloadUpdate"),
    "handleCheckForUpdate must not call downloadUpdate",
  );
});

// T-UPD-12: DOWNLOAD_UPDATE must explicitly call downloadUpdate.
test("T-UPD-12: handleDownloadUpdate calls autoUpdater.downloadUpdate()", () => {
  const fnSrc = extractFn(src, "handleDownloadUpdate");
  assert(fnSrc.length > 0, "handleDownloadUpdate function not found in main.js");
  assert(
    fnSrc.includes("autoUpdater.downloadUpdate()"),
    "handleDownloadUpdate must explicitly call autoUpdater.downloadUpdate()",
  );
});

// T-UPD-13: DOWNLOAD_UPDATE must guard on available and not-yet-downloaded.
test("T-UPD-13: handleDownloadUpdate guards on available/downloaded/downloading", () => {
  const fnSrc = extractFn(src, "handleDownloadUpdate");
  assert(fnSrc.length > 0, "handleDownloadUpdate function not found in main.js");
  assert(
    fnSrc.includes("update_status.downloaded"),
    "handleDownloadUpdate must check update_status.downloaded",
  );
  assert(
    fnSrc.includes("update_status.available"),
    "handleDownloadUpdate must check update_status.available",
  );
  assert(
    fnSrc.includes("update_status.downloading"),
    "handleDownloadUpdate must check update_status.downloading",
  );
});

// T-UPD-14: update-downloaded handler must not call quitAndInstall.
test("T-UPD-14: update-downloaded handler does not call quitAndInstall", () => {
  const idx = src.indexOf('"update-downloaded"');
  assert(idx !== -1, "update-downloaded event handler not found in main.js");
  const block = src.slice(idx, idx + 400);
  assert(
    !block.includes("quitAndInstall"),
    "update-downloaded handler must not call quitAndInstall",
  );
});

// T-UPD-15: No setTimeout auto-install block remains.
// The only allowed setTimeout+quitAndInstall is the explicit command handler
// (500ms delay, quitAndInstall(false, true)). Any setTimeout block containing
// quitAndInstall(true, true) or auto-install log text is the old 10-second timer.
test("T-UPD-15: no setTimeout auto-install block remains", () => {
  let pos = 0;
  while ((pos = src.indexOf("setTimeout", pos)) !== -1) {
    const block = src.slice(pos, pos + 400);
    const isExplicitCommand =
      block.includes("quitAndInstall(false, true)") && block.includes("500");
    const isAutoInstall =
      block.includes("quitAndInstall(true, true)") ||
      block.includes("auto-installing") ||
      block.includes("will install on next restart");
    assert(
      !isAutoInstall || isExplicitCommand,
      "Found setTimeout block that appears to auto-install — old 10-second timer may still exist",
    );
    pos += "setTimeout".length;
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
