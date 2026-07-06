const { test } = require("node:test");
const assert = require("node:assert");
const {
  classifyListenerState,
  buildDiagnosticSummary,
} = require("./od-listener-decision");

const LISTEN = { listening: true };
const DOWN = { listening: false };

test("OD not installed -> OD_NOT_FOUND, not fixable", () => {
  const v = classifyListenerState({ detect: { found: false } });
  assert.strictEqual(v.case, "OD_NOT_FOUND");
  assert.strictEqual(v.fixable, false);
});

test("30222 up + 200 -> OK", () => {
  const v = classifyListenerState({
    detect: { found: true },
    ports: { 30222: LISTEN, 30223: DOWN },
    restAuth: { http_status: 200, auth_accepted: true },
  });
  assert.strictEqual(v.case, "OK");
  assert.strictEqual(v.fixable, true);
  assert.strictEqual(v.servingPort, 30222);
});

test("API Service on 30223 only -> LISTENER_UP via servingPort 30223", () => {
  const v = classifyListenerState({
    detect: { found: true },
    ports: { 30222: DOWN, 30223: LISTEN },
  });
  assert.strictEqual(v.case, "LISTENER_UP");
  assert.strictEqual(v.fixable, true);
  assert.strictEqual(v.servingPort, 30223);
});

test("no listener + API off -> Case B (enable API), self-serve", () => {
  const v = classifyListenerState({
    detect: { found: true },
    ports: { 30222: DOWN, 30223: DOWN },
    ui: { apiEnabled: false },
  });
  assert.strictEqual(v.case, "B");
  assert.strictEqual(v.fixable, true);
  assert.strictEqual(v.showEnableSteps, "api");
});

test("no listener + API state unknown -> Case B", () => {
  const v = classifyListenerState({
    detect: { found: true },
    ports: { 30222: DOWN, 30223: DOWN },
  });
  assert.strictEqual(v.case, "B");
});

test("API on + eConnector STOPPED + no listener -> Case E, guided", () => {
  const v = classifyListenerState({
    detect: { found: true },
    ports: { 30222: DOWN, 30223: DOWN },
    service: { exists: true, state: "STOPPED" },
    ui: { apiEnabled: true },
  });
  assert.strictEqual(v.case, "E");
  assert.strictEqual(v.fixable, true);
  assert.strictEqual(v.showEnableSteps, "econnector");
});

test("API on + service RUNNING + no listener -> Case E, escalate", () => {
  const v = classifyListenerState({
    detect: { found: true },
    ports: { 30222: DOWN, 30223: DOWN },
    service: { exists: true, state: "RUNNING" },
    ui: { apiEnabled: true },
  });
  assert.strictEqual(v.case, "E");
  assert.strictEqual(v.fixable, false);
  assert.strictEqual(v.escalate, true);
});

test("30222 up + 401 + no key -> Case C, add key (self-serve)", () => {
  const v = classifyListenerState({
    detect: { found: true },
    ports: { 30222: LISTEN, 30223: DOWN },
    restAuth: { http_status: 401 },
    ui: { hasCustomerKey: false },
  });
  assert.strictEqual(v.case, "C");
  assert.strictEqual(v.fixable, true);
  assert.strictEqual(v.showKeyStep, true);
});

test("30222 up + 401 + key present -> Case C, escalate", () => {
  const v = classifyListenerState({
    detect: { found: true },
    ports: { 30222: LISTEN, 30223: DOWN },
    restAuth: { http_status: 401 },
    ui: { hasCustomerKey: true },
  });
  assert.strictEqual(v.case, "C");
  assert.strictEqual(v.fixable, false);
  assert.strictEqual(v.escalate, true);
});

test("30222 up + 401 despite key sent -> Case C escalate, never OK", () => {
  // diag-rest-auth sends the key; a 401 is a real rejection, not an expected
  // unauthenticated 401. auth_accepted is the only thing that yields OK.
  const v = classifyListenerState({
    detect: { found: true },
    ports: { 30222: LISTEN, 30223: DOWN },
    restAuth: { http_status: 401, auth_accepted: false },
    ui: { hasCustomerKey: true },
  });
  assert.strictEqual(v.case, "C");
  assert.strictEqual(v.escalate, true);
});

test("30222 up, no rest-auth yet (pre-register) -> LISTENER_UP, not escalate", () => {
  const v = classifyListenerState({
    detect: { found: true },
    ports: { 30222: LISTEN, 30223: DOWN },
  });
  assert.strictEqual(v.case, "LISTENER_UP");
  assert.strictEqual(v.fixable, true);
  assert.strictEqual(v.escalate, false);
});

test("30222 up, rest-auth says URL not configured -> LISTENER_UP", () => {
  const v = classifyListenerState({
    detect: { found: true },
    ports: { 30222: LISTEN, 30223: DOWN },
    restAuth: {
      auth_accepted: false,
      http_status: null,
      error_category: "OD_API_URL_NOT_CONFIGURED",
    },
  });
  assert.strictEqual(v.case, "LISTENER_UP");
});

test("30222 up + non-401 status without auth_accepted -> UNKNOWN escalate", () => {
  const v = classifyListenerState({
    detect: { found: true },
    ports: { 30222: LISTEN, 30223: DOWN },
    restAuth: { http_status: 500, auth_accepted: false },
  });
  assert.strictEqual(v.case, "UNKNOWN");
  assert.strictEqual(v.escalate, true);
});

test("blind input (no probes) -> UNKNOWN, escalate", () => {
  const v = classifyListenerState({ detect: { found: true } });
  assert.strictEqual(v.case, "UNKNOWN");
  assert.strictEqual(v.escalate, true);
});

test("diagnostic summary carries only safe fields", () => {
  const summary = buildDiagnosticSummary({
    detect: { found: true, version: "25.3.83.0", apiUrl: "http://secret" },
    ports: { 30222: DOWN, 30223: LISTEN },
    service: { exists: true, state: "RUNNING" },
    restAuth: { http_status: 401, error_category: "AUTH_REJECTED_401" },
  });
  assert.deepStrictEqual(summary, {
    case: "C",
    od_found: true,
    od_version: "25.3.83.0",
    port_30222_listening: false,
    port_30223_listening: true,
    service_exists: true,
    service_state: "RUNNING",
    rest_http_status: 401,
    rest_error_category: "AUTH_REJECTED_401",
  });
  assert.ok(!("apiUrl" in summary));
});
