/**
 * resolveEConnectorTryList — pure R-61 eConnector service-name resolution.
 * Proves candidates come first, OpenDentalService and other non-eConnector
 * names are excluded, shell-metacharacter names are rejected, and the list is
 * case-insensitively deduped — identical to the former inline logic.
 * Run: node test/econnector-service.test.js
 */

const assert = require("assert");
const { resolveEConnectorTryList } = require("../lib/econnector-service");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n   ${e.message}`);
  }
}

test("discovered EConnector + Service → Service excluded, candidate deduped", () => {
  const list = resolveEConnectorTryList([
    "OpenDentalEConnector",
    "OpenDentalService",
  ]);
  assert.deepStrictEqual(list, ["OpenDentalEConnector", "OpenDenteConnector"]);
});

test("discovered old-name only → both candidates, old-name deduped", () => {
  const list = resolveEConnectorTryList(["OpenDenteConnector"]);
  assert.deepStrictEqual(list, ["OpenDentalEConnector", "OpenDenteConnector"]);
});

test("discovered name with shell metacharacter is rejected", () => {
  const list = resolveEConnectorTryList(["OpenDentalEConnector&calc"]);
  assert.deepStrictEqual(list, ["OpenDentalEConnector", "OpenDenteConnector"]);
  assert.ok(!list.includes("OpenDentalEConnector&calc"));
});

test("empty discovered → the two candidates in order", () => {
  const list = resolveEConnectorTryList([]);
  assert.deepStrictEqual(list, ["OpenDentalEConnector", "OpenDenteConnector"]);
});

test("case-insensitive dedup — lowercase discovered adds nothing", () => {
  const list = resolveEConnectorTryList(["opendentaleconnector"]);
  assert.deepStrictEqual(list, ["OpenDentalEConnector", "OpenDenteConnector"]);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
