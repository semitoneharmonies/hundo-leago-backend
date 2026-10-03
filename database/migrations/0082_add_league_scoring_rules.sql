-- Rules are opt-in, season-scoped and immutable. No existing scores are rewritten.
CREATE TABLE league_scoring_rules (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 league_id TEXT NOT NULL REFERENCES leagues(id),
 season_id TEXT NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES users(id),
 actor_authority TEXT NOT NULL CHECK(actor_authority IN ('commissioner','platform_administrator','platform_administrator_as_commissioner')),
 revision INTEGER NOT NULL CHECK(revision>=1),
 effective_week_sequence INTEGER NOT NULL CHECK(effective_week_sequence>=1),
 weights_json TEXT NOT NULL CHECK(json_valid(weights_json)),
 client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 8 AND 128),
 request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
 reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
 before_json TEXT NOT NULL CHECK(json_valid(before_json)),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
 FOREIGN KEY(league_id,season_id) REFERENCES seasons(league_id,id),
 UNIQUE(league_id,season_id,revision),
 UNIQUE(league_id,actor_user_id,client_key)
) STRICT;
CREATE INDEX league_scoring_rules_effective ON league_scoring_rules(league_id,season_id,effective_week_sequence DESC,revision DESC);
CREATE TRIGGER league_scoring_rules_immutable_update BEFORE UPDATE ON league_scoring_rules
BEGIN SELECT RAISE(ABORT,'Scoring rules are immutable'); END;
CREATE TRIGGER league_scoring_rules_immutable_delete BEFORE DELETE ON league_scoring_rules
BEGIN SELECT RAISE(ABORT,'Scoring rules are immutable'); END;
CREATE TRIGGER league_scoring_rules_preserve_results BEFORE INSERT ON league_scoring_rules
WHEN EXISTS(SELECT 1 FROM matchup_weeks w WHERE w.league_id=NEW.league_id AND w.season_id=NEW.season_id
 AND w.sequence>=NEW.effective_week_sequence AND (w.ends_at_ms<=NEW.created_at_ms OR w.status IN ('final','cancelled')
 OR EXISTS(SELECT 1 FROM matchups m WHERE m.league_id=w.league_id AND m.matchup_week_id=w.id AND m.status='final')))
BEGIN SELECT RAISE(ABORT,'Completed matchup scoring requires explicit result correction'); END;
UPDATE application_metadata SET metadata_value='82',updated_at_ms=max(updated_at_ms,82)
WHERE metadata_key='data_model_version' AND metadata_value='81';
