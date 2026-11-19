# NHL live normalization fixtures

Public NHL responses captured on 18 November 2026, Vancouver time, from:

`https://api-web.nhle.com/v1/gamecenter/{gameId}/{resource}`

Each game has `play-by-play`, `boxscore`, and `landing` responses. Responses were fetched sequentially and retained verbatim as parsed JSON; a live capture is not a promise that every provider endpoint updates simultaneously.

| Game | Capture state | Purpose |
| --- | --- | --- |
| `2026020344` | `LIVE`, second period | Real in-progress goals, ordered assists, physical statistics, and complete skater coverage. |
| `2025020477` | `OFF` | Penalty-shot goal normalization, a goalie's penalty served by a skater, and exact comparison with the independent official reports already in `../nhlExpandedScoringGames.json`. |
| `2026020134` | `OFF` | Awarded empty-net goal with zero shots on goal; correct final game-winning goal. |

The focused test compares all 13 categories for all 36 skaters in `2025020477` against the existing completed-game fixture. Other cases use explicit synthetic modifications of the captured game structures to test corrections, inconsistent sources, shootouts, double minors, misconducts, and missing data.

These are test inputs only. They contain no league records, credentials, or authoritative production scores.
