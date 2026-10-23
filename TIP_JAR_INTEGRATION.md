# Tip Jar API candidate

Prepared against accepted production release `662f85cf5b91ac83236d50997bd8b91de0dd3cad` in this isolated E: Git candidate. Read-only Render discovery on October 23 confirmed that exact commit remained live. This document describes the candidate; deployment acceptance is recorded separately.

## API

All responses use the existing `{ data, meta: { requestId } }` envelope and existing cookie/origin/CSRF boundary. League membership is required for reads. Saving additionally requires a current accepted team-manager assignment in that league, including commissioners who also manage a team.

- `GET /api/v1/leagues/:leagueId/tip-jar/leaderboard` returns rulesetVersion, entries and personalBest. Entries contain rank, managerId, managerName, highestLevelCompleted, shotsToCompletion, completed and updatedAt.
- `POST /api/v1/leagues/:leagueId/tip-jar/runs`, body `{ clientRunId }` (canonical UUIDv4), issues a server runId and unsigned 32-bit seed. Repeating the same clientRunId for the same league/user returns the same run and seed.
- `POST /api/v1/leagues/:leagueId/tip-jar/runs/:runId/checkpoint`, body `{ shots: [{ time, x, height, power }] }`, replays at most 60 shots with the shared `campaign-v1` physics. Results contain runId, highestLevelCompleted, shotsToCompletion, shotsUsed, level, pucks, completed, failed and levelResults. A checkpoint must extend the immutable shot prefix. Exact/stale prefix retries return the current result without writes; conflicting prefixes fail with409.

createdAt and updatedAt are ISO timestamps. No endpoint accepts user identity, scores, ranks, completion flags or manager display names from the browser. A played run with no completed level has highestLevelCompleted0 and shotsToCompletion null.

Personal bests rank by highest completed level descending, then cumulative shots through that completion ascending. Shots fired in a later unfinished level are excluded. Equal performances share a rank. A new or worse run never overwrites a better score. Level completion checkpoints preserve the result even if the player leaves before the next level finishes.

The verifier shares unchanged pure game modules under `src/features/tipJar/rules/`, with ESM package metadata and a source hash manifest. The exact seeded controller fixture is in `test/fixtures/tip-jar-campaign.json`. Physics validation rejects fabricated counters and illegal transcripts; it is not bot prevention or proof of human play.

## Storage boundary

Migration0094 adds only `tip_jar_runs`, `tip_jar_bests` and indexes, and advances application schema metadata. It does not alter fantasy records. Both tables use explicit non-cascading foreign keys and required-league catalogue scope. The existing authorized league deletion transaction removes their own league rows explicitly; the reviewed schema fingerprint and preservation test cover this addition. Historical reset policies require these post-reset tables to be empty and do not gain permission to discard scores.

Run starts/checkpoints write only these two side-game tables. They do not publish league invalidations or create activity, notifications, roster changes, standings or rewards. Existing authentication may maintain normal account session state as usual.

## Local verification

Run with TEMP/TMP pointing to an E: task directory:

```
node --test test/foundation/tipJarFoundation.test.js
node --test test/foundation/tipJarResetFoundation.test.js
node --test --test-name-pattern="constructs every repository" test/foundation/targetRuntimeFoundation.test.js
node --test --test-name-pattern="preview is read-only" test/foundation/leagueDeletionFoundation.test.js
node --test --test-name-pattern="applies exactly" test/foundation/sqliteInitialSchema.test.js
node --test --test-name-pattern="validates the signed policy" test/foundation/resetManifest.test.js
```

The side-game tests use only in-memory SQLite, synthetic identities and loopback HTTP. They fingerprint all pre-existing tables before and after score writes, exercise real seeded replay, retry/race handling, revoked manager authority, foreign-league/account IDs, leaderboard sorting, final-puck completion, CSRF/origin checks and malformed input.

The October 23 core verification passed all 13 Tip Jar and guided-reset tests on Node 24.14.1. Guided resets explicitly accept schema94 while retaining archive format88 and the existing Goon draft scheduling guard. Reset and restore preserve both leagues' Tip Jar rows and scores earned after an archived fantasy reset. Unknown schemas and disabled foreign keys still fail closed.

The candidate retains every tracked accepted fixture file, including the three legacy JSON fixtures. No unrelated index or fantasy-schema repair is included. A full repository test-suite pass is not claimed by the focused checks; use the separate release evidence for exact commands and results.

The schema94-compatible rollback starts from the same accepted commit, retains all existing fantasy behavior, keeps both Tip Jar tables/rows, and exposes no Tip Jar endpoints. Its five focused source/composition/HTTP/reset-preservation checks passed. Migration/publication requires the separately approved encrypted backup, isolated restore rehearsal, maintenance hold, compatible rollback and query-only preservation process. This feature does not grant permission to overwrite league records during recovery.
