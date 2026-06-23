# EDiFi Office Version Ledger — Connect

Per-office deployment state: installed version, verified capabilities, last seen, notes.

## Legend

- `bridge_connected`: last known WebSocket bridge state
- `od_api_url_present`: agent reports an OD eConnector REST URL
- `od_mysql_available`: agent reports working OD MySQL connection
- `capabilities`: list of remote commands the agent supports
- `last_seen`: ISO timestamp of last AGENT_HELLO or status poll

---

| office_id | office_name | observed_version | source | bridge_connected | od_api_url_present | od_mysql_available | capabilities | last_seen | note |
|---|---|---|---|---|---|---|---|---|---|
| `90c1b75a-9bf1-4c9c-84fe-ccd7e9ba1ed9` | All Smiles | 2.3.68 | `OFFICE_PROFILE_ALL_SMILES.md` (2026-06-22) | true (2026-06-18) | true | false (per `PROJECT_STATE_LOCK`) | REPORT_STATUS, CHECK_FOR_UPDATE, DOWNLOAD_UPDATE, QUIT_AND_INSTALL | 2026-06-22 | Missing CodeGroup Forwarding and Updater Gating. **Do not run CHECK_FOR_UPDATE.** |
| `a56917d4-0c1f-4e06-b2c6-60a92ec1d08c` | Alvin sandbox | 2.3.14 | `RELEASE_STATE_LOCK.md` (2026-05-27) | true | true | false | 15 commands | 2026-05-27 | Validation office; status likely stale — re-verify before use. |

---

## Update triggers

- After every agent `AGENT_HELLO` or `AGENT_STATUS`.
- After every `REPORT_STATUS` / `REPORT_CONFIG_STATUS` command result.
- After every successful install/upgrade/rollback.
