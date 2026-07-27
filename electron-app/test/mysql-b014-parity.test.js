/**
 * PKT-B014-MYSQL — the MySQL benefit mapper under full B-014 v6 semantics, and
 * a REST-vs-MySQL parity gate for the shared semantic core.
 *
 * Ruling R2 makes MySQL the design path, so its benefit mapping can no longer
 * be the uninstrumented twin of the REST one: an unknown type used to return
 * null, a negative percent used to return null, and `.filter(Boolean)` swallowed
 * both with no reason and no count — B-014, re-created on the path the fix was
 * written for.
 *
 * Synthetic rows only. No database connection, no network, no PHI.
 *
 * Run: node test/mysql-b014-parity.test.js (from electron-app/)
 */

const assert = require("assert");
const { mapMysqlBenefits, mapMysqlBenefitRow } = require("../od-mysql");
const { mapBenefits } = require("../lib/benefit-mapper");

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

console.log("\nB-014 on the MySQL benefit path + REST parity\n");

/** A MySQL benefit row (numeric BenefitType, OD column names). */
const myRow = (over = {}) => ({
  BenefitNum: 700,
  CovCatNum: 0,
  CodeNum: 0,
  BenefitType: 1,
  CoverageLevel: 1,
  Percent: "80",
  MonetaryAmt: null,
  Quantity: null,
  QuantityQualifier: null,
  TimePeriod: 0,
  EbenefitCat: 0,
  ...over,
});

// ── Accounting invariant ─────────────────────────────────────────────────────

test("attaches the same diagnostic shape the REST mapper does", () => {
  const out = mapMysqlBenefits([myRow()]);
  for (const k of [
    "_raw_received",
    "_dropped",
    "_dropped_reasons",
    "_fallback_reasons",
  ]) {
    assert.ok(k in out, `missing ${k}`);
  }
});

test("sum(dropped_reasons) equals the true drop count", () => {
  const rows = [
    myRow({ BenefitNum: 1, Percent: "80" }), // kept
    myRow({ BenefitNum: 2, Percent: "-1" }), // dropped: OD not-entered sentinel
    myRow({ BenefitNum: 3, Percent: "bad" }), // dropped: malformed
    myRow({ BenefitNum: 4, BenefitType: 2, MonetaryAmt: null }), // dropped
    myRow({
      BenefitNum: 5,
      BenefitType: 3,
      MonetaryAmt: null,
      Quantity: null,
    }), // dropped
    myRow({ BenefitNum: 6, BenefitType: 99 }), // Other fallback — KEPT
  ];
  const out = mapMysqlBenefits(rows);

  assert.strictEqual(out._raw_received, 6);
  assert.strictEqual(out.length, 2, "80% row + Other row survive");
  assert.strictEqual(out._dropped, 4);
  const sum = Object.values(out._dropped_reasons).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, out._dropped, "invariant violated");
  assert.deepStrictEqual(out._dropped_reasons, {
    coinsurance_invalid_percent: 2,
    deductible_invalid_amount: 1,
    limitations_no_valid_value: 1,
  });
});

test("a fallback row is counted as fallback, never as a drop", () => {
  const out = mapMysqlBenefits([myRow({ BenefitType: 99 })]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out._dropped, 0);
  assert.deepStrictEqual(out._dropped_reasons, {});
  assert.strictEqual(out._fallback_reasons.type_99_unmapped_fallback, 1);
});

test("every drop path is instrumented — none are silent", () => {
  const out = mapMysqlBenefits([
    myRow({ Percent: null }),
    myRow({ BenefitType: 2, MonetaryAmt: "junk" }),
    myRow({ BenefitType: 3, MonetaryAmt: null, Quantity: "junk" }),
  ]);
  assert.strictEqual(out.length, 0);
  assert.strictEqual(
    Object.values(out._dropped_reasons).reduce((a, b) => a + b, 0),
    3,
  );
});

// ── Zero preservation — the original B-014 defect ────────────────────────────

test("an explicit 0% coinsurance survives", () => {
  // "This plan covers none of it" is real clinical data — the live evidence
  // that opened B-014 included pulp cap 0% and Arestin 0%.
  const out = mapMysqlBenefits([myRow({ Percent: "0" })]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].percent, 0);
});

test("a $0 deductible survives", () => {
  const out = mapMysqlBenefits([myRow({ BenefitType: 2, MonetaryAmt: "0" })]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].amount_cents, 0);
});

test("a $0 limitation with no quantity survives", () => {
  // The old `Number(MonetaryAmt) > 0` gate dropped this outright.
  const out = mapMysqlBenefits([myRow({ BenefitType: 3, MonetaryAmt: "0" })]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].amount_cents, 0);
});

test("a 0-quantity frequency rule survives when it has a qualifier", () => {
  const out = mapMysqlBenefits([
    myRow({
      BenefitType: 3,
      Quantity: "0",
      QuantityQualifier: 2,
      TimePeriod: 2,
    }),
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].quantity, 0);
  assert.strictEqual(out[0].period, "CalendarYear");
});

// ── Strict parsing, shared seam ──────────────────────────────────────────────

test("OD's -1 sentinel is absent, not a real percent", () => {
  const out = mapMysqlBenefits([myRow({ Percent: -1 })]);
  assert.strictEqual(out.length, 0);
  assert.strictEqual(out._dropped_reasons.coinsurance_invalid_percent, 1);
});

test("booleans, arrays and blank strings never coerce to a value", () => {
  for (const bad of [true, false, [], {}, "", "   ", "abc", NaN, Infinity]) {
    const out = mapMysqlBenefits([myRow({ Percent: bad })]);
    assert.strictEqual(out.length, 0, `Percent=${JSON.stringify(bad)} kept`);
  }
});

test("a negative deductible is rejected rather than stored", () => {
  const out = mapMysqlBenefits([myRow({ BenefitType: 2, MonetaryAmt: "-50" })]);
  assert.strictEqual(out.length, 0);
});

// ── Type map: pinned, never guessed ──────────────────────────────────────────

test("numeric 4 is Other and 5 is Note, per this file's own enum", () => {
  const other = mapMysqlBenefits([myRow({ BenefitType: 4 })]);
  const note = mapMysqlBenefits([myRow({ BenefitType: 5 })]);
  assert.strictEqual(other[0].type, "Other");
  assert.strictEqual(note[0].type, "Note");
  // Both are known types, so neither rides the unmapped-fallback counter.
  assert.deepStrictEqual(other._fallback_reasons, {});
  assert.deepStrictEqual(note._fallback_reasons, {});
});

test("Other and Note carry no interpreted value fields", () => {
  const out = mapMysqlBenefits([
    myRow({ BenefitType: 4, Percent: "80", MonetaryAmt: "50" }),
    myRow({ BenefitType: 5, Percent: "80" }),
  ]);
  for (const b of out) {
    assert.strictEqual(b.percent, undefined);
    assert.strictEqual(b.amount_cents, undefined);
    assert.strictEqual(b.quantity, undefined);
  }
});

test("no numeric CoPayment meaning is invented on this path", () => {
  // The REST path maps the STRING "CoPayment"; MySQL's BenefitType column is
  // numeric and this file's enum has no CoPayment entry. Guessing one would
  // retype real rows — so a numeric row can never become CoPayment here.
  const out = mapMysqlBenefits([
    myRow({ BenefitType: 4 }),
    myRow({ BenefitType: 6 }),
  ]);
  assert.ok(out.every((b) => b.type !== "CoPayment"));
});

// ── REST ↔ MySQL parity for the shared semantic core ─────────────────────────
//
// The two mappers read different row shapes (REST: PascalCase API fields with
// string-or-numeric BenefitType; MySQL: OD column names, numeric only), so the
// gate compares DECISIONS on equivalent inputs, not field-for-field output.
//
// Documented legitimate domain differences, deliberately NOT forced to parity:
//   * string "CoPayment" exists only on REST (MySQL's column is numeric);
//   * REST's qualifier-aware Years/Months period synthesis reads a string
//     QuantityQualifier; MySQL's is a numeric definition id;
//   * MySQL carries CategoryDesc/EbenefitCat, REST resolves category via covcat.

/** The REST-shaped twin of a MySQL row, for the fields both mappers read. */
const restRow = (over = {}) => ({
  BenefitNum: 700,
  PlanNum: 9001,
  PatPlanNum: 0,
  CovCatNum: 0,
  BenefitType: 1,
  CoverageLevel: "Individual",
  Percent: "80",
  ...over,
});

/** keep/drop/fallback decision summary, comparable across both mappers. */
function decisions(out) {
  return {
    kept: out.length,
    dropped: out._dropped,
    dropReasons: { ...out._dropped_reasons },
    fallbacks: Object.values(out._fallback_reasons).reduce((a, b) => a + b, 0),
  };
}

const SHARED_CASES = [
  { name: "valid percent", my: { Percent: "80" }, rest: { Percent: "80" } },
  {
    name: "explicit zero percent",
    my: { Percent: "0" },
    rest: { Percent: "0" },
  },
  { name: "OD -1 sentinel", my: { Percent: "-1" }, rest: { Percent: "-1" } },
  {
    name: "malformed percent",
    my: { Percent: "abc" },
    rest: { Percent: "abc" },
  },
  { name: "empty-string percent", my: { Percent: "" }, rest: { Percent: "" } },
  { name: "boolean percent", my: { Percent: true }, rest: { Percent: true } },
  { name: "array percent", my: { Percent: [] }, rest: { Percent: [] } },
  { name: "null percent", my: { Percent: null }, rest: { Percent: null } },
  {
    name: "valid deductible",
    my: { BenefitType: 2, MonetaryAmt: "50", Percent: null },
    rest: { BenefitType: 2, MonetaryAmt: "50", Percent: null },
  },
  {
    name: "zero deductible",
    my: { BenefitType: 2, MonetaryAmt: "0", Percent: null },
    rest: { BenefitType: 2, MonetaryAmt: "0", Percent: null },
  },
  {
    name: "absent deductible",
    my: { BenefitType: 2, MonetaryAmt: null, Percent: null },
    rest: { BenefitType: 2, MonetaryAmt: null, Percent: null },
  },
  {
    name: "negative deductible",
    my: { BenefitType: 2, MonetaryAmt: "-50", Percent: null },
    rest: { BenefitType: 2, MonetaryAmt: "-50", Percent: null },
  },
  {
    name: "limitation with no usable value",
    my: { BenefitType: 3, MonetaryAmt: null, Quantity: null, Percent: null },
    rest: { BenefitType: 3, MonetaryAmt: null, Quantity: null, Percent: null },
  },
  {
    name: "limitation monetary-only",
    my: { BenefitType: 3, MonetaryAmt: "0", Quantity: null, Percent: null },
    rest: { BenefitType: 3, MonetaryAmt: "0", Quantity: null, Percent: null },
  },
  {
    name: "unmapped numeric type",
    my: { BenefitType: 99 },
    rest: { BenefitType: 99 },
  },
];

for (const c of SHARED_CASES) {
  test(`parity — ${c.name}`, () => {
    const my = decisions(mapMysqlBenefits([myRow(c.my)]));
    const rest = decisions(mapBenefits([restRow(c.rest)], null, null));
    assert.deepStrictEqual(
      my,
      rest,
      `MySQL ${JSON.stringify(my)} vs REST ${JSON.stringify(rest)}`,
    );
  });
}

test("parity holds across a mixed batch, invariant included", () => {
  const myOut = mapMysqlBenefits(SHARED_CASES.map((c) => myRow(c.my)));
  const restOut = mapBenefits(
    SHARED_CASES.map((c) => restRow(c.rest)),
    null,
    null,
  );
  assert.deepStrictEqual(decisions(myOut), decisions(restOut));
  assert.strictEqual(
    Object.values(myOut._dropped_reasons).reduce((a, b) => a + b, 0),
    myOut._dropped,
  );
  assert.strictEqual(
    Object.values(restOut._dropped_reasons).reduce((a, b) => a + b, 0),
    restOut._dropped,
  );
});

test("both mappers use the same fallback reason key format", () => {
  const my = mapMysqlBenefits([myRow({ BenefitType: 99 })]);
  const rest = mapBenefits([restRow({ BenefitType: 99 })], null, null);
  assert.deepStrictEqual(
    Object.keys(my._fallback_reasons),
    Object.keys(rest._fallback_reasons),
  );
});

test("documented divergence: string CoPayment is REST-only", () => {
  // Asserted so the difference stays deliberate rather than becoming drift.
  const rest = mapBenefits(
    [restRow({ BenefitType: "CoPayment", MonetaryAmt: "25", Percent: null })],
    null,
    null,
  );
  assert.strictEqual(rest[0].type, "CoPayment");
  // The MySQL row cannot express it: BenefitType is numeric there.
  const my = mapMysqlBenefits([myRow({ BenefitType: "CoPayment" })]);
  assert.strictEqual(my[0].type, "Other");
  assert.strictEqual(
    my._fallback_reasons.type_CoPayment_unmapped_fallback,
    1,
    "an unexpected string type should ride the fallback counter, not vanish",
  );
});

// ── The mapper never silently discards a row anymore ─────────────────────────

test("mapMysqlBenefitRow always returns an entry, never null", () => {
  for (const bt of [1, 2, 3, 4, 5, 99, "weird", null, undefined]) {
    const out = mapMysqlBenefitRow(myRow({ BenefitType: bt }), {});
    assert.ok(
      out && typeof out === "object",
      `BenefitType=${bt} returned null`,
    );
    assert.ok(typeof out.type === "string");
  }
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
