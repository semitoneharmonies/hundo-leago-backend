-- Additive audit; existing auction clocks and bids remain unchanged on migration.
CREATE TABLE auction_timing_changes (
  id TEXT PRIMARY KEY CHECK(length(id)=36 AND id=lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  auction_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_authority TEXT NOT NULL CHECK(actor_authority IN ('commissioner','platform_administrator')),
  client_key TEXT NOT NULL CHECK(length(client_key) BETWEEN 8 AND 128),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 3 AND 500),
  previous_closes_at_ms INTEGER NOT NULL CHECK(previous_closes_at_ms>created_at_ms),
  closes_at_ms INTEGER NOT NULL CHECK(closes_at_ms>created_at_ms AND closes_at_ms<>previous_closes_at_ms),
  previous_auction_version INTEGER NOT NULL CHECK(previous_auction_version>=1),
  auction_version INTEGER NOT NULL CHECK(auction_version=previous_auction_version+1),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>=0),
  UNIQUE(league_id,actor_user_id,client_key),
  FOREIGN KEY(league_id,season_id) REFERENCES seasons(league_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(league_id,auction_id) REFERENCES auctions(league_id,id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX auction_timing_changes_history ON auction_timing_changes(league_id,auction_id,created_at_ms,id);
CREATE TRIGGER auction_timing_changes_valid_insert BEFORE INSERT ON auction_timing_changes
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM auctions a JOIN auction_contexts c ON c.league_id=a.league_id AND c.auction_id=a.id
    JOIN leagues l ON l.id=a.league_id JOIN seasons s ON s.league_id=a.league_id AND s.id=a.season_id
    WHERE a.league_id=NEW.league_id AND a.season_id=NEW.season_id AND a.id=NEW.auction_id
      AND a.status='open' AND a.version=NEW.previous_auction_version AND a.resolves_at_ms=NEW.previous_closes_at_ms
      AND c.source_kind='ordinary_weekly' AND l.status='active' AND l.current_season_id=a.season_id AND s.status='active'
      AND NEW.closes_at_ms>a.opened_at_ms
      AND (s.fantasy_playoffs_start_at_ms IS NULL OR NEW.closes_at_ms<s.fantasy_playoffs_start_at_ms)
      AND (s.regular_season_ends_at_ms IS NULL OR NEW.closes_at_ms<s.regular_season_ends_at_ms)
      AND NOT EXISTS(SELECT 1 FROM job_runs j WHERE j.league_id=a.league_id AND j.occurrence_key LIKE 'auction:'||a.id||':%')
      AND NOT EXISTS(SELECT 1 FROM auction_resolutions r WHERE r.league_id=a.league_id AND r.auction_id=a.id)
  ) THEN RAISE(ABORT,'Auction timing change requires an unexpired ordinary auction') END;
END;
CREATE TRIGGER auction_timing_changes_immutable_update BEFORE UPDATE ON auction_timing_changes
BEGIN SELECT RAISE(ABORT,'Auction timing history is immutable'); END;
CREATE TRIGGER auction_timing_changes_immutable_delete BEFORE DELETE ON auction_timing_changes
BEGIN SELECT RAISE(ABORT,'Auction timing history is immutable'); END;
UPDATE application_metadata SET metadata_value='72',updated_at_ms=max(updated_at_ms,72)
WHERE metadata_key='data_model_version';
