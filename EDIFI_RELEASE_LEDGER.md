# EDiFi Release Ledger — Connect

Per-release manifest: commits, tags, GitHub status, latest/prerelease, rollback status.

---

## v2.3.72 (planned — hotfix)

| Field | Value |
|---|---|
| tag | v2.3.72 |
| branch | hotfix/connect-2.3.72-updater-gating |
| commit | 2e64596 |
| parent | release/connect-2.3.71 |
| contains | e2a38e3 (updater gating), 4fa80fc (benefit-category), 6ef5516 (2.3.71 bump), 2e64596 (broken-build fix) |
| github_status | not_published |
| is_latest | planned |
| notes | Gated updater; no auto-download/auto-install. Fixes broken 2.3.71 build by restoring `od-plan-probe.js` and `od-patnum-candidates.js`. |
| rollback_to | v2.3.68 |

## v2.3.71 (broken — do not release)

| Field | Value |
|---|---|
| tag | v2.3.71 |
| branch | release/connect-2.3.71 |
| commit | 6ef5516 |
| github_status | not_published |
| is_latest | never |
| notes | **BROKEN BUILD**: clean builds crash on launch with `MODULE_NOT_FOUND` for `electron-app/lib/od-plan-probe.js`. Superseded by v2.3.72. |
| superseded_by | v2.3.72 |

## v2.3.69-allsmiles-pilot (staged)

| Field | Value |
|---|---|
| tag | 2.3.69-allsmiles-pilot |
| branch | feat/connect-3day-window-allsmiles-pilot |
| commit | 882e4c4 |
| github_status | staged_only |
| is_latest | never |
| notes | Direct-install-only pilot for 3-day appointment window. Does **NOT** include updater gating. Do not install without first confirming the target office can be upgraded to a gated build. |

## v2.3.14 (published — superseded)

| Field | Value |
|---|---|
| tag | v2.3.14 |
| branch | master |
| commit | fbfdccf |
| github_status | published |
| is_latest | no — hazardous |
| notes | Ungated auto-update (`autoDownload=true`, `autoInstallOnAppQuit=true`). Treat as legacy/hazardous. Offices still on this version should be moved to v2.3.72+. |
