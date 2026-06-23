# EDiFi Fix Ledger — Connect

Running narrative log of fixes attempted, applied, reverted, superseded, or contained.

---

## 2026-06-23 — Broken v2.3.71 build / All Smiles outage root cause

- **Discovered:** `release/connect-2.3.71` clean build crashes on launch with `MODULE_NOT_FOUND: electron-app/lib/od-plan-probe.js`.
- **Root cause:** `od-plan-probe.js` and `od-patnum-candidates.js` were untracked and not included in the release branch, but `main.js:38` and `service/bridge.js:31` require them.
- **Impact:** v2.3.71 installer unusable; contributes to All Smiles remaining on v2.3.68.
- **Decision:** Restore both files byte-identical from the `e2a38e3` recovery worktree on `hotfix/connect-2.3.72-updater-gating`.
- **Commit:** `2e64596`
- **Verification:**
  - `node --check electron-app/main.js` passed
  - `node --check service/bridge.js` passed
- **Registry updated:**
  - `EDIFI_TRUTH_REGISTRY.md` row `FIX-BROKEN-2.3.71-BUILD-2026-06-23`
  - `EDIFI_RELEASE_LEDGER.md` v2.3.71 marked **BROKEN — do not release**
  - `EDIFI_RELEASE_LEDGER.md` v2.3.72 noted as containing the fix

## 2026-06-20 — benefit-category dependency gap

- **Discovered:** Tests fail on `release/connect-2.3.71` with `MODULE_NOT_FOUND ./benefit-category`.
- **Root cause:** Commit `383839d` (which adds `benefit-category.js`) was not in the approved cherry-pick list for the release branch.
- **Decision:** Manually extract only `electron-app/lib/benefit-category.js` from `383839d`; do not cherry-pick the entire commit.
- **Commit:** `4fa80fc`
- **Verification:**
  - `codenum-forwarding.test.js`: 13 passed
  - `benefit-mapper-parity.test.js`: 15 passed
  - `mapper-drift.test.js`: 13 passed
  - `mysql-benefit-row.test.js`: 15 passed
- **Registry updated:**
  - `EDIFI_TRUTH_REGISTRY.md` row `FIX-BENEFIT-CATEGORY-2026-06-20`

## 2026-06-20 — Updater gating manual port

- **Discovered:** `release/connect-2.3.71` (and baseline v2.3.68) configure `autoDownload=true` and `autoInstallOnAppQuit=true`, with a 10-second auto-install timer in `update-downloaded`.
- **Root cause:** `CHECK_FOR_UPDATE` triggers silent download; `update-downloaded` triggers forced quit/install.
- **Decision:** Manually port only the updater-gating logic from `e2a38e3` (excluding unrelated prettier reformatting and version bump).
- **Commit:** `d9bb7ec`
- **Verification:**
  - `updater-hardening.test.js`: 15 passed
  - Full Connect benefit suite: all pass
- **Registry updated:**
  - `EDIFI_TRUTH_REGISTRY.md` row `FIX-UPDATER-GATING-2026-06-09` (canonical commit `e2a38e3`; port commit `d9bb7ec`)
