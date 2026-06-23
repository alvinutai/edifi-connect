/**
 * Installer config-safety verification (source inspection).
 * Ensures build-assets/installer.nsh does NOT pre-bake a hardcoded office_id into
 * config.json. A fresh install must start unregistered (setup screen), never
 * impersonate a specific office. Legacy v1.0.0 cleanup must remain intact.
 * Run: node electron-app/test/installer-config-safety.test.js
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

const nshPath = path.join(__dirname, "..", "build-assets", "installer.nsh");
const src = fs.readFileSync(nshPath, "utf8");

console.log("\nInstaller config-safety tests\n");

test("no hardcoded office UUID anywhere in installer.nsh", () => {
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  assert.ok(!uuid.test(src), "installer.nsh must not contain a hardcoded office UUID");
});

test("does not contain the All Smiles office_id", () => {
  assert.ok(
    !src.includes("90c1b75a-9bf1-4c9c-84fe-ccd7e9ba1ed9"),
    "All Smiles office_id must not be present",
  );
});

test("does not FileWrite an office_id or a pre-registered config", () => {
  assert.ok(
    !/FileWrite[^\n]*office_id/i.test(src),
    "installer must not FileWrite an office_id",
  );
  assert.ok(
    !/FileWrite[^\n]*registered[^\n]*true/i.test(src),
    "installer must not FileWrite a registered:true config",
  );
});

test("does not open config.json for writing", () => {
  assert.ok(
    !/FileOpen[^\n]*config\.json/i.test(src),
    "installer must not open config.json for write",
  );
});

test("legacy v1.0.0 cleanup preserved (customInstall macro intact)", () => {
  assert.ok(src.includes("!macro customInstall"), "customInstall macro must remain");
  assert.ok(src.includes("EDiFiConnect"), "legacy v1.0.0 cleanup must remain");
  assert.ok(src.includes("!macroend"), "macro must be closed");
});

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
