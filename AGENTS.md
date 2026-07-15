# Hundo Leago Backend Instructions

## Scope

These instructions apply to the entire `hundo-leago-backend` repository.

## Canonical Project Documentation

The canonical Hundo Leago project documentation lives in the sibling frontend repository:

`../hundo-leago/docs/`

Before planning or implementing backend work, read the applicable documentation in this order:

1. `../hundo-leago/docs/README.md`
2. `../hundo-leago/docs/01-project/NORTH_STAR.md`
3. `../hundo-leago/docs/01-project/OPERATING_MODE.md`
4. `../hundo-leago/docs/01-project/CURRENT_STATE.md`
5. `../hundo-leago/docs/01-project/PROJECT_SCOPE.md`
6. `../hundo-leago/docs/01-project/GLOSSARY.md`

Use those documents as the source of truth for product intent, current operating conditions, project scope, terminology, and known system state.

The current operating mode is defined by `OPERATING_MODE.md`. At the time this file was created, the mode was `OFFSEASON_RESET`. Always check the canonical file rather than assuming the mode has remained unchanged.

## Repository Role

This repository contains the Hundo Leago backend.

Current core technologies include:

* Node.js
* Express
* File-backed JSON state
* Backend services, routes, validation, jobs, and persistence logic

The sibling `../hundo-leago` repository contains the React and Vite frontend plus the canonical shared documentation.

Do not edit the sibling frontend repository unless the user explicitly includes frontend changes in the task.

## Branch and Production Safety

* Production uses the `main` branch.
* Current backend development work uses the `stage2` branch.
* Never make production changes merely because development changes appear safe locally.
* Never reseed, replace, or overwrite live league data.
* Never run a destructive reset, migration, cleanup, or test against production data.
* Never discard, overwrite, stash, stage, or commit unrelated local work.
* Inspect `git status` before and after every change.
* Do not use destructive Git commands unless the user explicitly requests one and the exact consequences have been explained.

## Required Working Method

Work one small, reviewable step at a time.

For every step:

1. State the exact file path being changed.
2. Explain the exact intended change.
3. Make only the change required for the current step.
4. Preserve unrelated code and local modifications.
5. Provide a focused verification command, test, or `curl` request.
6. Report what was actually verified.
7. Stop before beginning the next step.

Do not perform broad rewrites, mass formatting, opportunistic cleanup, or unrelated refactoring.

Preserve existing behavior unless the task explicitly requires a behavior change.

## Backend Safety Rules

* Read-only endpoints must remain read-only.
* A `GET` request must not silently mutate league state.
* Do not add hidden writes, resets, refreshes, migrations, or other side effects.
* State-changing endpoints must validate their input before changing stored data.
* Use existing storage, service, validation, and backup patterns rather than bypassing them.
* Preserve existing league state fields unless an approved migration explicitly changes them.
* Any change involving persisted JSON must account for existing live data.
* Do not assume an empty league, a newly seeded league, or a disposable state file.
* Do not silently change an API response contract used by the frontend.
* Coordinate backend and frontend contract changes explicitly when both repositories are involved.

## Verification Standards

Use the narrowest useful verification for the change.

Examples include:

* A targeted automated test
* A local server startup check
* A focused `curl` request
* JSON response inspection
* A syntax or import check
* A comparison confirming persisted state was not modified

Do not claim that something works unless the relevant verification was actually run.

When a verification cannot be completed, clearly state what remains unverified and why.

## Completion Report

At the end of each completed step, report:

* Files changed
* Behavior changed, or confirmation that behavior did not change
* Verification commands run
* Verification result
* Any remaining risk or follow-up work

Do not commit or push changes unless the user explicitly requests it.
