function signingMethod(row) {
  const source = row.source_type || row.acquisition_source_type;
  if (source === 'free_agent_draft_allocation') return 'Candidate Card';
  if (source === 'auction_resolution') {
    if (row.auction_source_kind === 'fad_open_rapid') return 'Rapid auction';
    if (row.auction_source_kind === 'fad_restricted') return 'Restricted auction';
    return 'Auction';
  }
  if (source === 'fantasy_elc') return 'Fantasy ELC';
  if (source === 'commissioner_correction') return 'Commissioner assignment';
  return 'Signing source not recorded';
}

function createPlayerCardService({ leaguePlayerReadService, repository, tradeRepository, appearanceAdapter }) {
  async function read({ authenticated, leagueId, playerId }) {
    // Membership, canonical identities and player existence are checked before
    // any league history is read, using the same boundary as player details.
    const player = leaguePlayerReadService.read({ authenticated, leagueId, playerId });
    const saved = repository.read({ leagueId, playerId });
    const active = player.league.activeContract;
    if (active && saved.cap && (saved.cap.retained_aav_cents < 0 || saved.cap.retained_aav_cents > active.aavCents)) {
      throw new Error('Player cap information could not be verified.');
    }
    const contract = active && saved.cap ? {
      ...active,
      type: saved.cap.contract_type,
      retainedAavCents: saved.cap.retained_aav_cents,
      netAavCents: active.aavCents - saved.cap.retained_aav_cents,
    } : null;
    const stats = player.statistics;
    const fantasyPointsPerGame = stats?.gamesPlayed > 0 ? stats.fantasyPointsHundredths / 100 / stats.gamesPlayed : null;
    const signings = saved.signings.map(row => {
      const original = row.metadata_json ? JSON.parse(row.metadata_json) : {};
      return {
        id: row.id, atMs: row.occurred_at_ms ?? row.created_at_ms, season: row.season_label,
        method: signingMethod(row), status: row.status,
        team: row.signing_team_id ? { id: row.signing_team_id, name: row.signing_team_name } : null,
        aavCents: original.aavCents ?? null,
        termYears: original.originalTermYears ?? null,
        totalValueCents: original.originalTotalValueCents ?? null,
      };
    });
    const trades = saved.tradeIds.map(tradeId => {
      const trade = tradeRepository.readDetail({ leagueId, tradeId });
      if (!trade?.detailsVisible || !Number.isSafeInteger(trade.completedAtMs)) {
        throw new Error('A completed player trade could not be verified.');
      }
      return {
        id: trade.id, atMs: trade.completedAtMs, status: trade.storageStatus,
        teams: trade.participants?.map(p => ({ id: p.teamId, name: p.name })) || [trade.proposingTeam, trade.receivingTeam],
        // Public proposal snapshots preserve every asset and its original terms.
        // Audit actors, private negotiation history, and mutable bids are omitted.
        assets: trade.assets.map(asset => {
          const snapshot = asset.snapshot;
          const retainedPlayer = asset.type === 'requested_retention'
            ? trade.assets.find(a => a.type === 'contract' && a.snapshot.contract?.id === snapshot.contractId)?.snapshot.player : null;
          return { ...asset, detail: {
            player: snapshot.player || retainedPlayer || null,
            originalTeamName: saved.teams.find(team => team.id === snapshot.originalTeamId)?.name || null,
            years: (snapshot.contract?.years || snapshot.years || []).map(year => ({
              season: saved.seasons.find(season => season.id === year.season_id)?.label || 'Recorded season',
              amountCents: year.aav_cents ?? year.retained_aav_cents ?? year.penalty_cents ?? null,
            })),
          } };
        }),
      };
    });
    const owner = player.league.ownership;
    const ownerTeam = owner?.team?.id ? saved.teams?.find(team => team.id === owner.team.id) : null;
    const ownership = owner ? { ...owner, team: { ...owner.team,
      primaryColour: ownerTeam?.primary_colour ?? null,
      secondaryColour: ownerTeam?.secondary_colour ?? null,
      tertiaryColour: ownerTeam?.tertiary_colour ?? null,
      patternTemplate: ownerTeam?.pattern_template ?? null,
    } } : null;
    const appearance = appearanceAdapter ? await appearanceAdapter.read({ externalIds: player.externalIds }) : null;
    return {
      leagueId, playerId, name: player.fullName, birthDate: player.birthDate,
      position: player.provider?.normalizedPosition ?? null,
      nhlTeam: appearance?.nhlTeam ?? player.provider?.nhlTeamAbbreviation ?? null,
      appearance,
      injury: player.injury ?? null,
      statistics: stats ? {
        season: stats.nhlSeasonKey, gamesPlayed: stats.gamesPlayed,
        goals: stats.goals, assists: stats.assists,
        fantasyPointsHundredths: stats.fantasyPointsHundredths, sourceUpdatedAtMs: stats.sourceUpdatedAtMs,
      } : null,
      ownership, contract,
      value: { fantasyPointsPerGame,
        perCapDollar: fantasyPointsPerGame !== null && contract?.netAavCents > 0
          ? fantasyPointsPerGame / (contract.netAavCents / 100) : null },
      history: { signings, trades },
    };
  }
  return Object.freeze({ read });
}
module.exports = { createPlayerCardService, signingMethod };
