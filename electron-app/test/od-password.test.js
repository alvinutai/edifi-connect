/**
 * od-password decryptOdPassHash tests.
 * Unit tests use an injected fake execFileSync to assert the injection-safe
 * contract (hash/DLL passed via env, never on the command line) without needing
 * CDT.dll. The live round-trip against a real CDT.dll is a separate manual proof
 * (scripts/prove-od-decrypt.js), not run here.
 * Run: node test/od-password.test.js
 */

const assert = require("assert");
const path = require("path");
const { decryptOdPassHash } = require("../lib/od-password");

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const fakeFsWithDll = { existsSync: () => true };
// execFile fake returning { stdout } (matches util.promisify(execFile) shape)
const fakeExec = (stdout, capture) => async (file, args, opts) => {
  if (capture) capture({ file, args, opts });
  return { stdout };
};

test("passes hash and DLL path via env, never on the command line", async () => {
  let captured;
  const pw = await decryptOdPassHash("odv2e$ABC==", "C:\\OD", {
    fs: fakeFsWithDll,
    execFile: fakeExec("s3cret\r\n", (c) => (captured = c)),
  });
  assert.strictEqual(pw, "s3cret");
  assert.ok(/powershell\.exe$/i.test(captured.file), "not absolute powershell");
  assert.ok(
    !captured.args.some((a) => a.includes("odv2e$ABC==")),
    "hash leaked into argv",
  );
  assert.strictEqual(captured.opts.env.OD_PASS_HASH, "odv2e$ABC==");
  assert.ok(captured.opts.env.OD_CDT_DLL.endsWith("CDT.dll"));
});

test("ignores a non-allowlisted supplied dir, loads only from the allowlist", async () => {
  let captured;
  const appData = "C:\\Users\\x\\AppData\\Roaming\\OpenDental";
  await decryptOdPassHash("odv2e$X", appData, {
    fs: fakeFsWithDll,
    execFile: fakeExec("pw", (c) => (captured = c)),
  });
  assert.ok(
    !captured.opts.env.OD_CDT_DLL.includes("AppData"),
    "loaded DLL from a non-allowlisted dir",
  );
  assert.strictEqual(
    captured.opts.env.OD_CDT_DLL,
    path.join("C:\\Program Files (x86)\\Open Dental", "CDT.dll"),
  );
});

test("prioritizes the config's own dir when it is on the allowlist", async () => {
  let captured;
  await decryptOdPassHash("odv2e$X", "C:\\Open Dental", {
    fs: fakeFsWithDll,
    execFile: fakeExec("pw", (c) => (captured = c)),
  });
  assert.strictEqual(
    captured.opts.env.OD_CDT_DLL,
    path.join("C:\\Open Dental", "CDT.dll"),
  );
});

test("throws when CDT.dll is not found", async () => {
  await assert.rejects(
    decryptOdPassHash("odv2e$X", null, {
      fs: { existsSync: () => false },
      execFile: fakeExec("x"),
    }),
    /CDT\.dll not found/,
  );
});

test("throws when TryDecrypt returns empty", async () => {
  await assert.rejects(
    decryptOdPassHash("odv2e$X", "C:\\Open Dental", {
      fs: fakeFsWithDll,
      execFile: fakeExec(""),
    }),
    /returned empty/,
  );
});

test("trims trailing newline from PowerShell output", async () => {
  const pw = await decryptOdPassHash("odv2e$X", "C:\\Open Dental", {
    fs: fakeFsWithDll,
    execFile: fakeExec("pw-no-newline"),
  });
  assert.strictEqual(pw, "pw-no-newline");
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`  ✗ ${name}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
