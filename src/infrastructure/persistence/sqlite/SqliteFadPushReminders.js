const { freeAgentDraftSchedulerScopeSql } = require('./SqliteFreeAgentDraftSchedulerScope');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CARD_LEAD = 24 * HOUR;
const ROUND_LEAD = 10 * MINUTE;

function createSqliteFadPushReminders({ database, configuredSeasonsOnly = false }) {
  const scope = freeAgentDraftSchedulerScopeSql({ database, configuredSeasonsOnly, alias: 'f' });
  const draftScope = `l.status IN ('active','setup') AND l.current_season_id=f.season_id AND ${scope}`;
  const cards = `SELECT f.id AS fad_id,f.league_id,f.season_id,f.candidate_deadline_at_ms,
      c.id AS card_id,c.team_id
    FROM free_agent_drafts f JOIN leagues l ON l.id=f.league_id
    JOIN free_agent_draft_teams t ON t.league_id=f.league_id AND t.season_id=f.season_id AND t.fad_id=f.id
    JOIN candidate_cards c ON c.league_id=t.league_id AND c.season_id=t.season_id AND c.fad_id=t.fad_id AND c.team_id=t.team_id
    WHERE ${draftScope} AND f.status='cards_open' AND c.status='open' AND c.completeness_code<>'complete'
      AND NOT EXISTS (SELECT 1 FROM fad_deadline_controls hold WHERE hold.league_id=f.league_id AND hold.id=f.id AND hold.mode='held')`;
  const rounds = `SELECT f.id AS fad_id,f.league_id,f.season_id,r.id AS round_id,r.sequence,
      r.opens_at_ms,r.rolls_over_at_ms,
      MAX(COALESCE(json_array_length(f.initial_rollover_times_json),7),
        (SELECT MAX(total.sequence) FROM free_agent_draft_rollovers total WHERE total.league_id=f.league_id AND total.season_id=f.season_id AND total.fad_id=f.id)) AS total_rounds
    FROM free_agent_drafts f JOIN leagues l ON l.id=f.league_id
    JOIN free_agent_draft_rollovers r ON r.league_id=f.league_id AND r.season_id=f.season_id AND r.fad_id=f.id
    WHERE ${draftScope} AND f.status='rapid' AND r.status='scheduled'`;
  const dueCards = database.prepare(cards + ' AND f.candidate_deadline_at_ms>? AND f.candidate_deadline_at_ms<=?');
  const dueRounds = database.prepare(rounds + ' AND r.opens_at_ms<=? AND r.rolls_over_at_ms>? AND r.rolls_over_at_ms<=?');
  const currentCard = database.prepare(cards + ' AND f.league_id=? AND f.id=? AND c.id=? AND c.team_id=?');
  const currentRound = database.prepare(rounds + ' AND f.league_id=? AND f.id=? AND r.id=?');
  const participant = database.prepare('SELECT team_id FROM free_agent_draft_teams WHERE league_id=? AND season_id=? AND fad_id=? AND team_id=?');
  const teams = database.prepare('SELECT team_id FROM free_agent_draft_teams WHERE league_id=? AND season_id=? AND fad_id=?');
  const roundTitle = (row, now) => `FAD round ${row.sequence}/${row.total_rounds} closes in ${Math.max(1,Math.ceil((row.rolls_over_at_ms-now)/MINUTE))} min`;

  return {
    collect(now, forTeam) {
      // A bounded one-hour catch-up window avoids delivering a stale "24h" reminder after downtime.
      for (const row of dueCards.all(now + CARD_LEAD - HOUR, now + CARD_LEAD)) {
        forTeam({ leagueId:row.league_id, category:'fad_action', title:'Candidate Card due in 24h',
          url:`/leagues/${row.league_id}/free-agent-draft/${row.fad_id}/cards/${row.team_id}`,
          eventKey:`fad-card-24h:${row.fad_id}:${row.card_id}:${row.candidate_deadline_at_ms}`,
          at:now, expiresAt:row.candidate_deadline_at_ms-CARD_LEAD+HOUR,
          guard:{kind:'fad_card_24h',id:row.fad_id,cardId:row.card_id,teamId:row.team_id,deadline:row.candidate_deadline_at_ms},
        },row.team_id,now);
      }
      for (const row of dueRounds.all(now,now,now+ROUND_LEAD)) {
        for (const team of teams.all(row.league_id,row.season_id,row.fad_id)) {
          forTeam({ leagueId:row.league_id, category:'fad_action', title:roundTitle(row,now),
            url:`/leagues/${row.league_id}/free-agent-draft/${row.fad_id}`,
            eventKey:`fad-round-10m:${row.fad_id}:${row.round_id}:${row.rolls_over_at_ms}`,
            at:now, expiresAt:row.rolls_over_at_ms,
            guard:{kind:'fad_round_10m',id:row.fad_id,roundId:row.round_id,teamId:team.team_id,deadline:row.rolls_over_at_ms},
          },team.team_id,now);
        }
      }
    },
    authorize(delivery, guard, now) {
      if (guard.kind==='fad_card_24h') {
        const row=currentCard.get(delivery.league_id,guard.id,guard.cardId,guard.teamId);
        return !!row && row.candidate_deadline_at_ms===guard.deadline && now>=guard.deadline-CARD_LEAD && now<guard.deadline-CARD_LEAD+HOUR;
      }
      if (guard.kind==='fad_round_10m') {
        const row=currentRound.get(delivery.league_id,guard.id,guard.roundId);
        if (!row || row.rolls_over_at_ms!==guard.deadline || now<row.opens_at_ms || now<row.rolls_over_at_ms-ROUND_LEAD || now>=row.rolls_over_at_ms ||
          !participant.get(row.league_id,row.season_id,row.fad_id,guard.teamId)) return false;
        // Queued retries use the current countdown and known total, including extension rounds.
        const payload=JSON.parse(delivery.payload_json);
        payload.title=roundTitle(row,now);
        delivery.payload_json=JSON.stringify(payload);
        return true;
      }
      return null;
    },
  };
}

module.exports = { createSqliteFadPushReminders };
