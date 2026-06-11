# Public Repository Status — Temporary Updater Infrastructure Exception

## Why this repo is public

The live EDiFi Connect auto update path depends on this repository being public.
electron-updater in installed offices is configured with `provider: github` pointing
at this repo, and offices pull update artifacts from its public GitHub Releases.
Making the repo private would break the auto update path for every installed office.

This is a temporary infrastructure exception, accepted explicitly under gate
`G-PHASE6D` public repo decision (2026-06-11). It is not the desired end state.

## Standing rules while this repo is public

1. No PHI may ever be committed. No patient names, IDs, member IDs, subscriber IDs,
   appointment data, or any payload derived from a real patient record.
2. No secrets may ever be committed. No credentials, tokens, customer keys,
   webhook URLs, or connection strings.
3. No client, office, carrier, or staff names in fixtures, tests, or docs.
   Use neutral synthetic names only (for example `Pilot Office`, `Carrier A`,
   `Office A`). All fixture data must be synthetic.
4. Run the secret scan and PHI pattern scan on every change set before push.

## Path to privatization (separate future gate, not approved here)

1. Migrate the electron-updater release feed off public GitHub Releases to a
   generic host (electron-updater `generic` provider or equivalent).
2. Verify the updater path on every installed office against the new feed.
3. Only then privatize the repository.
4. Optional git history rewrite (to remove names already present in pushed
   history) is a separate decision, only after updater migration and explicit
   approval. History rewrite was NOT approved in the scrub gate.
