/**
 * od-password decryptOdPassHash tests.
 * Unit tests use an injected fake execFileSync to assert the injection-safe
 * contract (hash/DLL passed via env, never on the command line) without needing
 * CDT.dll. The live round-trip against a real CDT.dll is a separate manual proof
 * (scripts/prove-od-decrypt.js), not run here.
 * Run: node test/od-password.test.js
 */

const assert = require("assert");
const { decryptOdPassHash } = require("../lib/od-password");

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

const fakeFsWithDll = { existsSync: () => true };

test("passes hash and DLL path via env, never on the command line", () => {
  let captured;
  const execFileSync = (file, args, opts) => {
    captured = { file, args, opts };
    return "s3cret\r\n";
  };
  const pw = decryptOdPassHash("odv2e$ABC==", "C:\\OD", {
    fs: fakeFsWithDll,
    execFileSync,
  });
  assert.strictEqual(pw, "s3cret");
  assert.strictEqual(captured.file, "powershell.exe");
  // the obfuscated hash must NOT appear in any command-line argument
  assert.ok(
    !captured.args.some((a) => a.includes("odv2e$ABC==")),
    "hash leaked into argv",
  );
  assert.strictEqual(captured.opts.env.OD_PASS_HASH, "odv2e$ABC==");
  assert.ok(captured.opts.env.OD_CDT_DLL.endsWith("CDT.dll"));
});

test("throws when CDT.dll is not found", () => {
  assert.throws(
    () =>
      decryptOdPassHash("odv2e$X", null, {
        fs: { existsSync: () => false },
        execFileSync: () => "x",
      }),
    /CDT\.dll not found/,
  );
});

test("throws when TryDecrypt returns empty", () => {
  assert.throws(
    () =>
      decryptOdPassHash("odv2e$X", "C:\\OD", {
        fs: fakeFsWithDll,
        execFileSync: () => "",
      }),
    /returned empty/,
  );
});

test("trims trailing newline from PowerShell output", () => {
  const pw = decryptOdPassHash("odv2e$X", "C:\\OD", {
    fs: fakeFsWithDll,
    execFileSync: () => "pw-no-newline",
  });
  assert.strictEqual(pw, "pw-no-newline");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
