# All Smiles Recovery Runbook — EDiFi Connect 2.4.0-rc.1

> Canonical, version-controlled recovery procedure. Supersedes the 2.3.70 break-glass
> runbook and all earlier v2.3.7 / v1.0.0 recovery instructions. DOCUMENT ONLY —
> execute only after explicit Alvin GO, via an EDF-controlled remote session.
> Single-office recovery, NOT a fleet release (see §11).

**Office:** All Smiles Dentistry — `90c1b75a-9bf1-4c9c-84fe-ccd7e9ba1ed9` (Tessina's OD machine, Electron runtime).
**Incident:** bridge down since `2026-06-22T04:59:09Z`. CHECK_FOR_UPDATE on the live 2.3.68 agent triggered the auto-install-on-download landmine → installed broken 2.3.71 (missing `lib/od-plan-probe.js`, crashes on launch) → headless zombie that blocks the installer.
**Recovery artifact:** `EDiFi Connect Setup 2.4.0-rc.1.exe`
**SHA256:** `E6370CA9D8CAA87E18AE14BCB620738D11D4F632C8E33D2373EADAEBB40BD4FC`
**Validated:** sandbox (a56917d4) 2026-06-23 — clean install, office_id preserved, reconnect, AGENT_HELLO v2.4.0-rc.1, updater gating intact, office-id pre-bake removed (no impersonation), force-close + silent install proven (exit 0 where bare installer aborted exit 2).

---

## 1. Pre-checks (read-only)

- [ ] Remote session arranged (EDF-controlled — see §5). Office grants access only.
- [ ] Installer present on EDF source + SHA256 = `E6370CA9…D4FC`.
- [ ] EDF-side DB confirms All Smiles DOWN (`is_connected=false`) via the read-only proxy.
- [ ] On target: `type "%APPDATA%\edifi-connect\config.json"` shows `"office_id":"90c1b75a-9bf1-4c9c-84fe-ccd7e9ba1ed9"` and `"registered":true`. **Missing or wrong office_id → STOP (§8).**

## 2. Config backup / restore

**Backup (before any change):**

- [ ] `copy "%APPDATA%\edifi-connect\config.json" "%APPDATA%\edifi-connect\config.backup-YYYY-MM-DD.json"`
- [ ] Confirm the backup file exists and is non-empty; note its path to Alvin.

**Restore (only if config is lost/corrupted during recovery):**

- [ ] `copy /Y "%APPDATA%\edifi-connect\config.backup-YYYY-MM-DD.json" "%APPDATA%\edifi-connect\config.json"`
- [ ] NEVER hand-edit config.json or re-enroll. The installer does not touch this file; restore is a safety net only.

## 3. SHA256 verification (before install)

- [ ] After transferring the installer to the target, verify on the target:
      `(Get-FileHash "C:\Temp\EDiFi-Connect-Setup-2.4.0-rc.1.exe" -Algorithm SHA256).Hash`
- [ ] Must equal `E6370CA9D8CAA87E18AE14BCB620738D11D4F632C8E33D2373EADAEBB40BD4FC`. **Mismatch → STOP (§8).**

## 4. Force-close + silent install (MANDATORY ORDER)

> The bare oneClick installer aborts (exit 2) when the agent is running; the broken All Smiles agent leaves a hung zombie. Force-close first, then silent-install.

- [ ] Dismiss the JavaScript-error dialog (click OK) if on screen.
- [ ] Force-close: `taskkill /F /IM "EDiFi Connect.exe" /T`
- [ ] Then: PowerShell `Get-Process -Name "EDiFi Connect" -ErrorAction SilentlyContinue | Stop-Process -Force`
- [ ] Confirm none running: `tasklist | findstr /i "EDiFi"` → empty.
- [ ] Silent install: `"C:\Temp\EDiFi-Connect-Setup-2.4.0-rc.1.exe" /S` → wait for exit code **0**.
- [ ] Confirm version: `(Get-Item "$env:LOCALAPPDATA\Programs\edifi-connect\EDiFi Connect.exe").VersionInfo.FileVersion` = `2.4.0-rc.1`.

## 5. AnyDesk / remote session governance

- Recovery is **break-glass only**, never normal workflow. EDF owns the remote operational burden.
- The **office initiates** the remote session (Tessina starts AnyDesk and grants control); EDF drives. No unattended/standing access — session is interactive and time-boxed to the recovery.
- The office performs **no technical steps** beyond granting the session. EDF runs every command.
- Installer reaches the target via the **remote-session file transfer**, NOT a browser download (downloads are blocked on the target).
- End the session immediately after validation; do not leave a connection open.
- Log the session (who, when, outcome) to BizBrain after completion.

## 6. PHI safety note

- All Smiles is a live office with real patient data. During the session: do **not** open, browse, or screenshot Open Dental patient records.
- `%APPDATA%\edifi-connect\edifi-connect.log` may contain patient identifiers. View **only** diagnostic lines (version, AGENT_HELLO, Tunnel, updater); do not copy or transmit raw log contents that include PHI. Redact before sharing.
- Do not record the session while PHI is visible. If PHI appears unexpectedly → stop, redact, do not capture.

## 7. Launch + Validation

**Launch (silent install does not auto-launch):**

- [ ] `Start-Process "$env:LOCALAPPDATA\Programs\edifi-connect\EDiFi Connect.exe"`. Do NOT open setup / do NOT enter an office code.

**On target:** process running; config still `90c1b75a…`; log tail shows in order `started v2.4.0-rc.1` → `Tunnel connected to EDiFi Cloud` → `AGENT_HELLO sent: v2.4.0-rc.1` → `update_status available=false, downloaded=false`.

**EDF side (read-only DB):** `is_connected=true`, `app_version=2.4.0-rc.1`, `last_seen` advances past `connected_at`, `safe_config` all present, full capabilities.

## 8. Hard stops (ABORT — do not improvise)

- Config missing on target, or `office_id ≠ 90c1b75a…`.
- Installer SHA256 mismatch on target.
- App opens the **setup / enrollment** screen (config not detected — do NOT enroll).
- Installed/launched version ≠ `2.4.0-rc.1`.
- Bridge does not reconnect → go to §9 rollback.
- PHI visible → stop, redact, do not capture.
- **NEVER run `CHECK_FOR_UPDATE` on a v2.3.68 agent** — this is the exact action that armed the auto-install landmine and caused this outage. Never run `CHECK_FOR_UPDATE`/`DOWNLOAD_UPDATE` on any 2.3.68 agent, before or after rollback.
- Also never: `SYNC_OD_NOW`, `WRITE_OD_BENEFITS`, Railway/env flag changes, GitHub publish, re-enroll / office_id change, config hand-edit, touch sandbox/production, deploy.

## 9. Rollback

**Trigger criteria (any one):**

- Launched version ≠ `2.4.0-rc.1`.
- Setup/enrollment screen appears (config not detected).
- App crashes on launch (JS-error dialog returns).
- No reconnect within ~3 minutes (no `is_connected=true`, no AGENT_HELLO).
- Config corrupted or office_id changed.
- Any hard stop in §8.

**Rollback steps:**

- [ ] `taskkill /F /IM "EDiFi Connect.exe" /T` (force-close).
- [ ] Reinstall a rollback build (see §10 manifest) via the same force-close + `/S` + launch procedure. **Preferred:** 2.3.70 recovery (e2a38e3) — gating-fixed, zero landmine. Baseline alternative: 2.3.68 (prod Latest) — only with the §8 CHECK_FOR_UPDATE hard stop.
- [ ] If config was lost, restore from backup (§2). Never hand-edit.

**Rollback verification:**

- [ ] Installed version = the rollback build's version.
- [ ] Process running; no crash dialog.
- [ ] Log shows `started v<rollback>` → `Tunnel connected` → `AGENT_HELLO sent: v<rollback>`.
- [ ] Config still `office_id 90c1b75a…`, `registered:true`.
- [ ] EDF-side DB: `is_connected=true`, `app_version=<rollback>`, `last_seen` advances.
- [ ] If neither 2.4.0-rc.1 nor the rollback connects → capture diagnostic log lines read-only (no PHI), report to Alvin, leave machine as-is.

## 10. Staging manifest

| Role                                  | Build            | Installer file                       | SHA256                                                                               | Notes                                                                                                                                                                         |
| ------------------------------------- | ---------------- | ------------------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primary recovery**                  | 2.4.0-rc.1       | `EDiFi Connect Setup 2.4.0-rc.1.exe` | `E6370CA9…D4FC` (`E6370CA9D8CAA87E18AE14BCB620738D11D4F632C8E33D2373EADAEBB40BD4FC`) | validated; gating-fixed; `od-plan-probe.js` present; office-id pre-bake removed                                                                                               |
| **Rollback (preferred, gating-safe)** | 2.3.70 (e2a38e3) | `EDiFi Connect Setup 2.3.70.exe`     | `8B23F8D56B7FBC57245F33A0ABDEAEC02675803C4AB7F1F9913FBFD94AA965A3`                   | no auto-install landmine                                                                                                                                                      |
| **Rollback baseline (prod Latest)**   | 2.3.68           | `EDiFi Connect Setup 2.3.68.exe`     | verify on target before use                                                          | production Latest All Smiles ran pre-outage; SAFE AT REST ONLY while Latest stays 2.3.68 and **CHECK_FOR_UPDATE is NEVER run** (this build carries the auto-install landmine) |

## 11. Scope

This is a **single-office recovery of All Smiles only**, not a fleet release. 2.4.0-rc.1 is a pre-release: it is NOT promoted to production GitHub Latest (which remains 2.3.68). With `allowPrerelease=false`, an agent on 2.4.0-rc.1 will not auto-update off it. Promoting 2.4.0 to the fleet is a separate release-train decision and is out of scope here.
