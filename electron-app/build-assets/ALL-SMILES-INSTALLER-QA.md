# All Smiles v2.3.7 Installer — QA Checklist

**Installer:** `dist/EDiFi Connect Setup 2.3.7.exe`  
**Target office:** All Smiles Dentistry | UUID: `90c1b75a-9bf1-4c9c-84fe-ccd7e9ba1ed9`  
**Pre-delivery gate:** All items in Section A must pass before sending the link to Tessina.

---

## Section A — Clean Windows Environment Test

Test this on any Windows 10/11 machine that does NOT have EDiFi Connect installed.
Confirms v2.3.7 installs cleanly on a fresh machine.

| #   | Step                                                           | Expected Result                                                   | Pass/Fail |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------- | --------- |
| A1  | Copy `EDiFi Connect Setup 2.3.7.exe` to the test machine       | File transfers without corruption                                 |           |
| A2  | Double-click the .exe                                          | Windows SmartScreen shows "Windows protected your PC"             |           |
| A3  | Click "More info" → "Run anyway"                               | Installer begins (no wizard, no prompts)                          |           |
| A4  | Wait 15-30 seconds                                             | Installer completes silently                                      |           |
| A5  | Check system tray (bottom-right)                               | EDiFi Connect tray icon appears                                   |           |
| A6  | Verify config exists: `%APPDATA%\EDiFi Connect\config.json`    | File exists with office_id=`90c1b75a-9bf1-4c9c-84fe-ccd7e9ba1ed9` |           |
| A7  | Verify app installed: `%LOCALAPPDATA%\Programs\EDiFi Connect\` | Directory exists with `EDiFi Connect.exe`                         |           |
| A8  | Check Add/Remove Programs                                      | "EDiFi Connect 2.3.7" appears in installed programs               |           |
| A9  | Wait 60 seconds for tunnel to connect                          | Check Railway (see Section D) for AGENT_HELLO                     |           |

---

## Section B — Legacy v1.0.0 Simulation Test

Tests the upgrade path from v1.0.0 to v2.3.7 on a test machine.
Simulates the exact state of All Smiles before upgrade.

**Setup: Simulate v1.0.0 installation**

Run these commands on the test machine to simulate v1.0.0:

```batch
REM 1. Create legacy install directory
mkdir "%APPDATA%\EDiFiConnect"

REM 2. Create a simple node.exe stand-in (or copy real node.exe there)
REM    For simulation, just create the directory — the Registry key is what matters

REM 3. Add legacy startup registry entry
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" ^
  /v "EDiFiConnect" ^
  /t REG_SZ ^
  /d "\"%APPDATA%\EDiFiConnect\start.bat\"" ^
  /f

REM 4. Verify Registry entry exists
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "EDiFiConnect"
```

**Run the installer, then verify cleanup:**

| #   | Step                                                                                      | Expected Result                                                                                                                                              | Pass/Fail |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| B1  | Confirm Registry entry exists before install (see setup above)                            | Key `EDiFiConnect` is present                                                                                                                                |           |
| B2  | If simulating node.exe: copy a `node.exe` to `%APPDATA%\EDiFiConnect\node.exe` and run it | Process appears in Task Manager as `node.exe`                                                                                                                |           |
| B3  | Run `EDiFi Connect Setup 2.3.7.exe`                                                       | Installer runs silently                                                                                                                                      |           |
| B4  | After install: check Task Manager                                                         | `node.exe` from `%APPDATA%\EDiFiConnect\` is NO LONGER running                                                                                               |           |
| B5  | Verify Registry cleanup                                                                   | `reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "EDiFiConnect"` returns "ERROR: The system was unable to find the specified registry key" |           |
| B6  | Verify config pre-baked                                                                   | `%APPDATA%\EDiFi Connect\config.json` contains `"office_id":"90c1b75a-9bf1-4c9c-84fe-ccd7e9ba1ed9"`                                                          |           |
| B7  | Verify old config untouched                                                               | `%APPDATA%\EDiFiConnect\config.json` (no space) still exists unchanged                                                                                       |           |
| B8  | Restart Windows                                                                           | v1.0.0 does NOT auto-start; only v2.3.7 starts via Electron loginItem                                                                                        |           |
| B9  | Confirm port 47821                                                                        | After restart, only the Electron app is using port 47821 (check with `netstat -ano \| findstr :47821`)                                                       |           |

**Targeted kill verification (critical):**

| #   | Step                                                               | Expected Result                                                     | Pass/Fail |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------- | --------- |
| B10 | Run a system Node.js process before install (if Node is installed) | e.g., `node -e "setInterval(()=>{},1000)"` keeps a node.exe running |           |
| B11 | Run the installer                                                  | Install completes                                                   |           |
| B12 | Confirm system node.exe is STILL running                           | The non-EDiFiConnect node.exe survived — installer did NOT kill it  |           |

---

## Section C — Config Verification

Verify the pre-baked config.json is exactly correct before delivery.

**Open `%APPDATA%\EDiFi Connect\config.json` and confirm:**

```json
{
  "office_id": "90c1b75a-9bf1-4c9c-84fe-ccd7e9ba1ed9",
  "registered": true,
  "api_key": null,
  "od_api_url": null,
  "od_customer_key": null,
  "machine_id": null
}
```

| Field                          | Expected Value                         | Actual Value | Pass/Fail |
| ------------------------------ | -------------------------------------- | ------------ | --------- |
| office_id                      | `90c1b75a-9bf1-4c9c-84fe-ccd7e9ba1ed9` |              |           |
| registered                     | `true`                                 |              |           |
| api_key                        | `null`                                 |              |           |
| No other fields containing PHI | Confirm                                |              |           |

---

## Section D — Railway Verification (Post-Install)

Run these checks from EDF side using the admin API after the test install.
Do NOT run against All Smiles until the actual upgrade.

```
GET https://edifi-ai-eligibility-production.up.railway.app/api/v1/connect/offices/90c1b75a-9bf1-4c9c-84fe-ccd7e9ba1ed9/status?secret=...
```

**Expected response fields:**

| Field                       | Expected Value                                | Pass/Fail |
| --------------------------- | --------------------------------------------- | --------- |
| `bridge_connected`          | `true`                                        |           |
| `agent_version_known`       | `true`                                        |           |
| `db_record.app_version`     | `"2.3.7"`                                     |           |
| `remote_commands_supported` | `true`                                        |           |
| `db_record.capabilities`    | Contains `REPORT_STATUS`, `SYNC_OD_NOW`, etc. |           |

**If AGENT_HELLO not received within 5 minutes:**

- The app may need to reconnect. Check if the tray icon shows a red (disconnected) state.
- Right-click tray icon → check for connection status.
- The app reconnects automatically on tunnel disconnect; next reconnect will fire AGENT_HELLO.

---

## Section E — SmartScreen Handling Instructions

**For EDF to include in the staff message:**

> When Windows shows a security warning that says "Windows protected your PC":
>
> 1. Click **More info** (small text below the warning)
> 2. Click **Run anyway**
>
> This warning appears because our installer is not yet registered with Microsoft's
> security database. It is safe to proceed.

**What staff should NOT do:**

- Do not click "Don't run"
- Do not call IT to "whitelist" the application — this step is not needed
- Do not try to modify Windows Defender settings

---

## Section F — What Staff Does and Does Not Do

**Staff does:**

- Click the download link
- Double-click the .exe file
- Click "More info" → "Run anyway" if SmartScreen appears
- Wait ~30 seconds for install to complete

**Staff does NOT:**

- Configure anything
- Enter any codes or credentials
- Restart the computer (not required)
- Verify anything — EDF confirms upgrade via Railway

---

## Section G — Rollback Instructions (EDF Internal Only)

If v2.3.7 fails after install and v1.0.0 needs to be restored:

**Step 1:** Stop v2.3.7

- Task Manager → `EDiFi Connect.exe` → End Task
- Or: right-click tray icon → Quit

**Step 2:** Re-add v1.0.0 startup Registry entry

```batch
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" ^
  /v "EDiFiConnect" ^
  /t REG_SZ ^
  /d "\"%APPDATA%\EDiFiConnect\start.bat\"" ^
  /f
```

**Step 3:** Manually start v1.0.0

```batch
%APPDATA%\EDiFiConnect\start.bat
```

**Step 4:** Confirm v1.0.0 tunnel reconnects in Railway

- `bridge_connected: true` will appear within 30 seconds
- `app_version` will be null (v1.0.0 does not send AGENT_HELLO — expected)

**Step 5:** Diagnose v2.3.7 failure before re-attempting upgrade

---

## Section H — Pre-Delivery Checklist

Complete before sending the installer link to Tessina.

| #   | Gate                                                         | Status |
| --- | ------------------------------------------------------------ | ------ |
| H1  | Section A complete — clean install verified                  |        |
| H2  | Section B complete — legacy cleanup verified                 |        |
| H3  | Section C complete — config UUID verified                    |        |
| H4  | Section D complete — Railway AGENT_HELLO verified            |        |
| H5  | Installer hosted on Netlify with direct download URL         |        |
| H6  | Staff message drafted and reviewed by Alvin                  |        |
| H7  | Rollback instructions saved to BizBrain                      |        |
| H8  | EDF team has Railway dashboard access during delivery window |        |

**Do not send the link to Tessina until all H gates are checked.**
