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
 * Input is the normalized sync result returned by syncODData / syncODMySql:
 *   { ok: true,  skipped: true }            — sync skipped, treated as success
 *   { ok: true,  errors: [], pushes: N }    — every requested date succeeded
 *   { ok: false, errors: [...], pushes: N } — at least one date failed
 *
 * A missing / malformed result fails safe (FAILED, last_error preserved) rather
 * than risk reporting a clean completion the sync did not earn. Real callers
 * never return that shape, so behavior is identical to commit 7f98acd for every
 * result the code actually produces.
 */
function decideSyncCommandStatus(result) {
  const isSuccess = !!result && result.ok === true;
  const pushes = result != null && result.pushes != null ? result.pushes : 0;

  if (isSuccess) {
    return {
      commandStatus: "COMPLETED",
      clearLastError: true,
      errorCode: null,
      datesFailed: 0,
      appointmentCount: pushes,
    };
  }

  const errors = result && Array.isArray(result.errors) ? result.errors : null;
  return {
    commandStatus: "FAILED",
    clearLastError: false,
    errorCode: "SYNC_PARTIAL_FAILURE",
    datesFailed: errors ? errors.length : 1,
    appointmentCount: pushes,
  };
}

module.exports = { decideSyncCommandStatus };
