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

## Service runtime is OUT OF SCOPE (6D-2 review finding 1)

`service/bridge.js` (the legacy headless v1.0.0-style runtime) carries its
OWN copy of `mapOdApiBenefits` that this change deliberately does NOT touch —
it is protected-lane code requiring its own gate. Consequence: a service-mode
office would emit `code_num`/`proc_code` on MySQL-fallback rows (shared
`od-mysql.js`) but not on REST rows. This is accepted and harmless (the
backend treats missing fields as UNMAPPED), but it means the feature only
fully works on the Electron runtime. No service-runtime packaging or update
is allowed until separately approved.

## 6D-3 packaging QA checklist (REQUIRED before any release)

1. Confirm the target office runs the **Electron app runtime** (v2.3.x),
   NOT the legacy `service/bridge.js` runtime. If the office is on the
   service runtime: STOP and open a separate protected implementation gate.
2. Verify the "ProcCode cache warmed: N codes" log on first sync — if N is
   exactly 100, the catalog is probably truncated by API pagination; add the
   Offset pagination loop before relying on proc_code coverage.
3. Standard Connect Protection Rule proof: app relaunches, bridge reconnects,
   AGENT_HELLO received, remote commands work, config preserved.
4. Backend prerequisite: the 6D-1B limitation-dedup fix
   (edifi-eligibility `fix/phase6d-backend-lim-dedup-proccode`) MUST be
   merged and deployed before any 6D-1 agent ships, or CDT-mapped frequency
   rules sharing quantity/period will collapse.

## Known pre-existing issue found by 6D-1B tests (NOT fixed here)

`od-mysql.js` `CATEGORY_MAP` interprets `EbenefitCat` on a shifted scale vs
OD's actual enum (3→BASIC should be DIAGNOSTIC, 4→ENDO should be
Restorative/BASIC, 5→PERIO should be ENDODONTIC, 6→ORAL_SURGERY should be
PERIODONTIC, 7→MAXILLOFACIAL should be ORAL_SURGERY), and emits
non-canonical labels (ENDO/PERIO/ORTHO/IMPLANTS). This only affects the
MySQL FALLBACK path's legacy `category` label — the pilot office uses the
REST path, and the backend's Phase 6B mapper resolves the forwarded raw
`ebenefitcat` value correctly regardless. Fix needs its own small gate
(canonical map + a decision on the intentional Prosth/Crowns→MAJOR rule).

## Rollout boundaries

- 6D-1 (this): local code + tests only
- 6D-1B: review fixes (backend dedup identity, wording, cache lifetime, tests)
- 6D-2/2B: independent review of implementation and fix deltas
- 6D-3: controlled packaging (version bump + NSIS + QA proof checklist above)
- 6D-4: controlled remote update — separate explicit approval, full
  relaunch/reconnect/AGENT_HELLO/remote-command/config-preserved proof

## Rollback

Pre-ship: don't package. Post-ship (future): roll back the agent version, or
simply accept that the backend treats missing fields as UNMAPPED — the
backend needs no change in either direction.
