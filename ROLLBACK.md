# Tip Jar schema94-compatible backend rollback

This candidate preserves accepted production behavior from `662f85cf5b91ac83236d50997bd8b91de0dd3cad` while remaining compatible with the additive Tip Jar schema94 database. It retains both game tables and their rows, including scores saved after deployment. It exposes the original 212 endpoints and no Tip Jar service or routes.

Five application/storage files carry the migration, catalogue, deletion-policy, reset-import policy, and explicit guided-reset schema94 compatibility. Two release-QA helpers recognize schema94. Existing exact-schema tests are updated, and standalone populated preservation tests are included. The guided reset keeps archive format88 and the existing Goon scheduling restriction. Runtime startup, authentication, scoring, scheduled jobs, and every other fantasy implementation retain the accepted source.

`rollback-source-manifest.json` records all 1,266 reviewed source/fixture files and the exact accepted/current hashes. The archive was extracted with `core.autocrlf=false`; hashes compare actual Git blob bytes. Dependencies and live data are excluded from the package.

Verification on Node24.14.1:

```text
node --test --test-concurrency=2 test/foundation/tipJarRollbackFoundation.test.js test/foundation/tipJarResetFoundation.test.js
5 tests passed; 0 failed.
```

Checks use synthetic in-memory SQLite and loopback HTTP. They prove unchanged serialized bytes and table fingerprints during schema94 runtime composition, both game tables populated in two leagues, no game endpoints, preserved fantasy authentication, and guided reset/restore preservation including later game scores. Evidence is in `evidence/schema94-preservation.json` and the release's `rollback-tests-verified.txt`.

The initial packaging attempt detected CRLF conversion in an archive; no live operation occurred. The accepted archive was regenerated with explicit LF behavior, the source manifest rebuilt, and all five checks rerun successfully. The earlier failed preparation log is retained separately.

A full repository test-suite pass and hosted rollback are not claimed. Actual rollback requires a fresh approved backup and isolated restore proof, a maintenance window, source/build verification, and query-only pre/post preservation checks. Deploy this compatible candidate without downgrading SQLite or restoring an old database over newer manager work. The original schema93 binary refuses a schema94 database and must not be deployed alone.
