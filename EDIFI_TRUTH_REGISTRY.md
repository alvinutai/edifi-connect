# EDiFi Truth Registry — Connect

Canonical mapping of problem → fix → commit → branch → release → office deployment → verification status.

## How to use this file

Before designing, coding, releasing, or deploying anything:

1. Search this registry for the problem keyword.
2. Note the canonical commit, branch, and release_tag.
3. Check `EDIFI_RELEASE_LEDGER.md` for release status.
4. Check `EDIFI_OFFICE_VERSION_LEDGER.md` for office deployment status.
5. If the current branch is missing the canonical commit, port it — do not re-implement.

---

## Critical fixes

| id | name | problem | commit | branch | files_changed | test_evidence | release_tag | github_status | latest/prerelease | deployed_offices | office_versions | verification_evidence | rollback_status | owner | last_verified |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FIX-UPDATER-GATING-2026-06-09 | Updater install gating | Auto-download + auto-install on check/quit strands offices without explicit command | e2a38e3 | master | `electron-app/main.js`, `electron-app/test/updater-hardening.test.js` | `updater-hardening.test.js`: 15 passed | v2.3.72 | not_released | latest (planned) | none | none | Manual port validated on `hotfix/connect-2.3.72-updater-gating` @ d9bb7ec | none | EDF engineering | 2026-06-20 |
| FIX-BROKEN-2.3.71-BUILD-2026-06-23 | Restore missing od-plan-probe / od-patnum-candidates | v2.3.71 clean builds crashed on launch with `MODULE_NOT_FOUND` for `electron-app/lib/od-plan-probe.js` | 2e64596 | hotfix/connect-2.3.72-updater-gating | `electron-app/lib/od-plan-probe.js`, `electron-app/lib/od-patnum-candidates.js` | `node --check electron-app/main.js` passed; `node --check service/bridge.js` passed | v2.3.72 | not_released | latest (planned) | none | none | `main.js` and `service/bridge.js` require paths resolve after restore | none | EDF engineering | 2026-06-23 |
| FIX-BENEFIT-CATEGORY-2026-06-20 | Restore omitted benefit-category dependency | `benefit-mapper.js` requires `./benefit-category` missing from baseline | 4fa80fc | release/connect-2.3.71 | `electron-app/lib/benefit-category.js` | `mysql-benefit-row`, `codenum-forwarding`, `benefit-mapper-parity`, `mapper-drift`: all pass | v2.3.71 | not_released | superseded by 2.3.72 | none | none | Full Connect benefit suite passes | contained by 2e64596 | EDF engineering | 2026-06-20 |

## Features

| id | name | problem | commit | branch | files_changed | test_evidence | release_tag | github_status | latest/prerelease | deployed_offices | office_versions | verification_evidence | rollback_status | owner | last_verified |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| FEAT-CODEGROUP-FORWARDING-2026-06-20 | OD CodeGroup identity on MySQL benefit path | Breakdown needs `code_group` / `code_group_desc` for accurate categorization | 4acada1 | release/connect-2.3.71 | `electron-app/od-mysql.js`, `electron-app/main.js`, tests | `mysql-benefit-row`, `benefit-mapper-parity`: pass | v2.3.71 | not_released | superseded by 2.3.72 | none | none | Branch tests pass | none | EDF engineering | 2026-06-20 |
| FEAT-CODENUM-PROC-FORWARDING-2026-06-11 | OD CodeNum/ProcCode on benefit rows | Benefit rows need `proc_code` for detailed breakdown | 5c3327c | release/connect-2.3.71 | `electron-app/od-mysql.js`, `electron-app/main.js`, `electron-app/lib/benefit-mapper.js`, tests | `codenum-forwarding.test.js`: pass | v2.3.71 | not_released | superseded by 2.3.72 | none | none | Branch tests pass | none | EDF engineering | 2026-06-11 |
| FEAT-3DAY-APPOINTMENT-WINDOW-2026-06-16 | 3-day appointment window + office timezone | UTC-vs-local date bug caused wrong-day sync for non-UTC offices | 23d7d8b | feat/connect-3day-window-allsmiles-pilot | `electron-app/lib/appointment-window.js`, `electron-app/main.js`, `electron-app/od-mysql.js`, `service/bridge.js`, tests | `appointment-window.test.js`: 15 passed | 2.3.69-allsmiles-pilot | staged_only | prerelease | none | none | Local verification passed; not yet installed at All Smiles | none | EDF engineering | 2026-06-17 |

## Landmines / superseded fixes

| id | name | problem | commit | branch | files_changed | test_evidence | release_tag | github_status | latest/prerelease | deployed_offices | office_versions | verification_evidence | rollback_status | owner | last_verified |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| LANDMINE-AUTO-INSTALL-2026-05-27 | Auto-install on app quit | `autoInstallOnAppQuit=true` + 10s timer caused silent forced upgrades | 6fba4aa | master | `electron-app/main.js` | none at commit | v2.3.14 | published | superseded | GitHub-update offices | 2.3.14 | `RELEASE_STATE_LOCK.md` records auto-update active | superseded by FIX-UPDATER-GATING | EDF engineering | 2026-05-27 |

---

## Update rules

- Every commit that fixes or significantly changes behavior gets a row.
- `release_tag` and `github_status` must be updated when a release is cut.
- `deployed_offices`, `office_versions`, and `verification_evidence` must be updated after every install/upgrade/verification.
- `rollback_status` must be updated immediately on any rollback or containment action.
