/**
 * OD Benefit Replay Runner
 * Loads a fixture file, runs the benefit mapping pipeline, and prints a
 * diagnostic report showing what categories resolve and why.
 *
 * Usage (from C:\Users\elite\edifi-connect\):
 *   node tools/od-benefit-replay/runner.js fixtures/sandbox.json
 *   node tools/od-benefit-replay/runner.js fixtures/pilot-office-with-eben.json
 *   node tools/od-benefit-replay/runner.js fixtures/pilot-office-no-eben.json
 *   node tools/od-benefit-replay/runner.js   (runs all 3)
 */

const path = require("path");
const fs = require("fs");
const {
  buildCatMap,
  mapBenefits,
} = require("../../electron-app/lib/benefit-mapper");

const FIXTURE_DIR = path.join(__dirname, "fixtures");

// CoInsurance rows that count toward the coverage matrix (same filter as main.js display logic)
function buildCoverageMatrix(mapped) {
  const coinRows = mapped.filter(
    (r) =>
      r.type === "CoInsurance" &&
      r.percent > 0 &&
      r.coverage_level !== "Family",
  );
  // Deduplicate by category — keep highest %
  const best = {};
  for (const r of coinRows) {
    if (!best[r.category] || r.percent > best[r.category].percent) {
      best[r.category] = r;
    }
  }
  return Object.values(best).sort((a, b) => b.percent - a.percent);
}

function runFixture(fixturePath) {
  const absPath = path.isAbsolute(fixturePath)
    ? fixturePath
    : path.join(FIXTURE_DIR, fixturePath);

  const fixture = JSON.parse(fs.readFileSync(absPath, "utf8"));
  const catMap = buildCatMap(fixture.covcat);
  // Phase 6D-1: fixtures may carry a CodeNum → CDT map (proccodes)
  const mapped = mapBenefits(
    fixture.benefits,
    catMap,
    fixture.proccodes ?? null,
  );
  const matrix = buildCoverageMatrix(mapped);

  const categories = new Set(matrix.map((r) => r.category));
  const ebenUsed = matrix.some((r) => r.category_source === "EbenefitCat");
  const generalRows = matrix.filter((r) => r.category === "GENERAL");

  const KEY_CATS = ["BASIC", "ENDODONTIC", "PERIODONTIC", "ORAL_SURGERY"];
  const presentKeyCats = KEY_CATS.filter((c) => categories.has(c));
  const absentKeyCats = KEY_CATS.filter((c) => !categories.has(c));

  console.log("=".repeat(60));
  console.log(`FIXTURE: ${path.basename(absPath)}`);
  console.log(`  ${fixture.description}`);
  console.log("-".repeat(60));
  console.log(`Raw rows received  : ${mapped._raw_received}`);
  console.log(
    `CoInsurance rows   : ${mapped.filter((r) => r.type === "CoInsurance").length}`,
  );
  console.log(`Dropped rows       : ${mapped._dropped}`);
  if (Object.keys(mapped._dropped_reasons).length > 0) {
    console.log(
      `Dropped reasons    : ${JSON.stringify(mapped._dropped_reasons)}`,
    );
  }
  console.log(`Coverage matrix    : ${matrix.length} unique categories`);
  console.log("");

  console.log("  Category            Plan%  Src             EbenCat");
  console.log("  " + "-".repeat(56));
  for (const r of matrix) {
    const cat = r.category.padEnd(20);
    const pct = String(r.percent + "%").padStart(5);
    const src = (r.category_source || "").padEnd(15);
    const eben = r.ebenefitcat != null ? String(r.ebenefitcat) : "(absent)";
    console.log(`  ${cat} ${pct}  ${src} ${eben}`);
  }

  console.log("");
  console.log(
    `BASIC/ENDO/PERIO/ORAL_SURGERY present : ${presentKeyCats.length > 0 ? presentKeyCats.join(", ") : "NONE"}`,
  );
  console.log(
    `BASIC/ENDO/PERIO/ORAL_SURGERY absent  : ${absentKeyCats.length > 0 ? absentKeyCats.join(", ") : "none"}`,
  );
  console.log(
    `GENERAL rows in matrix                : ${generalRows.length} ${generalRows.length > 0 ? "(spillover — unmapped rows)" : ""}`,
  );
  console.log(
    `EbenefitCat used for any category     : ${ebenUsed ? "YES — v2.3.64 path active" : "NO — CovCatNum-only"}`,
  );
  console.log("=".repeat(60));
  console.log("");
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    // Accept "sandbox.json" or "fixtures/sandbox.json" — strip leading fixtures/ dir prefix
    const arg = args[0].replace(/^fixtures[/\\]/, "");
    runFixture(arg);
  } else {
    const all = [
      "sandbox.json",
      "pilot-office-with-eben.json",
      "pilot-office-no-eben.json",
    ];
    for (const f of all) runFixture(f);
  }
}

main();
