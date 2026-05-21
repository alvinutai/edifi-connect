# EDiFi Connect v2.4.0 — Staff Installation Instructions

**For: All Smiles Dentistry front desk or IT coordinator**  
**Time required: approximately 3 minutes**  
**Computer required: the same computer that runs Open Dental**

---

## What This Does

This update replaces the old EDiFi Connect software with a new version that gives your EDiFi account full eligibility intelligence. The update runs automatically — you do not need to configure anything.

---

## Steps

1. **Download the installer** by clicking the link EDF sent you.
   The file will be named: `EDiFi Connect Setup 2.4.0.exe`

2. **Double-click the downloaded file** to run the installer.

3. **If Windows shows a security warning** that says "Windows protected your PC":
   - Click **More info**
   - Click **Run anyway**

   This warning appears because the installer is not yet signed with a security certificate. It is safe to proceed.

4. **Wait about 30 seconds.** The installer runs automatically with no wizard or prompts.

5. **You are done.** The EDiFi Connect icon (the blue EDF logo) will appear in your system tray (bottom-right corner of your screen). Hover over it to see connection status.

---

## What Happens Automatically

You do not need to do any of the following — the installer handles all of it:

- Stops the old EDiFi Connect software
- Removes the old startup entry
- Installs the new version
- Pre-configures your office connection
- Starts the new software
- Reconnects to EDiFi automatically

---

## If Something Goes Wrong

Contact EDF: alvin@elitedentalforce.com or your assigned EDF support contact.

Do not attempt to uninstall or reinstall on your own.

---

## Rollback (EDF Internal Only)

If v2.4.0 fails and v1.0.0 needs to be restored:

1. Kill Electron process: Task Manager → `EDiFi Connect.exe` → End Task
2. Re-add Registry startup entry:
   ```
   reg add "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run" /v "EDiFiConnect" /t REG_SZ /d "\"%APPDATA%\EDiFiConnect\start.bat\"" /f
   ```
3. Run manually: `%APPDATA%\EDiFiConnect\start.bat`
4. Verify tunnel at Railway: bridge_connected=true (AGENT_HELLO will not appear — v1.0.0 behavior)
