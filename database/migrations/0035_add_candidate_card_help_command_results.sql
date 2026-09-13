-- Schema 35 adds immutable per-intent results for Candidate Card help
-- commands. The result preserves the original HTTP status and canonical
-- private representation independently from the help request's later expiry.

CREATE UNIQUE INDEX candidate_card_help_requests_exact_scope
  ON candidate_card_help_requests (
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    id
  );

CREATE UNIQUE INDEX team_manager_assignments_candidate_help_evidence
  ON team_manager_assignments (
    league_id,
    team_id,
    user_id,
    membership_id,
    id
  );

CREATE TABLE candidate_card_help_command_results (
  id TEXT PRIMARY KEY
    CHECK (length(id) = 36 AND id = lower(id)),
  league_id TEXT NOT NULL REFERENCES leagues(id) ON DELETE RESTRICT,
  season_id TEXT NOT NULL,
  fad_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  help_request_id TEXT NOT NULL,
  idempotency_request_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  actor_membership_id TEXT NOT NULL,
  actor_authority TEXT NOT NULL CHECK (actor_authority = 'manager'),
  manager_assignment_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL
    CHECK (
      length(request_sha256) = 64
      AND request_sha256 = lower(request_sha256)
      AND request_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  requested_by_display_name TEXT NOT NULL
    CHECK (
      requested_by_display_name = trim(requested_by_display_name)
      AND length(requested_by_display_name) BETWEEN 1 AND 100
    ),
  response_http_status INTEGER NOT NULL
    CHECK (response_http_status IN (200, 201)),
  response_json TEXT NOT NULL
    CHECK (
      json_valid(response_json) = 1
      AND json_type(response_json) = 'object'
      AND json(response_json) = response_json
    ),
  response_sha256 TEXT NOT NULL
    CHECK (
      length(response_sha256) = 64
      AND response_sha256 = lower(response_sha256)
      AND response_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  UNIQUE (league_id, id),
  UNIQUE (league_id, idempotency_request_id),
  FOREIGN KEY (
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    help_request_id
  ) REFERENCES candidate_card_help_requests (
    league_id,
    season_id,
    fad_id,
    card_id,
    team_id,
    id
  ) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, idempotency_request_id)
    REFERENCES idempotency_requests(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (league_id, actor_membership_id)
    REFERENCES league_memberships(league_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (
    league_id,
    team_id,
    actor_user_id,
    actor_membership_id,
    manager_assignment_id
  ) REFERENCES team_manager_assignments (
    league_id,
    team_id,
    user_id,
    membership_id,
    id
  ) ON DELETE RESTRICT
) STRICT;

CREATE INDEX candidate_card_help_command_results_help_request
  ON candidate_card_help_command_results (
    league_id,
    help_request_id,
    created_at_ms,
    id
  );

CREATE UNIQUE INDEX candidate_card_help_command_results_one_created
  ON candidate_card_help_command_results (
    league_id,
    help_request_id
  )
  WHERE response_http_status = 201;

CREATE TRIGGER candidate_card_help_command_results_valid_insert
BEFORE INSERT ON candidate_card_help_command_results
BEGIN
  SELECT CASE WHEN NOT (
    NEW.version = 1
    AND EXISTS (
      SELECT 1
      FROM idempotency_requests AS request
      WHERE request.league_id = NEW.league_id
        AND request.id = NEW.idempotency_request_id
        AND request.actor_user_id = NEW.actor_user_id
        AND request.operation = 'candidate_card.help'
        AND request.request_hash = NEW.request_sha256
        AND request.status = 'started'
        AND request.result_type IS NULL
        AND request.result_id IS NULL
        AND request.completed_at_ms IS NULL
        AND request.created_at_ms = NEW.created_at_ms
        AND request.expires_at_ms > NEW.created_at_ms
    )
    AND EXISTS (
      SELECT 1
      FROM team_manager_assignments AS assignment
      JOIN league_memberships AS membership
        ON membership.league_id = assignment.league_id
       AND membership.id = assignment.membership_id
       AND membership.user_id = assignment.user_id
      JOIN users AS actor
        ON actor.id = assignment.user_id
      WHERE assignment.league_id = NEW.league_id
        AND assignment.team_id = NEW.team_id
        AND assignment.user_id = NEW.actor_user_id
        AND assignment.membership_id = NEW.actor_membership_id
        AND assignment.id = NEW.manager_assignment_id
        AND assignment.status = 'accepted'
        AND assignment.ended_at_ms IS NULL
        AND membership.status = 'active'
        AND actor.status = 'active'
        AND NEW.actor_authority = 'manager'
    )
    AND EXISTS (
      SELECT 1
      FROM candidate_card_help_requests AS help
      JOIN candidate_cards AS card
        ON card.league_id = help.league_id
       AND card.season_id = help.season_id
       AND card.fad_id = help.fad_id
       AND card.id = help.card_id
       AND card.team_id = help.team_id
      JOIN free_agent_drafts AS fad
        ON fad.league_id = help.league_id
       AND fad.season_id = help.season_id
       AND fad.id = help.fad_id
      JOIN users AS requester
        ON requester.id = help.requested_by_user_id
      WHERE help.league_id = NEW.league_id
        AND help.season_id = NEW.season_id
        AND help.fad_id = NEW.fad_id
        AND help.card_id = NEW.card_id
        AND help.team_id = NEW.team_id
        AND help.id = NEW.help_request_id
        AND help.status = 'active'
        AND help.expires_at_ms = fad.candidate_deadline_at_ms
        AND help.requested_at_ms <= NEW.created_at_ms
        AND NEW.created_at_ms < help.expires_at_ms
        AND card.status = 'open'
        AND fad.status = 'cards_open'
        AND fad.help_opens_at_ms <= NEW.created_at_ms
        AND NEW.created_at_ms < fad.candidate_deadline_at_ms
        AND (
          (
            NEW.response_http_status = 201
            AND help.requested_by_user_id = NEW.actor_user_id
            AND help.requested_by_membership_id =
              NEW.actor_membership_id
            AND help.requested_at_ms = NEW.created_at_ms
            AND requester.status = 'active'
            AND NEW.requested_by_display_name = requester.display_name
            AND NEW.response_json = json_object(
              'helpRequestId', help.id,
              'leagueId', help.league_id,
              'seasonId', help.season_id,
              'fadId', help.fad_id,
              'cardId', help.card_id,
              'teamId', help.team_id,
              'status', 'active',
              'message', help.message,
              'requestedByUserId', help.requested_by_user_id,
              'requestedByDisplayName', requester.display_name,
              'requestedAtMs', help.requested_at_ms,
              'expiresAtMs', help.expires_at_ms,
              'version', 1
            )
          )
          OR (
            NEW.response_http_status = 200
            AND EXISTS (
              SELECT 1
              FROM candidate_card_help_command_results AS created_result
              WHERE created_result.league_id = NEW.league_id
                AND created_result.help_request_id = NEW.help_request_id
                AND created_result.response_http_status = 201
                AND created_result.requested_by_display_name =
                  NEW.requested_by_display_name
                AND created_result.response_json = NEW.response_json
                AND created_result.response_sha256 = NEW.response_sha256
            )
          )
        )
    )
  ) THEN RAISE(
    ABORT,
    'Candidate Card help result must bind its exact request, manager, grant, status, and response'
  ) END;
END;

CREATE TRIGGER candidate_card_help_command_results_immutable_update
BEFORE UPDATE ON candidate_card_help_command_results
BEGIN
  SELECT RAISE(
    ABORT,
    'Candidate Card help command results are immutable'
  );
END;

CREATE TRIGGER candidate_card_help_command_results_immutable_delete
BEFORE DELETE ON candidate_card_help_command_results
BEGIN
  SELECT RAISE(
    ABORT,
    'Candidate Card help command results are immutable'
  );
END;

CREATE TRIGGER idempotency_requests_candidate_card_help_complete
BEFORE UPDATE ON idempotency_requests
WHEN OLD.status = 'started'
  AND (
    (
      OLD.operation = 'candidate_card.help'
      AND NEW.status = 'completed'
    )
    OR NEW.result_type = 'candidate_card_help_command_result'
    OR EXISTS (
      SELECT 1
      FROM candidate_card_help_command_results AS result
      WHERE result.league_id = OLD.league_id
        AND result.idempotency_request_id = OLD.id
    )
  )
BEGIN
  SELECT CASE WHEN NOT (
    NEW.id IS OLD.id
    AND NEW.league_id IS OLD.league_id
    AND NEW.actor_user_id IS OLD.actor_user_id
    AND NEW.operation IS OLD.operation
    AND NEW.client_key IS OLD.client_key
    AND NEW.request_hash IS OLD.request_hash
    AND NEW.created_at_ms IS OLD.created_at_ms
    AND NEW.expires_at_ms IS OLD.expires_at_ms
    AND NEW.status = 'completed'
    AND NEW.result_type = 'candidate_card_help_command_result'
    AND NEW.result_id IS NOT NULL
    AND NEW.completed_at_ms IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM candidate_card_help_command_results AS result
      WHERE result.league_id = NEW.league_id
        AND result.id = NEW.result_id
        AND result.idempotency_request_id = NEW.id
        AND result.actor_user_id = NEW.actor_user_id
        AND result.request_sha256 = NEW.request_hash
        AND result.created_at_ms = NEW.completed_at_ms
    )
  ) THEN RAISE(
    ABORT,
    'Candidate Card help request must complete against its exact immutable result'
  ) END;
END;

CREATE TRIGGER idempotency_requests_candidate_card_help_completed_immutable
BEFORE UPDATE ON idempotency_requests
WHEN OLD.status = 'completed'
  AND (
    OLD.result_type = 'candidate_card_help_command_result'
    OR EXISTS (
      SELECT 1
      FROM candidate_card_help_command_results AS result
      WHERE result.league_id = OLD.league_id
        AND result.idempotency_request_id = OLD.id
    )
  )
BEGIN
  SELECT RAISE(
    ABORT,
    'completed Candidate Card help request evidence is immutable'
  );
END;

CREATE TRIGGER idempotency_requests_candidate_card_help_result_delete
BEFORE DELETE ON idempotency_requests
WHEN EXISTS (
  SELECT 1
  FROM candidate_card_help_command_results AS result
  WHERE result.league_id = OLD.league_id
    AND result.idempotency_request_id = OLD.id
)
BEGIN
  SELECT RAISE(
    ABORT,
    'Candidate Card help result request evidence is immutable'
  );
END;

UPDATE application_metadata
SET metadata_value = '35',
    updated_at_ms = CASE
      WHEN updated_at_ms < 35 THEN 35
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '34';
