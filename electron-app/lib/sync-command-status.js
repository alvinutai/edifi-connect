/**
 * Pure decision for the SYNC_OD_NOW command outcome.
 *
 * Both command handlers (electron-app/main.js and service/bridge.js) run the
 * same per-date sync and then must decide, identically, whether to report
 * COMPLETED or FAILED and whether it is safe to clear od_sync_status.last_error.
 * That decision lived inline in both files; a single date failure must never be
 * reported as a clean COMPLETED, and last_error must survive a partial failure.
 *
 * This helper owns ONLY that mapping. It performs no I/O, logging, WebSocket,
 * Electron, database, or Open Dental work — callers keep all of that.
 *
 * Three explicit, mutually exclusive cases so the fail-safe split is mechanical:
 *   { ok: true,  skipped: true }            — sync skipped, treated as success
 *   { ok: true,  errors: [], pushes: N }    — every requested date succeeded
 *   { ok: false, errors: [...], pushes: N } — well-formed failure, N pushed
 * Anything else (null, undefined, non-object, missing/non-boolean `ok`) is a
 * MALFORMED result and fails closed to a generic single failure — it must never
 * carry over a stray `pushes` or report zero failed dates. Real callers never
 * return that shape, so behavior is identical to commit 7f98acd for every
 * result the code actually produces.
 */
function decideSyncCommandStatus(result) {
  const isObject = !!result && typeof result === "object";
  const pushCount = (r) => (r.pushes != null ? r.pushes : 0); // mirrors `?? 0`

  if (isObject && result.ok === true) {
    return {
      commandStatus: "COMPLETED",
      clearLastError: true,
      errorCode: null,
      datesFailed: 0,
      appointmentCount: pushCount(result),
    };
  }

  if (isObject && result.ok === false) {
    return {
      commandStatus: "FAILED",
      clearLastError: false,
      errorCode: "SYNC_PARTIAL_FAILURE",
      datesFailed: Array.isArray(result.errors) ? result.errors.length : 1,
      appointmentCount: pushCount(result),
    };
  }

  // Malformed / missing result — fail closed, no carried-over counts.
  return {
    commandStatus: "FAILED",
    clearLastError: false,
    errorCode: "SYNC_PARTIAL_FAILURE",
    datesFailed: 1,
    appointmentCount: 0,
  };
}

module.exports = { decideSyncCommandStatus };
