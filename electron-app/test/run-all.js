/**
 * Runs every test/*.test.js file in its own process and fails if any fail.
 * Keeps the suite (including OD self-provision tests) under a single `npm test`.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const dir = __dirname;
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

let failed = 0;
for (const f of files) {
  process.stdout.write(`\n▶ ${f}\n`);
  try {
    const out = execFileSync(process.execPath, [path.join(dir, f)], {
      encoding: "utf8",
    });
    process.stdout.write(out);
  } catch (e) {
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    failed++;
  }
}

console.log(`\n${files.length} files, ${failed} failed`);
process.exit(failed ? 1 : 0);
