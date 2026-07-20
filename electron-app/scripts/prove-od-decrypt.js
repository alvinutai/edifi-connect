/**
 * Manual live proof: decrypt a real OD MySqlPassHash via the actual CDT.dll.
 * Never prints the plaintext — only length + char classes.
 * Usage: OD_DIR=<dir with CDT.dll> OD_HASH=<odv2 hash> node scripts/prove-od-decrypt.js
 */
const { decryptOdPassHash } = require("../lib/od-password");

const odDir = process.env.OD_DIR || null;
const hash = process.env.OD_HASH;
if (!hash) {
  console.error("set OD_HASH (and optionally OD_DIR)");
  process.exit(2);
}
try {
  const pw = decryptOdPassHash(hash, odDir);
  const classes = [];
  if (/[a-z]/.test(pw)) classes.push("lower");
  if (/[A-Z]/.test(pw)) classes.push("upper");
  if (/[0-9]/.test(pw)) classes.push("digit");
  if (/[^a-zA-Z0-9]/.test(pw)) classes.push("symbol");
  console.log(
    `DECRYPT OK  length=${pw.length}  charclasses=${classes.join("+")}`,
  );
} catch (e) {
  console.error("DECRYPT FAILED:", e.message);
  process.exit(1);
}
