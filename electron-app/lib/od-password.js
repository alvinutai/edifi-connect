/**
 * De-obfuscates an Open Dental MySqlPassHash using the CDT.dll already installed
 * with Open Dental on THIS machine (CDT.Class1.TryDecrypt) — the same library OD
 * itself uses to read the MySQL password at startup. Nothing is shipped or
 * transmitted; the decrypted value stays on the machine and is never logged.
 *
 * Security:
 *   - hash and DLL path are passed to PowerShell via environment variables, never
 *     interpolated into the command string → no shell-injection surface even
 *     though the hash is attacker-influenceable in principle.
 *   - the CDT.dll is loaded only from trusted, non-user-writable Open Dental
 *     install directories (Program Files / C:\[Open]Dental); a directory under
 *     AppData is rejected so a planted DLL can't be loaded.
 *   - PowerShell is invoked by absolute System32 path to defeat PATH hijacking.
 *   - async (execFile) so the Electron main process / bridge heartbeat never blocks.
 *
 * @param passHash  the odv2-obfuscated value from FreeDentalConfig.xml
 * @param odDir     Open Dental install dir (where CDT.dll lives), if known
 * @param deps      injectable { fs, execFile } for testing; defaults to real
 * @returns Promise<string> plaintext MySQL password (rejects on any failure)
 */

const POWERSHELL =
  (process.env.SystemRoot || "C:\\Windows") +
  "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

const TRUSTED_OD_DIRS = [
  "C:\\Program Files (x86)\\Open Dental",
  "C:\\Program Files\\Open Dental",
  "C:\\Open Dental",
  "C:\\OpenDental",
];

function isUnderAppData(dir) {
  return /\\AppData\\/i.test(dir || "");
}

async function decryptOdPassHash(passHash, odDir, deps) {
  const fs = (deps && deps.fs) || require("fs");
  const pathMod = require("path");
  const execFile =
    (deps && deps.execFile) ||
    require("util").promisify(require("child_process").execFile);

  // Trusted install dirs first; the discovered odDir last, and only if it is not
  // user-writable AppData (which would let a non-admin plant a malicious CDT.dll).
  const dirs = [...TRUSTED_OD_DIRS];
  if (odDir && !isUnderAppData(odDir) && !dirs.includes(odDir))
    dirs.push(odDir);

  const dll = dirs
    .map((d) => pathMod.join(d, "CDT.dll"))
    .find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
  if (!dll)
    throw new Error(
      "CDT.dll not found in a trusted Open Dental install directory",
    );

  const script = [
    "$ErrorActionPreference='Stop'",
    "$a=[Reflection.Assembly]::LoadFile($env:OD_CDT_DLL)",
    "$m=$a.GetType('CDT.Class1').GetMethod('TryDecrypt')",
    "[Console]::Out.Write($m.Invoke($null,@($env:OD_PASS_HASH)))",
  ].join(";");

  const { stdout } = await execFile(
    POWERSHELL,
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
  const pw = (stdout || "").replace(/\r?\n$/, "");
  if (!pw) throw new Error("CDT.dll TryDecrypt returned empty");
  return pw;
}

module.exports = { decryptOdPassHash };
