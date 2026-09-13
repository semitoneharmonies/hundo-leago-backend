-- FAD-14 canonical setup-exemption Activity, notification, and realtime evidence.
-- Rebuild only the live head-48 setup-exemption insert trigger.
-- No table, column, index, view, or unrelated trigger changes.

DROP TRIGGER fad_setup_exemptions_t037_evidence_insert;

CREATE TRIGGER fad_setup_exemptions_t037_evidence_insert
BEFORE INSERT ON free_agent_draft_setup_exemptions
BEGIN
  SELECT CASE WHEN NOT (
    NEW.idempotency_request_id IS NOT NULL
    AND NEW.migration_report_sha256 IS NOT NULL
    AND NEW.bootstrap_identity_sha256 IS NOT NULL
    AND NEW.bootstrap_idempotency_request_id IS NOT NULL
    AND NEW.bootstrap_activity_id IS NOT NULL
    AND NEW.bootstrap_security_audit_event_id IS NOT NULL
    AND NEW.bootstrap_actor_user_id IS NOT NULL
    AND NEW.authorization_activity_id IS NOT NULL
    AND NEW.authorization_security_audit_event_id IS NOT NULL
    AND NEW.commissioner_notification_id IS NOT NULL
    AND NEW.outbox_event_id IS NOT NULL
    AND NEW.created_at_ms = NEW.authorized_at_ms
    AND NEW.updated_at_ms = NEW.authorized_at_ms
    AND NEW.version = 1
    AND NEW.consumed_fad_id IS NULL
    AND NEW.consumed_at_ms IS NULL
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption requires complete version-1 evidence'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM idempotency_requests
    WHERE idempotency_requests.league_id = NEW.league_id
      AND idempotency_requests.id = NEW.idempotency_request_id
      AND idempotency_requests.actor_user_id =
        NEW.authorized_by_user_id
      AND idempotency_requests.operation =
        'league.lifecycle.transition.v2'
      AND idempotency_requests.status = 'started'
      AND idempotency_requests.result_type IS NULL
      AND idempotency_requests.result_id IS NULL
      AND idempotency_requests.completed_at_ms IS NULL
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption requires its started lifecycle request'
  ) END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM season_rollovers
    WHERE season_rollovers.idempotency_request_id =
      NEW.idempotency_request_id
  ) THEN RAISE(
    ABORT,
    'lifecycle request cannot own both resource types'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM leagues
    JOIN seasons
      ON seasons.league_id = leagues.id
      AND seasons.id = NEW.season_id
    WHERE leagues.id = NEW.league_id
      AND leagues.status IN ('active', 'frozen')
      AND leagues.current_season_id = NEW.season_id
      AND seasons.status = 'active'
      AND seasons.label = '2026'
      AND seasons.nhl_season_key = '20262027'
      AND (
        SELECT COUNT(*)
        FROM seasons AS all_seasons
        WHERE all_seasons.league_id = NEW.league_id
      ) = 1
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption target is not the reset Season 2'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM migration_reports
    WHERE migration_reports.league_id = NEW.league_id
      AND migration_reports.id = NEW.migration_report_id
      AND migration_reports.status = 'succeeded'
      AND migration_reports.completed_at_ms IS NOT NULL
      AND migration_reports.reset_manifest_id =
        '2026-season-1-reset-v1'
      AND migration_reports.database_schema_version >= 1
      AND length(trim(migration_reports.source_bundle_id)) > 0
      AND json_valid(
        migration_reports.source_hashes_json
      ) = 1
      AND json_type(
        migration_reports.source_hashes_json
      ) = 'object'
      AND json_valid(migration_reports.counts_json) = 1
      AND json_type(
        migration_reports.counts_json
      ) = 'object'
      AND json_valid(migration_reports.totals_json) = 1
      AND json_type(
        migration_reports.totals_json
      ) = 'object'
      AND json_valid(migration_reports.warnings_json) = 1
      AND json_type(
        migration_reports.warnings_json
      ) = 'array'
      AND json_valid(migration_reports.rejects_json) = 1
      AND json(migration_reports.rejects_json) = '[]'
  ) OR (
    SELECT COUNT(*)
    FROM migration_reports
    WHERE migration_reports.league_id = NEW.league_id
      AND migration_reports.status = 'succeeded'
      AND migration_reports.completed_at_ms IS NOT NULL
      AND migration_reports.reset_manifest_id =
        '2026-season-1-reset-v1'
      AND migration_reports.database_schema_version >= 1
      AND length(trim(migration_reports.source_bundle_id)) > 0
      AND json_valid(
        migration_reports.source_hashes_json
      ) = 1
      AND json_type(
        migration_reports.source_hashes_json
      ) = 'object'
      AND json_valid(migration_reports.counts_json) = 1
      AND json_type(
        migration_reports.counts_json
      ) = 'object'
      AND json_valid(migration_reports.totals_json) = 1
      AND json_type(
        migration_reports.totals_json
      ) = 'object'
      AND json_valid(migration_reports.warnings_json) = 1
      AND json_type(
        migration_reports.warnings_json
      ) = 'array'
      AND json_valid(migration_reports.rejects_json) = 1
      AND json(migration_reports.rejects_json) = '[]'
  ) <> 1 THEN RAISE(
    ABORT,
    'FAD setup exemption migration report is not exact'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM leagues
    JOIN seasons
      ON seasons.league_id = leagues.id
      AND seasons.id = NEW.season_id
    JOIN idempotency_requests AS bootstrap_request
      ON bootstrap_request.league_id = leagues.id
      AND bootstrap_request.id =
        NEW.bootstrap_idempotency_request_id
    JOIN league_activity AS bootstrap_activity
      ON bootstrap_activity.league_id = leagues.id
      AND bootstrap_activity.id = NEW.bootstrap_activity_id
    JOIN security_audit_events AS bootstrap_audit
      ON bootstrap_audit.league_id = leagues.id
      AND bootstrap_audit.id =
        NEW.bootstrap_security_audit_event_id
    WHERE leagues.id = NEW.league_id
      AND NEW.bootstrap_actor_user_id =
        bootstrap_request.actor_user_id
      AND bootstrap_request.operation =
        'admin.league.bootstrap_reset_original.v1'
      AND bootstrap_request.status = 'completed'
      AND bootstrap_request.result_type = 'league'
      AND bootstrap_request.result_id = NEW.league_id
      AND bootstrap_request.created_at_ms =
        leagues.created_at_ms
      AND bootstrap_request.completed_at_ms =
        leagues.created_at_ms
      AND bootstrap_activity.season_id = NEW.season_id
      AND bootstrap_activity.event_type = 'league_created'
      AND bootstrap_activity.actor_user_id =
        NEW.bootstrap_actor_user_id
      AND bootstrap_activity.actor_authority =
        'platform_administrator'
      AND bootstrap_activity.team_id IS NULL
      AND bootstrap_activity.player_id IS NULL
      AND bootstrap_activity.related_type = 'league'
      AND bootstrap_activity.related_id = NEW.league_id
      AND bootstrap_activity.display_summary =
        leagues.name || ' was created in Setup.'
      AND bootstrap_activity.reason IS NULL
      AND bootstrap_activity.metadata_json =
        '{"leagueStatus":"setup","seasonStatus":"planned"}'
      AND bootstrap_activity.occurred_at_ms =
        leagues.created_at_ms
      AND bootstrap_audit.event_type =
        'system_bootstrap.reset_original_league_created'
      AND bootstrap_audit.outcome = 'success'
      AND bootstrap_audit.actor_user_id =
        NEW.bootstrap_actor_user_id
      AND bootstrap_audit.target_user_id IS NULL
      AND bootstrap_audit.session_id IS NULL
      AND bootstrap_audit.request_correlation_id IS NULL
      AND bootstrap_audit.reason_code =
        'closed_write_reset_handoff'
      AND bootstrap_audit.network_key_version IS NULL
      AND bootstrap_audit.network_metadata_digest IS NULL
      AND bootstrap_audit.client_metadata_json IS NULL
      AND bootstrap_audit.unknown_account_digest IS NULL
      AND bootstrap_audit.occurred_at_ms =
        leagues.created_at_ms
      AND seasons.created_at_ms = leagues.created_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption bootstrap identity is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM league_activity
    WHERE league_activity.league_id = NEW.league_id
      AND league_activity.id = NEW.authorization_activity_id
      AND league_activity.season_id = NEW.season_id
      AND league_activity.event_type =
        'fad_setup_exemption_authorized'
      AND league_activity.actor_user_id =
        NEW.authorized_by_user_id
      AND league_activity.actor_authority =
        NEW.authorized_authority
      AND league_activity.team_id IS NULL
      AND league_activity.player_id IS NULL
      AND league_activity.related_type = 'season'
      AND league_activity.related_id = NEW.season_id
      AND league_activity.display_summary =
        'Initial Season 2 Free Agent Draft exemption authorized.'
      AND league_activity.reason IS NULL
      AND league_activity.occurred_at_ms =
        NEW.authorized_at_ms
      AND json_valid(league_activity.metadata_json) = 1
      AND json_type(league_activity.metadata_json) = 'object'
      AND json(league_activity.metadata_json) =
        league_activity.metadata_json
      AND (
        SELECT COUNT(*)
        FROM json_each(league_activity.metadata_json)
      ) = 3
      AND json_extract(
        league_activity.metadata_json,
        '$.exemptionId'
      ) = NEW.id
      AND json_extract(
        league_activity.metadata_json,
        '$.seasonId'
      ) = NEW.season_id
      AND json_extract(
        league_activity.metadata_json,
        '$.migrationReportId'
      ) = NEW.migration_report_id
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption activity is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM security_audit_events
    WHERE security_audit_events.id =
      NEW.authorization_security_audit_event_id
      AND security_audit_events.event_type =
        'fad.setup_exemption_authorized'
      AND security_audit_events.outcome = 'success'
      AND security_audit_events.actor_user_id =
        NEW.authorized_by_user_id
      AND security_audit_events.target_user_id IS NULL
      AND security_audit_events.league_id = NEW.league_id
      AND security_audit_events.reason_code =
        'initial_season2_no_draft_authorized'
      AND security_audit_events.occurred_at_ms =
        NEW.authorized_at_ms
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption security audit is inconsistent'
  ) END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM notifications
    JOIN leagues
      ON leagues.id = NEW.league_id
    JOIN league_memberships AS commissioner_membership
      ON commissioner_membership.league_id = leagues.id
      AND commissioner_membership.id =
        leagues.commissioner_membership_id
    JOIN users AS commissioner_user
      ON commissioner_user.id = commissioner_membership.user_id
    WHERE notifications.league_id = NEW.league_id
      AND notifications.id = NEW.commissioner_notification_id
      AND commissioner_membership.status = 'active'
      AND commissioner_membership.permission_category =
        'commissioner'
      AND commissioner_membership.joined_at_ms <=
        NEW.authorized_at_ms
      AND commissioner_membership.ended_at_ms IS NULL
      AND commissioner_user.status = 'active'
      AND notifications.user_id = commissioner_user.id
      AND notifications.event_type =
        'fad_setup_exemption_authorized'
      AND notifications.related_feature =
        'free_agent_draft_setup'
      AND notifications.related_record_id = NEW.id
      AND notifications.delivery_status = 'pending'
      AND notifications.created_at_ms = NEW.authorized_at_ms
      AND notifications.read_at_ms IS NULL
      AND notifications.delivered_at_ms IS NULL
      AND notifications.version = 1
      AND notifications.deduplication_key =
        'fad_setup_exemption_authorized:' ||
        NEW.league_id || ':' || NEW.season_id || ':' ||
        NEW.id || ':' || commissioner_user.id
      AND notifications.message_data_json = json_object(
        'destination', json_object(
          'kind', 'commissioner_fad',
          'leagueId', NEW.league_id,
          'seasonId', NEW.season_id
        ),
        'exemptionId', NEW.id,
        'leagueId', NEW.league_id,
        'seasonId', NEW.season_id
      )
      AND json_valid(notifications.message_data_json) = 1
      AND json_type(
        notifications.message_data_json
      ) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(notifications.message_data_json)
      ) = 4
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(notifications.message_data_json) AS member
        WHERE member.key NOT IN (
          'destination', 'exemptionId', 'leagueId', 'seasonId'
        )
      )
      AND json_type(
        notifications.message_data_json,
        '$.destination'
      ) = 'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(
          notifications.message_data_json,
          '$.destination'
        )
      ) = 3
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          notifications.message_data_json,
          '$.destination'
        ) AS destination_member
        WHERE destination_member.key NOT IN (
          'kind', 'leagueId', 'seasonId'
        )
      )
      AND json_extract(
        notifications.message_data_json,
        '$.destination.kind'
      ) = 'commissioner_fad'
      AND json_extract(
        notifications.message_data_json,
        '$.destination.leagueId'
      ) = NEW.league_id
      AND json_extract(
        notifications.message_data_json,
        '$.destination.seasonId'
      ) = NEW.season_id
      AND json_extract(
        notifications.message_data_json,
        '$.leagueId'
      ) = NEW.league_id
      AND json_extract(
        notifications.message_data_json,
        '$.seasonId'
      ) = NEW.season_id
      AND json_extract(
        notifications.message_data_json,
        '$.exemptionId'
      ) = NEW.id
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption notification is inconsistent'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM outbox_events AS league_event
    WHERE league_event.league_id = NEW.league_id
      AND league_event.event_type = 'league.changed'
      AND league_event.aggregate_type = 'league'
      AND league_event.aggregate_id = NEW.league_id
      AND league_event.created_at_ms = NEW.authorized_at_ms
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM outbox_events AS league_event
    JOIN leagues AS publication_league
      ON publication_league.id = league_event.league_id
    WHERE league_event.league_id = NEW.league_id
      AND league_event.id = NEW.outbox_event_id
      AND league_event.event_type = 'league.changed'
      AND league_event.aggregate_type = 'league'
      AND league_event.aggregate_id = NEW.league_id
      AND league_event.status = 'pending'
      AND league_event.attempt_count = 0
      AND league_event.available_at_ms = NEW.authorized_at_ms
      AND league_event.published_at_ms IS NULL
      AND league_event.last_error_code IS NULL
      AND league_event.created_at_ms = NEW.authorized_at_ms
      AND league_event.updated_at_ms = NEW.authorized_at_ms
      AND league_event.version = 1
      AND json_valid(league_event.payload_json) = 1
      AND json_type(league_event.payload_json) = 'object'
      AND (
        SELECT COUNT(*) FROM json_each(league_event.payload_json)
      ) = 8
      AND NOT EXISTS (
        SELECT 1 FROM json_each(league_event.payload_json) AS member
        WHERE member.key NOT IN (
          'eventId', 'type', 'leagueId', 'resourceId',
          'version', 'reasonCode', 'occurredAt', 'related'
        )
      )
      AND json_type(league_event.payload_json, '$.eventId') = 'text'
      AND json_extract(league_event.payload_json, '$.eventId') =
        league_event.id
      AND json_type(league_event.payload_json, '$.type') = 'text'
      AND json_extract(league_event.payload_json, '$.type') =
        'league.changed'
      AND json_type(league_event.payload_json, '$.leagueId') = 'text'
      AND json_extract(league_event.payload_json, '$.leagueId') =
        NEW.league_id
      AND json_type(league_event.payload_json, '$.resourceId') = 'text'
      AND json_extract(league_event.payload_json, '$.resourceId') =
        NEW.league_id
      AND json_type(league_event.payload_json, '$.version') =
        'integer'
      AND json_extract(league_event.payload_json, '$.version') =
        publication_league.version
      AND json_type(league_event.payload_json, '$.reasonCode') = 'text'
      AND json_extract(league_event.payload_json, '$.reasonCode') =
        'league_changed'
      AND json_type(league_event.payload_json, '$.occurredAt') =
        'integer'
      AND json_extract(league_event.payload_json, '$.occurredAt') =
        NEW.authorized_at_ms
      AND json_type(league_event.payload_json, '$.related') =
        'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(league_event.payload_json, '$.related')
      ) = 8
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          league_event.payload_json,
          '$.related'
        ) AS related_member
        WHERE related_member.key NOT IN (
          'fadId', 'teamId', 'cardId', 'allocationId',
          'auctionId', 'recoveryId', 'nominationQueueId',
          'scheduleRecoveryOperationId'
        )
      )
      AND json_type(league_event.payload_json, '$.related.fadId') = 'null'
      AND json_type(league_event.payload_json, '$.related.teamId') = 'null'
      AND json_type(league_event.payload_json, '$.related.cardId') = 'null'
      AND json_type(league_event.payload_json, '$.related.allocationId') = 'null'
      AND json_type(league_event.payload_json, '$.related.auctionId') = 'null'
      AND json_type(league_event.payload_json, '$.related.recoveryId') = 'null'
      AND json_type(league_event.payload_json, '$.related.nominationQueueId') = 'null'
      AND json_type(league_event.payload_json, '$.related.scheduleRecoveryOperationId') = 'null'
      AND (
        SELECT COUNT(*)
        FROM outbox_event_audiences AS audience
        WHERE audience.league_id = league_event.league_id
          AND audience.outbox_event_id = league_event.id
      ) = 1
      AND EXISTS (
        SELECT 1
        FROM outbox_event_audiences AS audience
        WHERE audience.league_id = league_event.league_id
          AND audience.outbox_event_id = league_event.id
          AND audience.audience_kind = 'league'
          AND audience.team_id IS NULL
          AND audience.user_id IS NULL
          AND audience.created_at_ms = NEW.authorized_at_ms
      )
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption league publication is inconsistent'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM outbox_events AS activity_event
    WHERE activity_event.league_id = NEW.league_id
      AND activity_event.event_type = 'activity.created'
      AND activity_event.aggregate_type = 'activity'
      AND activity_event.aggregate_id = NEW.authorization_activity_id
      AND activity_event.created_at_ms = NEW.authorized_at_ms
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM outbox_events AS activity_event
    WHERE activity_event.league_id = NEW.league_id
      AND activity_event.event_type = 'activity.created'
      AND activity_event.aggregate_type = 'activity'
      AND activity_event.aggregate_id = NEW.authorization_activity_id
      AND activity_event.status = 'pending'
      AND activity_event.attempt_count = 0
      AND activity_event.available_at_ms = NEW.authorized_at_ms
      AND activity_event.published_at_ms IS NULL
      AND activity_event.last_error_code IS NULL
      AND activity_event.created_at_ms = NEW.authorized_at_ms
      AND activity_event.updated_at_ms = NEW.authorized_at_ms
      AND activity_event.version = 1
      AND json_valid(activity_event.payload_json) = 1
      AND json_type(activity_event.payload_json) = 'object'
      AND (
        SELECT COUNT(*) FROM json_each(activity_event.payload_json)
      ) = 8
      AND NOT EXISTS (
        SELECT 1 FROM json_each(activity_event.payload_json) AS member
        WHERE member.key NOT IN (
          'eventId', 'type', 'leagueId', 'resourceId',
          'version', 'reasonCode', 'occurredAt', 'related'
        )
      )
      AND json_type(activity_event.payload_json, '$.eventId') = 'text'
      AND json_extract(activity_event.payload_json, '$.eventId') =
        activity_event.id
      AND json_type(activity_event.payload_json, '$.type') = 'text'
      AND json_extract(activity_event.payload_json, '$.type') =
        'activity.created'
      AND json_type(activity_event.payload_json, '$.leagueId') = 'text'
      AND json_extract(activity_event.payload_json, '$.leagueId') =
        NEW.league_id
      AND json_type(activity_event.payload_json, '$.resourceId') = 'text'
      AND json_extract(activity_event.payload_json, '$.resourceId') =
        NEW.authorization_activity_id
      AND json_type(activity_event.payload_json, '$.version') =
        'integer'
      AND json_extract(activity_event.payload_json, '$.version') = 1
      AND json_type(activity_event.payload_json, '$.reasonCode') = 'text'
      AND json_extract(activity_event.payload_json, '$.reasonCode') =
        'setup_exemption_authorized'
      AND json_type(activity_event.payload_json, '$.occurredAt') =
        'integer'
      AND json_extract(activity_event.payload_json, '$.occurredAt') =
        NEW.authorized_at_ms
      AND json_type(activity_event.payload_json, '$.related') =
        'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(activity_event.payload_json, '$.related')
      ) = 8
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          activity_event.payload_json,
          '$.related'
        ) AS related_member
        WHERE related_member.key NOT IN (
          'fadId', 'teamId', 'cardId', 'allocationId',
          'auctionId', 'recoveryId', 'nominationQueueId',
          'scheduleRecoveryOperationId'
        )
      )
      AND json_type(activity_event.payload_json, '$.related.fadId') = 'null'
      AND json_type(activity_event.payload_json, '$.related.teamId') = 'null'
      AND json_type(activity_event.payload_json, '$.related.cardId') = 'null'
      AND json_type(activity_event.payload_json, '$.related.allocationId') = 'null'
      AND json_type(activity_event.payload_json, '$.related.auctionId') = 'null'
      AND json_type(activity_event.payload_json, '$.related.recoveryId') = 'null'
      AND json_type(activity_event.payload_json, '$.related.nominationQueueId') = 'null'
      AND json_type(activity_event.payload_json, '$.related.scheduleRecoveryOperationId') = 'null'
      AND (
        SELECT COUNT(*)
        FROM outbox_event_audiences AS audience
        WHERE audience.league_id = activity_event.league_id
          AND audience.outbox_event_id = activity_event.id
      ) = 1
      AND EXISTS (
        SELECT 1
        FROM outbox_event_audiences AS audience
        WHERE audience.league_id = activity_event.league_id
          AND audience.outbox_event_id = activity_event.id
          AND audience.audience_kind = 'league'
          AND audience.team_id IS NULL
          AND audience.user_id IS NULL
          AND audience.created_at_ms = NEW.authorized_at_ms
      )
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption Activity publication is inconsistent'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM outbox_events AS notification_event
    WHERE notification_event.league_id = NEW.league_id
      AND notification_event.event_type = 'notification.created'
      AND notification_event.aggregate_type = 'notification'
      AND notification_event.aggregate_id = NEW.commissioner_notification_id
      AND notification_event.created_at_ms = NEW.authorized_at_ms
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM outbox_events AS notification_event
    JOIN notifications AS publication_notification
      ON publication_notification.league_id = notification_event.league_id
      AND publication_notification.id =
        notification_event.aggregate_id
    WHERE notification_event.league_id = NEW.league_id
      AND notification_event.event_type = 'notification.created'
      AND notification_event.aggregate_type = 'notification'
      AND notification_event.aggregate_id = NEW.commissioner_notification_id
      AND notification_event.status = 'pending'
      AND notification_event.attempt_count = 0
      AND notification_event.available_at_ms = NEW.authorized_at_ms
      AND notification_event.published_at_ms IS NULL
      AND notification_event.last_error_code IS NULL
      AND notification_event.created_at_ms = NEW.authorized_at_ms
      AND notification_event.updated_at_ms = NEW.authorized_at_ms
      AND notification_event.version = 1
      AND json_valid(notification_event.payload_json) = 1
      AND json_type(notification_event.payload_json) = 'object'
      AND (
        SELECT COUNT(*) FROM json_each(notification_event.payload_json)
      ) = 8
      AND NOT EXISTS (
        SELECT 1 FROM json_each(notification_event.payload_json) AS member
        WHERE member.key NOT IN (
          'eventId', 'type', 'leagueId', 'resourceId',
          'version', 'reasonCode', 'occurredAt', 'related'
        )
      )
      AND json_type(notification_event.payload_json, '$.eventId') = 'text'
      AND json_extract(notification_event.payload_json, '$.eventId') =
        notification_event.id
      AND json_type(notification_event.payload_json, '$.type') = 'text'
      AND json_extract(notification_event.payload_json, '$.type') =
        'notification.created'
      AND json_type(notification_event.payload_json, '$.leagueId') = 'text'
      AND json_extract(notification_event.payload_json, '$.leagueId') =
        NEW.league_id
      AND json_type(notification_event.payload_json, '$.resourceId') =
        'text'
      AND json_extract(notification_event.payload_json, '$.resourceId') =
        NEW.commissioner_notification_id
      AND json_type(notification_event.payload_json, '$.version') =
        'integer'
      AND json_extract(notification_event.payload_json, '$.version') =
        publication_notification.version
      AND publication_notification.version = 1
      AND json_type(notification_event.payload_json, '$.reasonCode') =
        'text'
      AND json_extract(notification_event.payload_json, '$.reasonCode') =
        'setup_exemption_authorized'
      AND json_type(notification_event.payload_json, '$.occurredAt') =
        'integer'
      AND json_extract(notification_event.payload_json, '$.occurredAt') =
        NEW.authorized_at_ms
      AND json_type(notification_event.payload_json, '$.related') =
        'object'
      AND (
        SELECT COUNT(*)
        FROM json_each(notification_event.payload_json, '$.related')
      ) = 8
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(
          notification_event.payload_json,
          '$.related'
        ) AS related_member
        WHERE related_member.key NOT IN (
          'fadId', 'teamId', 'cardId', 'allocationId',
          'auctionId', 'recoveryId', 'nominationQueueId',
          'scheduleRecoveryOperationId'
        )
      )
      AND json_type(notification_event.payload_json, '$.related.fadId') = 'null'
      AND json_type(notification_event.payload_json, '$.related.teamId') = 'null'
      AND json_type(notification_event.payload_json, '$.related.cardId') = 'null'
      AND json_type(notification_event.payload_json, '$.related.allocationId') = 'null'
      AND json_type(notification_event.payload_json, '$.related.auctionId') = 'null'
      AND json_type(notification_event.payload_json, '$.related.recoveryId') = 'null'
      AND json_type(notification_event.payload_json, '$.related.nominationQueueId') = 'null'
      AND json_type(notification_event.payload_json, '$.related.scheduleRecoveryOperationId') = 'null'
      AND (
        SELECT COUNT(*)
        FROM outbox_event_audiences AS audience
        WHERE audience.league_id = notification_event.league_id
          AND audience.outbox_event_id = notification_event.id
      ) = 1
      AND EXISTS (
        SELECT 1
        FROM outbox_event_audiences AS audience
        WHERE audience.league_id = notification_event.league_id
          AND audience.outbox_event_id = notification_event.id
          AND audience.audience_kind = 'user'
          AND audience.team_id IS NULL
          AND audience.user_id = publication_notification.user_id
          AND audience.created_at_ms = NEW.authorized_at_ms
      )
  ) THEN RAISE(
    ABORT,
    'FAD setup exemption notification publication is inconsistent'
  ) END;

  SELECT CASE WHEN (
    SELECT COUNT(*)
    FROM outbox_events AS publication
    WHERE publication.league_id = NEW.league_id
      AND publication.created_at_ms = NEW.authorized_at_ms
      AND (
        publication.id = NEW.outbox_event_id
        OR (
          publication.aggregate_type = 'activity'
          AND publication.aggregate_id =
            NEW.authorization_activity_id
        )
        OR (
          publication.aggregate_type = 'notification'
          AND publication.aggregate_id =
            NEW.commissioner_notification_id
        )
      )
  ) <> 3 THEN RAISE(
    ABORT,
    'FAD setup exemption requires exactly three publications'
  ) END;
END;

UPDATE application_metadata
SET metadata_value = '49',
    updated_at_ms = CASE
      WHEN updated_at_ms < 49 THEN 49
      ELSE updated_at_ms
    END
WHERE metadata_key = 'data_model_version'
  AND metadata_value = '48';
