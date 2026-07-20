/**
 * De-obfuscates an Open Dental MySqlPassHash using the CDT.dll already installed
 * with Open Dental on THIS machine (CDT.Class1.TryDecrypt) — the same library OD
 * itself uses to read the MySQL password at startup. Nothing is shipped or
 * transmitted; the decrypted value stays on the machine and is never logged.
 *
 * The hash and DLL path are passed to PowerShell via environment variables, never
 * interpolated into the command string, so there is no shell-injection surface
 * even though the hash is attacker-influenced in principle. Uses powershell.exe
 * (Windows PowerShell / .NET Framework) to load the Framework assembly natively.
 *
 * @param passHash  the odv2-obfuscated value from FreeDentalConfig.xml
 * @param odDir     Open Dental install dir (where CDT.dll lives), if known
 * @param deps      injectable { fs, execFileSync } for testing; defaults to real
 * @returns the plaintext MySQL password (throws on any failure)
 */
function decryptOdPassHash(passHash, odDir, deps) {
  const fs = (deps && deps.fs) || require("fs");
  const execFileSync =
    (deps && deps.execFileSync) || require("child_process").execFileSync;
  const pathMod = require("path");
  const candidates = [
    odDir && pathMod.join(odDir, "CDT.dll"),
    "C:\\Program Files (x86)\\Open Dental\\CDT.dll",
    "C:\\Program Files\\Open Dental\\CDT.dll",
  ].filter(Boolean);
  const dll = candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (!dll)
    throw new Error("CDT.dll not found in Open Dental install directory");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$a=[Reflection.Assembly]::LoadFile($env:OD_CDT_DLL)",
    "$m=$a.GetType('CDT.Class1').GetMethod('TryDecrypt')",
    "[Console]::Out.Write($m.Invoke($null,@($env:OD_PASS_HASH)))",
  ].join(";");
  const out = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ],
    {
      env: { ...process.env, OD_CDT_DLL: dll, OD_PASS_HASH: passHash },
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    },
  );
  const pw = (out || "").replace(/\r?\n$/, "");
  if (!pw) throw new Error("CDT.dll TryDecrypt returned empty");
  return pw;
}

module.exports = { decryptOdPassHash };
