function createSqliteTipJarPublicRepository({ database } = {}) {
  const findRun = database.prepare('SELECT * FROM tip_jar_guest_runs WHERE guest_hash=@guestHash AND id=@runId');
  const findClientRun = database.prepare('SELECT * FROM tip_jar_guest_runs WHERE guest_hash=@guestHash AND client_run_id=@clientRunId');
  const findBest = database.prepare('SELECT * FROM tip_jar_guest_bests WHERE guest_hash=@guestHash AND ruleset_version=@rulesetVersion');
  const insertRun = database.prepare(`INSERT INTO tip_jar_guest_runs
    (id,guest_hash,client_run_id,ruleset_version,seed,shots_json,result_json,created_at_ms,updated_at_ms,version)
    VALUES (@id,@guestHash,@clientRunId,@rulesetVersion,@seed,'[]',@resultJson,@nowMs,@nowMs,1)`);
  const updateRun = database.prepare(`UPDATE tip_jar_guest_runs SET shots_json=@shotsJson,result_json=@resultJson,
    updated_at_ms=@nowMs,version=version+1 WHERE guest_hash=@guestHash AND id=@runId`);
  const saveBest = database.prepare(`INSERT INTO tip_jar_guest_bests
    (id,guest_hash,run_id,ruleset_version,display_name,highest_level_completed,shots_to_completion,updated_at_ms)
    VALUES (@id,@guestHash,@runId,@rulesetVersion,NULL,@highestLevel,@shotsToCompletion,@nowMs)
    ON CONFLICT (guest_hash) DO UPDATE SET run_id=excluded.run_id,
      highest_level_completed=excluded.highest_level_completed,shots_to_completion=excluded.shots_to_completion,
      updated_at_ms=excluded.updated_at_ms
    WHERE excluded.highest_level_completed > tip_jar_guest_bests.highest_level_completed OR
      (excluded.highest_level_completed = tip_jar_guest_bests.highest_level_completed AND
       excluded.highest_level_completed > 0 AND excluded.shots_to_completion < tip_jar_guest_bests.shots_to_completion)`);
  const nameBest = database.prepare('UPDATE tip_jar_guest_bests SET display_name=@name WHERE guest_hash=@guestHash AND display_name IS NULL');
  // Only one result per account appears publicly, even when the same manager plays in several leagues.
  const ranked = `WITH account_runs AS (
    SELECT b.*,u.display_name AS player_name,
      ROW_NUMBER() OVER (PARTITION BY b.user_id ORDER BY b.highest_level_completed DESC,b.shots_to_completion ASC,b.updated_at_ms ASC,b.id ASC) AS account_row
    FROM tip_jar_bests b JOIN users u ON u.id=b.user_id
    WHERE b.ruleset_version=@rulesetVersion AND b.highest_level_completed>0
  ), players AS (
    SELECT user_id AS player_id,player_name,0 AS is_guest,highest_level_completed,shots_to_completion,updated_at_ms FROM account_runs WHERE account_row=1
    UNION ALL
    SELECT id AS player_id,display_name AS player_name,1 AS is_guest,highest_level_completed,shots_to_completion,updated_at_ms
    FROM tip_jar_guest_bests WHERE ruleset_version=@rulesetVersion AND highest_level_completed>0 AND display_name IS NOT NULL
  ), ranked AS (
    SELECT *,RANK() OVER (ORDER BY highest_level_completed DESC,shots_to_completion ASC) AS rank FROM players
  )`;
  const leaderboard = database.prepare(`${ranked} SELECT * FROM ranked WHERE rank<=100 ORDER BY rank,updated_at_ms,player_id`);
  const betterCount = database.prepare(`${ranked} SELECT COUNT(*) AS count FROM players
    WHERE NOT (is_guest=1 AND player_id=@playerId) AND
      (highest_level_completed>@highestLevel OR (highest_level_completed=@highestLevel AND shots_to_completion<@shotsToCompletion))`);
  return Object.freeze({
    findRun: args => findRun.get(args) || null,
    findClientRun: args => findClientRun.get(args) || null,
    findBest: args => findBest.get(args) || null,
    insertRun: args => insertRun.run(args),
    updateRun: args => updateRun.run(args),
    saveBest: args => saveBest.run(args),
    nameBest: args => nameBest.run(args),
    leaderboard: args => leaderboard.all(args),
    betterCount: args => betterCount.get(args).count,
  });
}
module.exports = { createSqliteTipJarPublicRepository };
