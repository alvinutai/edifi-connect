# Phase 6D-1 — CodeNum / ProcCode Forwarding (local implementation, NOT shipped)

> Gate `G-PHASE6D1-codenum-proccode-forwarding-local`. This change exists on a
> local branch only. It does NOT ship to any office until the separate
> packaging (6D-3) and controlled-update (6D-4) gates are approved. The full
> EDiFi Connect Critical Connection Protection Rule applies to those gates.

## What is forwarded (additive fields on every benefit/limitation entry)

- `code_num` — OD `benefit.CodeNum` (procedure FK; 0/absent → null)
- `proc_code` — resolved CDT code string (e.g. `D1110`), null when unresolvable
- MySQL-path parity: `benefit_num`, `cov_cat_num`, `ebenefitcat` now also
  included (the REST path always had them)

Both fields are pure additions: every pre-existing payload field is unchanged,
old backends ignore the new keys, and the Phase 6B backend mapper consumes
them with zero backend changes (its CDT range rung activates automatically).

## How proc_code is resolved

- REST path: `getOdProcCodes()` warms a module-level `CodeNum → ProcCode`
  cache from the same `/procedurecodes` endpoint the fee-schedule sync already
  uses — no new Open Dental call class. Fetch failure caches nothing (next
  sync retries) and benefit mapping proceeds with `proc_code = null`.
  A cold or failed cache NEVER drops a row and NEVER blocks OD_DATA_PUSH —
  `code_num` is still forwarded alone.
- MySQL path: `LEFT JOIN procedurecode pc ON pc.CodeNum = b.CodeNum` — zero
  extra queries, null-safe by construction.

## Why proc_desc is excluded

Procedure descriptions add no mapper value (the CDT code is the semantic key)
and OD descriptions can carry office free text. Excluded deliberately.

## Why this matters

Production Phase 6C-1 counts at the pilot office: 196 coverage rows + 276
frequency rows sit at UNMAPPED solely because the agent never forwarded the
procedure linkage. The replay fixture `allsmiles-codenum.json` proves the
conversion shape: 7 of 8 previously-blocked synthetic rows become resolvable;
true blanks (no covcat, no eben, no code) stay honestly unmapped.

## Rollout boundaries

- 6D-1 (this): local code + tests only
- 6D-2: independent review
- 6D-3: controlled packaging (version bump + NSIS + QA proof checklist)
- 6D-4: controlled remote update — separate explicit approval, full
  relaunch/reconnect/AGENT_HELLO/remote-command/config-preserved proof

## Rollback

Pre-ship: don't package. Post-ship (future): roll back the agent version, or
simply accept that the backend treats missing fields as UNMAPPED — the
backend needs no change in either direction.
