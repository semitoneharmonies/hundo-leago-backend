# Tip Jar staging integration

This narrow feature is based on the actual deployed staging release `17f51da1a1d097e4a5f40601cb80a5b81faafd46`. Staging has its own historical migration lineage. All existing migration files and ledger checksums remain unchanged; additive migration0087 creates only `tip_jar_runs`, `tip_jar_bests`, their indexes, and schema metadata87. The production schema94 candidate is separate and must not be applied to staging.

Existing cookie, origin and CSRF security protects the API. League membership is required to read a leaderboard, and a current accepted manager assignment is required to save a run. The server derives manager identity from the session. It accepts a UUIDv4 client-run key and then bounded shot transcripts; the exact packaged `campaign-v1` physics replays every checkpoint. Scores and identities are not trusted from browser payloads.

- GET `/api/v1/leagues/:leagueId/tip-jar/leaderboard`: manager personal bests ranked by highest completed level descending, then cumulative shots through that completion ascending.
- POST `/api/v1/leagues/:leagueId/tip-jar/runs`, body `{clientRunId}`: idempotent seed/run creation.
- POST `/api/v1/leagues/:leagueId/tip-jar/runs/:runId/checkpoint`, body `{shots:[{time,x,height,power}]}`: immutable-prefix replay, safe duplicate/stale retries, and monotonically improving bests.

Existing response envelopes remain `{data,meta:{requestId}}`. Dates are ISO timestamps. Failed later-level shots are excluded from the completion-shot score; a player who completes no level has null `shotsToCompletion`. Equal performances share a rank. A run has at most60 shots.

Run/checkpoint writes affect only the two side-game tables. They do not publish fantasy activity, notifications, league invalidations or rewards. Historical reset policies require new game tables to be empty. The existing explicitly authorized league deletion flow removes only the chosen league's game rows and preserves other leagues. No cascading delete is introduced.

Local Node24.14.1 focused API verification passed11/11 using synthetic in-memory databases and loopback HTTP. It covers replay, session/membership/current-manager authorization, league isolation, concurrent and stale checkpoints, ranking, cumulative scoring, and preservation of every pre-existing table. Full staging gate evidence is managed by the parent release process. Physics validation prevents fabricated counters; it is not bot prevention.

Deployment requires the reviewed staging backup, isolated restore/migration rehearsal, guarded explicit migration, compatible rollback source and before/after preservation verification. No automatic migration is added. Schema86 code is not a valid rollback after schema87; use the reviewed schema87 compatibility rollback without deleting rows or restoring older live data.
