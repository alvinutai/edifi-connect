/**
 * Pure eConnector service-name resolution for START_OD_ECONNECTOR (R-61).
 *
 * Newer Open Dental installs name the Windows service "OpenDentalEConnector",
 * older ones "OpenDenteConnector". handleStartOdEConnector discovers installed
 * services with an impure `sc query ... findstr` probe, then must turn the two
 * hardcoded candidates plus whatever was discovered into an ordered try-list.
 * That mapping lived inline in main.js and was untested; this helper owns ONLY
 * that mapping and performs no I/O, shell, WebSocket, Electron, or OD work.
 *
 * Ordering and filtering match the inline logic exactly:
 *   - candidates first, then discovered names, in order;
 *   - each name is allowlist-validated (validateServiceName rejects shell
 *     metacharacters before any name reaches a shell:true `sc` command);
 *   - non-eConnector names (e.g. OpenDentalService) are excluded so they can
 *     never be sc-started;
 *   - case-insensitive dedup keeps the first spelling seen.
 *
 * validateServiceName is reused from od-probes (byte-identical to main.js's
 * inline copy) so there is a single security regex, not a third copy.
 */
const { validateServiceName } = require("../od-probes");

const DEFAULT_CANDIDATES = ["OpenDentalEConnector", "OpenDenteConnector"];

function resolveEConnectorTryList(
  discoveredNames,
  candidates = DEFAULT_CANDIDATES,
) {
  const seen = new Set();
  const tryList = [];
  for (const rawName of [...candidates, ...(discoveredNames || [])]) {
    const v = validateServiceName(rawName);
    if (v.invalid) continue;
    const name = v.service;
    if (!/econnector/i.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tryList.push(name);
  }
  return tryList;
}

module.exports = { resolveEConnectorTryList, DEFAULT_CANDIDATES };
