; EDiFi Connect — Custom NSIS Install Script
; Handles safe upgrade from v1.0.0 (legacy Node.js service) to v2.3.7 (Electron).
;
; v1.0.0 lives at:  %APPDATA%\EDiFiConnect\            (no space, no uninstaller)
; v2.3.7 installs:  %LOCALAPPDATA%\Programs\EDiFi Connect\
; v2.3.7 config:    %APPDATA%\EDiFi Connect\config.json (Electron userData)
;
; This macro runs after files are extracted but before the app starts.

!macro customInstall

  ; ── 1. Stop legacy v1.0.0 node.exe ───────────────────────────────────────────
  ; v1.0.0 runs as node.exe binding port 47821. If still running, v2.3.7 cannot
  ; bind the same port and will fail to start its local HTTP server.
  ; Note: kills all node.exe processes on the machine. Acceptable for dental office
  ; workstations which rarely run other Node.js services.
  nsExec::Exec 'taskkill /F /IM node.exe /T'
  ; Allow OS to release port 47821 before v2.3.7 starts
  Sleep 2000

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
