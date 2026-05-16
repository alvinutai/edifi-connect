; EDiFi Connect — Custom NSIS Install Script
; Handles safe upgrade from v1.0.0 (legacy Node.js service) to v2.3.7 (Electron).
;
; v1.0.0 lives at:  %APPDATA%\EDiFiConnect\            (no space, no uninstaller)
; v2.3.7 installs:  %LOCALAPPDATA%\Programs\EDiFi Connect\
; v2.3.7 config:    %APPDATA%\EDiFi Connect\config.json (Electron userData)
;
; This macro runs after files are extracted but before the app starts.

!macro customInstall

  ; ── 1. Stop legacy v1.0.0 node.exe (TARGETED — does not affect other Node processes) ─
  ;
  ; v1.0.0 runs as node.exe at %APPDATA%\EDiFiConnect\node.exe, binding port 47821.
  ; v2.3.7 also binds port 47821 for its local HTTP server. If the legacy process
  ; is still running, v2.3.7 will fail to start.
  ;
  ; Strategy: write a temp PowerShell script that filters ONLY node.exe processes
  ; whose executable path contains "\EDiFiConnect\". This is safe because:
  ;   - v1.0.0 ships a bundled node.exe inside %APPDATA%\EDiFiConnect\
  ;   - System Node.js (if installed) lives in Program Files, not AppData
  ;   - Developer tools' node.exe will NOT match the \EDiFiConnect\ filter
  ;
  ; The script also attempts a port-based fallback: if a node process owns port 47821,
  ; kill it only if its path contains EDiFiConnect (double confirmation).

  ; Write targeted kill script to a temp .ps1 file to avoid inline quoting conflicts
  GetTempFileName $R0
  StrCpy $R1 "$R0.ps1"

  FileOpen $R2 $R1 w
  FileWrite $R2 "# EDiFi Connect v1.0.0 targeted process cleanup$\r$\n"
  FileWrite $R2 "# Kills ONLY node.exe processes running from the legacy EDiFiConnect directory.$\r$\n"
  FileWrite $R2 "# Does NOT affect system Node.js installations or other Node processes.$\r$\n"
  FileWrite $R2 "$\r$\n"
  FileWrite $R2 "# Approach 1: kill by executable path (primary)$\r$\n"
  FileWrite $R2 "Get-Process -Name node -ErrorAction SilentlyContinue |$\r$\n"
  FileWrite $R2 "    Where-Object { $$_.Path -like '*\EDiFiConnect\*' } |$\r$\n"
  FileWrite $R2 "    Stop-Process -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $R2 "$\r$\n"
  FileWrite $R2 "# Approach 2: kill by port 47821 (fallback — only if process is node.exe in EDiFiConnect)$\r$\n"
  FileWrite $R2 "$$portLine = netstat -ano 2>$$null | Where-Object { $$_ -match ':47821\s' } | Select-Object -First 1$\r$\n"
  FileWrite $R2 "if ($$portLine) {$\r$\n"
  FileWrite $R2 "    $$pid47821 = ($$portLine.Trim() -split '\s+')[-1]$\r$\n"
  FileWrite $R2 "    if ($$pid47821 -match '^\d+$$') {$\r$\n"
  FileWrite $R2 "        $$proc = Get-Process -Id $$pid47821 -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $R2 "        if ($$proc -and $$proc.Name -eq 'node' -and $$proc.Path -like '*EDiFiConnect*') {$\r$\n"
  FileWrite $R2 "            Stop-Process -Id $$pid47821 -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWrite $R2 "        }$\r$\n"
  FileWrite $R2 "    }$\r$\n"
  FileWrite $R2 "}$\r$\n"
  FileClose $R2

  ; Execute the script silently — no window flash, no prompt
  nsExec::Exec "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -NonInteractive -File $\"$R1$\""

  ; Allow OS to fully release port 47821 before v2.3.7 starts
  Sleep 2000

  ; Clean up temp files
  Delete "$R1"
  Delete "$R0"

  ; ── 2. Remove v1.0.0 Windows startup registry entry ──────────────────────────
  ; v1.0.0's install.bat added this entry to auto-start on login:
  ;   HKCU\...\Run\EDiFiConnect → "%APPDATA%\EDiFiConnect\start.bat"
  ; If left in place, v1.0.0 restarts on next Windows login, causing a port 47821
  ; conflict that prevents v2.3.7 from starting. v2.3.7 uses Electron's
  ; loginItemSettings API instead, which is separate from this key.
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "EDiFiConnect"

  ; ── 3. Create v2.3.7 config directory ────────────────────────────────────────
  CreateDirectory "$APPDATA\EDiFi Connect"

  ; ── 4. Pre-bake All Smiles office config ─────────────────────────────────────
  ; v2.3.7 reads config from %APPDATA%\EDiFi Connect\config.json.
  ; v1.0.0 config was at %APPDATA%\EDiFiConnect\config.json (no migration logic).
  ; Without this pre-bake, the app starts as unregistered and shows a manual setup
  ; screen where staff must enter the office code — unnecessary friction.
  ;
  ; Skip if config already exists — preserves any existing v2.3.7 configuration.
  IfFileExists "$APPDATA\EDiFi Connect\config.json" EDiFiInstallSkipConfig EDiFiInstallWriteConfig

  EDiFiInstallWriteConfig:
    FileOpen $0 "$APPDATA\EDiFi Connect\config.json" w
    FileWrite $0 '{"office_id":"90c1b75a-9bf1-4c9c-84fe-ccd7e9ba1ed9","registered":true,"api_key":null,"od_api_url":null,"od_customer_key":null,"machine_id":null}'
    FileClose $0

  EDiFiInstallSkipConfig:

!macroend
