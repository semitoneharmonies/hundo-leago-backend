const assert = require('node:assert/strict');
const { test } = require('node:test');
const { calculateStandings } = require('../../src/domain/matchups/matchupStandingsPolicy');

const participants = ['Alpha', 'Bravo', 'Charlie', 'Delta'].map(name => ({ team_id: name, team_display_name: name }));
const result = (home, away, homeFp, awayFp) => ({
  home_team_id: home, away_team_id: away,
  home_score_hundredths: homeFp, away_score_hundredths: awayFp,
});

test('a win ranks ahead of more standings points accumulated from ties', () => {
  const rows = calculateStandings({ participants, results: [
    result('Alpha', 'Charlie', 100, 0),
    ...Array.from({ length: 3 }, () => result('Bravo', 'Delta', 200, 200)),
  ] });
  assert.equal(rows[0].teamId, 'Alpha');
  assert.equal(rows[0].wins, 1);
  assert.equal(rows[1].standingsPoints, 3);
  assert.equal(rows[1].wins, 0);
});

test('equal wins use total matchup FP even when the other team has a better differential', () => {
  const rows = calculateStandings({ participants, results: [
    result('Alpha', 'Charlie', 100, 0),
    result('Bravo', 'Delta', 300, 290),
  ] });
  assert.deepEqual(rows.map(row => [row.teamId, row.rank]), [
    ['Bravo', 1], ['Alpha', 2], ['Delta', 3], ['Charlie', 4],
  ]);
  assert.equal(rows[0].fantasyPointsDifferentialHundredths, 10);
  assert.equal(rows[1].fantasyPointsDifferentialHundredths, 100);
});

test('equal wins and total FP share rank despite different ties, percentages and differential', () => {
  const rows = calculateStandings({ participants: [...participants].reverse(), results: [
    result('Alpha', 'Charlie', 300, 290),
    result('Bravo', 'Delta', 200, 0),
    result('Bravo', 'Charlie', 100, 100),
  ] });
  assert.deepEqual(rows.map(row => [row.teamId, row.rank]), [
    ['Alpha', 1], ['Bravo', 1], ['Charlie', 3], ['Delta', 4],
  ]);
  assert.equal(rows[0].fantasyPointsForHundredths, 300);
  assert.equal(rows[1].fantasyPointsForHundredths, 300);
  assert.notEqual(rows[0].standingsPoints, rows[1].standingsPoints);
});

test('signed matchup totals break equal-win ties using exact hundredths', () => {
  const rows = calculateStandings({ participants, results: [
    result('Alpha', 'Charlie', -20, -100),
    result('Bravo', 'Delta', -19, -200),
  ] });
  assert.deepEqual(rows.map(row => row.teamId), ['Bravo', 'Alpha', 'Charlie', 'Delta']);
});
