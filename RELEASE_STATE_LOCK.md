# EDiFi Connect v2.3.14 — Release State Lock

> ⚠️ **HAZARD — 2026-06-23**: This lock describes v2.3.14, which has ungated auto-update behavior (`autoDownload=true`, `autoInstallOnAppQuit=true`). That behavior can strand offices. Do not run `CHECK_FOR_UPDATE` on offices until they are on a version containing commit `e2a38e3` or later. See `EDIFI_TRUTH_REGISTRY.md` for current branches.
>
> **Current Connect branches:**
> - `release/connect-2.3.71` @ `6ef5516` — **BROKEN BUILD, DO NOT RELEASE**
> - `hotfix/connect-2.3.72-updater-gating` @ `2e64596` — next candidate

**Locked:** 2026-05-27  
**Status: RELEASED — Latest on GitHub. Auto-update active.**

Do not re-run release steps. Do not rebuild installer. Do not re-upload latest.yml.

---

## Release State

| Field                 | Value                                                  |
| --------------------- | ------------------------------------------------------ |
| Version               | v2.3.14                                                |
| GitHub release        | Published — `Latest`                                   |
| Tag                   | `v2.3.14`                                              |
| Published at          | 2026-05-27T22:21:59Z                                   |
| `latest.yml` uploaded | Yes                                                    |
| Auto-update active    | Yes — `autoDownload=true`, `autoInstallOnAppQuit=true` |
| Prior Latest          | v2.3.13 (no longer Latest)                             |

### GitHub Release Assets

| Asset                                     | Present                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `EDiFi.Connect.Setup.2.3.14.exe`          | Yes (78.2 MB)                                                          |
| `EDiFi.Connect.Setup.2.3.14.exe.blockmap` | Yes                                                                    |
| `latest.yml`                              | Yes — `url` and `path` both reference `EDiFi.Connect.Setup.2.3.14.exe` |

### `latest.yml` Content (locked)

```yaml
version: 2.3.14
files:
  - url: EDiFi.Connect.Setup.2.3.14.exe
    sha512: tFCRyFfyeyGuGfIk3NXJlEmw2uzKxraWTn4y8/JSy1a6JScB4IfqzQHEDNbndmhJz4v7CTIxv0Pqq9nEdkWP9g==
    size: 82006328
path: EDiFi.Connect.Setup.2.3.14.exe
sha512: tFCRyFfyeyGuGfIk3NXJlEmw2uzKxraWTn4y8/JSy1a6JScB4IfqzQHEDNbndmhJz4v7CTIxv0Pqq9nEdkWP9g==
releaseDate: "2026-05-27T21:54:56.724Z"
```

---

## Commits Included in v2.3.14

| Hash      | Message                                               |
| --------- | ----------------------------------------------------- |
| `fbfdccf` | `chore: bump EDiFi Connect to v2.3.14`                |
| `8fe4362` | `fix: forward sync date through OD REST sync`         |
| `2a4f661` | `fix: align Open Dental eConnector auth and API path` |

**Files changed since v2.3.13:** `electron-app/main.js` only (8 insertions, 6 deletions) and `electron-app/package.json` (version bump only).

### What the fixes do

- **`2a4f661`** — Corrected the `Authorization` header format and API path for the Open Dental eConnector REST endpoint. Required for REPORT_OD_STATUS and OD REST sync to reach the local OD server correctly.
- **`8fe4362`** — `SYNC_OD_NOW` now forwards the `sync_date` payload field through the OD REST fallback path (`syncODData()`). Previously the date was ignored and today's date was hardcoded. Fix: `syncDate ?? new Date().toISOString().split("T")[0]`.

---

## Sandbox Validation Proof

**Office:** `a56917d4-0c1f-4e06-b2c6-60a92ec1d08c` (Alvin internal sandbox)  
**Validated:** 2026-05-27

| Check                                                                                 | Result    |
| ------------------------------------------------------------------------------------- | --------- |
| Installer installed cleanly (NSIS exit 0)                                             | Pass      |
| Installed ASAR version confirmed 2.3.14                                               | Pass      |
| `AGENT_HELLO from a56917d4: v2.3.14 (win32)` observed in Railway logs at 22:02:14 UTC | Pass      |
| `REPORT_STATUS` (cmd `6d159dfb`) → COMPLETED                                          | Pass      |
| `REPORT_OD_STATUS` (cmd `cd68f709`) → COMPLETED                                       | Pass      |
| Read-only OD REST `/appointments?date=2026-04-27` → HTTP 200, 1 scheduled appointment | Pass      |
| No SYNC_OD_NOW, writeback, Stedi, portal, or voice triggered during validation        | Confirmed |

---

## Auto-Update State

Auto-update is live as of 2026-05-27T22:21:59Z.

**Mechanism:** On every app startup, `autoUpdater.checkForUpdates()` fetches `latest.yml` from `https://github.com/alvinutai/edifi-connect/releases/latest/download/latest.yml`. If the version in `latest.yml` is newer than the running version, `electron-updater` begins downloading silently (`autoDownload=true`). The update is applied on the next app quit (`autoInstallOnAppQuit=true`). No user prompt is shown.

**Expected behavior per office:**

- Any NSIS-installed agent running v2.3.13 or earlier will detect v2.3.14 on next startup.
- Download happens silently in the background.
- Installation applies on next quit/restart.
- Agent reconnects with `AGENT_HELLO: v2.3.14`.

---

## Office Status

| Office               | ID         | Known Version                                                                               | v2.3.14 Status                                                                                                        |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Alvin sandbox        | `a56917d4` | v2.3.14                                                                                     | Confirmed — AGENT_HELLO observed 2026-05-27                                                                           |
| All Smiles (Tessina) | `90c1b75a` | Last confirmed: v2.3.9 at install (2026-05-18); may have auto-updated to v2.3.13 since then | **Pending** — has not connected through bridge since v2.3.14 release. Will auto-update on next EDiFi Connect restart. |

---

## Rollback Artifact

v2.3.13 installer is available and intact in the GitHub release.

| Asset                                     | Location                 |
| ----------------------------------------- | ------------------------ |
| `EDiFi.Connect.Setup.2.3.13.exe`          | GitHub release `v2.3.13` |
| `EDiFi.Connect.Setup.2.3.13.exe.blockmap` | GitHub release `v2.3.13` |
| `latest.yml` (v2.3.13)                    | GitHub release `v2.3.13` |

**To roll back a single office:** Run `EDiFi.Connect.Setup.2.3.13.exe` on the affected machine (via AnyDesk or direct access). NSIS installs over the existing version. Confirm with REPORT_STATUS showing `app_version: 2.3.13`.

**To stop all further auto-updates to v2.3.14:** Delete the `latest.yml` asset from the v2.3.14 GitHub release. electron-updater will no longer detect v2.3.14. Re-upload v2.3.13's `latest.yml` to the v2.3.14 release to force agents back to v2.3.13 on next check (requires explicit Alvin approval — this is an irreversible-direction action).

---

## What Is Safe Next (No Approval Required)

- Monitor Railway logs for `AGENT_HELLO from 90c1b75a: v2.3.14` to confirm All Smiles auto-updated.
- Issue `REPORT_STATUS` to any office to check current version.
- Issue `REPORT_OD_STATUS` to any office to confirm OD connectivity post-update.
- Read Railway logs passively.
- Read this file.

---

## What Is Forbidden Without Explicit Alvin Approval

- Running `SYNC_OD_NOW` on any office.
- Running writeback (`WRITE_OD_BENEFITS`) on any office.
- Running Stedi, portal scraping, or voice on any office.
- Rebuilding the v2.3.14 installer.
- Uploading any new file to the v2.3.14 GitHub release.
- Re-uploading `latest.yml` (would change the auto-update target).
- Creating v2.3.15 or any new release.
- Touching Railway variables or deploying backend/frontend.
- Any direct contact with Tessina or the All Smiles machine.
- Initiating a rollback to v2.3.13.

---

## Tomorrow Monitoring Checklist

Run these in order after session start. All are read-only.

- [ ] Check Railway logs for `AGENT_HELLO from 90c1b75a: v2.3.14` — confirms All Smiles auto-updated overnight.
- [ ] If All Smiles AGENT_HELLO not seen: check what version is reported, check if the machine was online, do not force anything.
- [ ] Issue `REPORT_STATUS` to All Smiles office `90c1b75a` — confirm `app_version: 2.3.14` in the result payload.
- [ ] Issue `REPORT_OD_STATUS` to All Smiles office `90c1b75a` — confirm OD eConnector reachable and responding.
- [ ] Check Railway health: `GET /api/v1/health` → `status: ok`.
- [ ] Confirm no unexpected commands are in SENT/TIMEOUT state from today's session.
- [ ] If all checks pass: v2.3.14 rollout is complete. No further release action needed.
- [ ] If any check fails: report to Alvin before taking any action.
