function createSqliteTipJarRepository({ database } = {}) {
  const findRun = database.prepare('SELECT * FROM tip_jar_runs WHERE league_id = @leagueId AND user_id = @userId AND id = @runId');
  const findClientRun = database.prepare('SELECT * FROM tip_jar_runs WHERE league_id = @leagueId AND user_id = @userId AND client_run_id = @clientRunId');
  const insertRun = database.prepare(`INSERT INTO tip_jar_runs
    (id,league_id,user_id,client_run_id,ruleset_version,seed,shots_json,result_json,created_at_ms,updated_at_ms,version)
    VALUES (@id,@leagueId,@userId,@clientRunId,@rulesetVersion,@seed,'[]',@resultJson,@nowMs,@nowMs,1)`);
  const updateRun = database.prepare(`UPDATE tip_jar_runs SET shots_json=@shotsJson,result_json=@resultJson,
    updated_at_ms=@nowMs,version=version+1 WHERE league_id=@leagueId AND user_id=@userId AND id=@runId`);
  const findBest = database.prepare('SELECT * FROM tip_jar_bests WHERE league_id=@leagueId AND user_id=@userId AND ruleset_version=@rulesetVersion');
  const saveBest = database.prepare(`INSERT INTO tip_jar_bests
    (id,league_id,user_id,run_id,ruleset_version,highest_level_completed,shots_to_completion,updated_at_ms)
    VALUES (@id,@leagueId,@userId,@runId,@rulesetVersion,@highestLevel,@shotsToCompletion,@nowMs)
    ON CONFLICT (league_id,user_id,ruleset_version) DO UPDATE SET run_id=excluded.run_id,
      highest_level_completed=excluded.highest_level_completed,shots_to_completion=excluded.shots_to_completion,
      updated_at_ms=excluded.updated_at_ms
    WHERE excluded.highest_level_completed > tip_jar_bests.highest_level_completed OR
      (excluded.highest_level_completed = tip_jar_bests.highest_level_completed AND
       excluded.highest_level_completed > 0 AND excluded.shots_to_completion < tip_jar_bests.shots_to_completion)`);
  const leaderboard = database.prepare(`SELECT b.*,u.display_name AS manager_name FROM tip_jar_bests b
    JOIN users u ON u.id=b.user_id
    WHERE b.league_id=@leagueId AND b.ruleset_version=@rulesetVersion
    ORDER BY b.highest_level_completed DESC,b.shots_to_completion ASC,b.updated_at_ms ASC,b.user_id ASC`);
  return Object.freeze({
    findRun: args => findRun.get(args) || null,
    findClientRun: args => findClientRun.get(args) || null,
    insertRun: args => insertRun.run(args),
    updateRun: args => updateRun.run(args),
    findBest: args => findBest.get(args) || null,
    saveBest: args => saveBest.run(args),
    leaderboard: args => leaderboard.all(args),
  });
}
module.exports = { createSqliteTipJarRepository };
