# Database Source

This directory contains committed SQLite migration source and migration-only support files.

## Layout

```text
database/
|-- migrations/
|   `-- 0001_initial.sql
|-- reset-manifests/
|-- fixtures/
`-- README.md
```

`migrations/0001_initial.sql` is the approved M2-04 relational
foundation. It creates the account, league, roster, contract, auction,
trade, draft, statistics, matchup, standings, history, security, and
reliability tables described by the canonical data model.

The initial schema uses `STRICT` tables, composite same-league foreign
keys, partial uniqueness constraints, league-first indexes, and focused
triggers for circular pointers and matchup/bye conflicts. It creates
structure only: it does not import JSON, seed league records, switch the
application repository, or run during server startup.

## Migration Rules

Migration files:

* use four-digit increasing IDs and lowercase underscore names;
* are read and checksummed as exact bytes;
* are immutable after use outside disposable local development;
* make no network calls;
* do not contain environment-specific data;
* run only through the explicit migration command;
* never run during HTTP requests, reads, or incidental server startup.

Generated databases, copied source data, reports with private data, WAL files, shared-memory files, and backup artifacts are not committed.

## Reset Manifests

`reset-manifests/2026-season-1-reset.json` is the approved
version-1 Season 1 reset boundary. It is canonical, checksummed, and
fail-closed:

* only its 12 exact Season 1 families may be omitted by a later import;
* every omitted record must first be explicitly classified as Season 1
  by that later import transform;
* all 76 application tables are classified exactly once as either an
  allowed omission target or a protected table;
* player identities, Season 2 account and access data, draft rights,
  global statistics, and migration/recovery evidence are protected;
* all unlisted source data is preserved or stops the import;
* hard-coded frontend identity and plaintext credential material is
  never imported.

Validate the manifest explicitly:

```powershell
npm run db:validate-reset -- `
  --manifest database/reset-manifests/2026-season-1-reset.json `
  --operating-mode OFFSEASON_RESET `
  --source-bundle-version 1
```

This command reads only the named manifest and validates its canonical
serialization, checksum, exact policy, operating mode, and source-bundle
version. It does not read league source data, open SQLite, classify a
record, apply an omission, or execute a reset.

## JSON Import Dry Run

M2-09 adds a dry-run-only importer:

```powershell
npm run db:import-json -- `
  --source-bundle <verified-external-bundle> `
  --database <new-temporary-database.sqlite3> `
  --reset-manifest database/reset-manifests/2026-season-1-reset.json `
  --report <new-temporary-report-directory> `
  --environment test `
  --operating-mode OFFSEASON_RESET `
  --dry-run
```

The bundle, database, and report must use separate new paths below the
operating-system temporary root. The importer:

* verifies the exact source bundle and reset manifest;
* accepts only the supported copied `league_state` and `players` shapes;
* treats legacy files, backups, and snapshots as preserved recovery
  evidence rather than additional authority;
* deterministically maps stable NHL player IDs into protected player
  rows;
* accounts for every approved Season 1 omission family;
* excludes hard-coded frontend login material;
* migrates a new temporary database;
* validates prepared inserts, integrity, foreign keys, stable IDs,
  money, ownership, and row counts inside `BEGIN IMMEDIATE`;
* always rolls imported rows back;
* leaves only the migration ledger in the successful dry-run database;
* atomically writes canonical `import-report.json` and deterministic
  `import-report.md`.

This step does not persist imported rows, switch application authority,
access production, or perform a reset.

## Test/Local Backup and Restore Verification

`db:backup` uses the SQLite online backup API to create a standalone
database plus a canonical checksummed manifest at a new OS-temporary
directory. `db:restore-verify` copies a verified backup to a new clean
temporary path and rechecks its SHA-256, schema/migration ledger, row
counts, integrity, and foreign keys. Both commands require
`--environment test`; restore verification never activates or replaces a
live database.

## Isolated Staging Descriptor

`staging-environment.example.json` is a non-secret, version-1 description
of the staging resources and persistent paths required by the migration
rehearsal:

```powershell
npm run db:validate-staging -- `
  --descriptor database/staging-environment.example.json
```

Validation requires distinct staging service, disk, database, source,
report, and backup identifiers. Every mutable path must be an absolute,
distinct child of one staging persistent root. The descriptor contains
secret names only, never secret values, and rejects production references
or access assertions.

The descriptor deliberately keeps JSON as application authority and
disables SQLite application authority. It proves only the checked
configuration document; it does not provision a Render service or disk,
inspect deployed secrets, verify a mounted filesystem, deploy code, or
change application traffic.

## Persistent Staging Import

`db:import-staging` is the only import command in this milestone that
retains copied-data rows. It requires a validated staging descriptor and
new database and report paths below that descriptor's physical persistent
root:

```powershell
npm run db:import-staging -- `
  --descriptor <staging-descriptor.json> `
  --source-bundle <verified-bundle-below-staging-source-root> `
  --database <exact-new-descriptor-database-path> `
  --reset-manifest database/reset-manifests/2026-season-1-reset.json `
  --report <new-report-below-staging-report-root> `
  --operating-mode OFFSEASON_RESET
```

The persistent root must be physically outside the repository. The
command verifies the copied bundle and reset policy, migrates a new
database, inserts all prepared rows in one immediate transaction,
validates committed counts, stable IDs, integrity, foreign keys, money,
ownership, and semantic hashes, checkpoints the WAL, and then publishes
the canonical report. A failure removes only database files created by
that invocation.

The resulting database remains an isolated migration artifact. The
descriptor still requires JSON application authority and explicitly
forbids enabling SQLite application traffic or production access.

## Independent Staging Import Verification

`db:verify-staging-import` reopens an existing staging import read-only
and recomputes its evidence from the copied bundle, reset manifest,
canonical import report, migration ledger, and SQLite rows:

```powershell
npm run db:verify-staging-import -- `
  --descriptor <staging-descriptor.json> `
  --source-bundle <verified-staging-source-bundle> `
  --database <exact-descriptor-database-path> `
  --reset-manifest database/reset-manifests/2026-season-1-reset.json `
  --import-report <import-report.json-below-staging-report-root> `
  --operating-mode OFFSEASON_RESET
```

The verifier checks every application table count, target semantic hash,
provider identifier, reset omission, protected and never-import family,
mapping, money aggregate, ownership aggregate, schema migration, report
checksum, database checksum, integrity result, and foreign key result.
It hashes its inputs before and after verification and fails if one
changes. To prevent a nominally read-only WAL open from creating sidecar
files beside the staging database, it opens an exact OS-temporary copy
and removes that copy afterward. It never writes the staging database,
report, source bundle, descriptor, or application setting.

## Staging Cutover and Rollback Rehearsal

`db:rehearse-staging-cutover` requires an independently verified import,
an explicit timestamp, and new backup and rehearsal paths within the
descriptor's staging roots. It creates an online pre-cutover backup,
restores that exact backup to separate activation and rollback candidate
files, verifies both candidates against the source counts, migrations,
metadata, and target semantic hashes, and publishes canonical evidence:

```powershell
npm run db:rehearse-staging-cutover -- `
  --descriptor <staging-descriptor.json> `
  --source-bundle <verified-staging-source-bundle> `
  --database <exact-descriptor-database-path> `
  --reset-manifest database/reset-manifests/2026-season-1-reset.json `
  --import-report <verified-import-report.json> `
  --backup <new-path-below-staging-backup-root> `
  --rehearsal <new-path-below-staging-report-root> `
  --operating-mode OFFSEASON_RESET `
  --rehearsed-at-ms <explicit-integer>
```

The activation candidate is a rehearsal artifact, not an application
configuration. The command records that JSON authority remains unchanged,
SQLite application authority remains disabled, and production authority
is untouched. It does not deploy, switch traffic, edit environment
variables, replace the source database, or access production.
