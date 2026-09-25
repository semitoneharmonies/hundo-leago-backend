const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createBuyoutAggregate, calculateBuyoutPenaltyCents } = require("../../src/domain/contracts/buyoutPolicy");
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function input() {
  return {
    command: { buyoutId:uuid(1),buyoutYearIds:[uuid(2)],contractEventId:uuid(3),ownershipEventId:uuid(4),activityId:uuid(5),leagueId:uuid(6),seasonId:uuid(7),teamId:uuid(8),playerId:uuid(9),contractId:uuid(10),ownershipId:uuid(11),expectedContractVersion:1,expectedOwnershipVersion:1,actorUserId:uuid(12),actorAuthority:"manager",confirmed:true,reason:null,occurredAtMs:1000 },
    contract:{id:uuid(10),league_id:uuid(6),player_id:uuid(9),current_team_id:uuid(8),status:"active",version:1,aav_cents:1000,auction_buyout_lock_expires_at_ms:2000,acquisition_source_type:"auction_resolution",acquisition_source_id:uuid(13),start_season_id:uuid(7)},
    ownership:{id:uuid(11),league_id:uuid(6),season_id:uuid(7),team_id:uuid(8),player_id:uuid(9),ownership_kind:"Rostered",roster_category:"Active",version:1},
    remainingContractYears:[{contractYearId:uuid(14),seasonId:uuid(7),status:"current"}],
    auctionAcquisition:{resolutionId:uuid(13),contractId:uuid(10),leagueId:uuid(6),seasonId:uuid(7),playerId:uuid(9),status:"resolved",outcomeCode:"winner",fadId:uuid(15),sourceKind:"fad_open_rapid"},
  };
}
for (const kind of ["fad_open_rapid","fad_restricted"]) test(`${kind} signing can be bought out immediately at the normal penalty`,()=>{
  const value=input();value.auctionAcquisition.sourceKind=kind;const before=structuredClone(value);const result=createBuyoutAggregate(value);
  assert.equal(result.annualPenaltyCents,calculateBuyoutPenaltyCents(1000));assert.equal(result.years.length,1);assert.deepEqual(value,before);
});
for(const [name,mutate]of [
  ["ordinary auction",x=>x.auctionAcquisition.sourceKind="ordinary_weekly"],
  ["direct Candidate Card award",x=>x.contract.acquisition_source_type="fad_automatic_award"],
  ["missing acquisition evidence",x=>delete x.auctionAcquisition],
  ["wrong contract",x=>x.auctionAcquisition.contractId=uuid(20)],
  ["wrong league",x=>x.auctionAcquisition.leagueId=uuid(20)],
  ["wrong season",x=>x.auctionAcquisition.seasonId=uuid(20)],
  ["wrong player",x=>x.auctionAcquisition.playerId=uuid(20)],
  ["wrong resolution",x=>x.auctionAcquisition.resolutionId=uuid(20)],
  ["missing draft",x=>x.auctionAcquisition.fadId=null],
  ["unfinished resolution",x=>x.auctionAcquisition.status="resolving"],
  ["no winner",x=>x.auctionAcquisition.outcomeCode="no_winner"],
])test(`Lock remains for ${name}`,()=>{const x=input();mutate(x);assert.throws(()=>createBuyoutAggregate(x),e=>e.reasonCode==="BUYOUT_LOCK_ACTIVE");});
test("Exemption applies in another league and follows the contract after a trade",()=>{
  const x=input();x.command.leagueId=x.contract.league_id=x.ownership.league_id=x.auctionAcquisition.leagueId=uuid(99);
  x.command.teamId=x.contract.current_team_id=x.ownership.team_id=uuid(98);
  assert.equal(createBuyoutAggregate(x).annualPenaltyCents,250);
});
test("Ordinary auction becomes eligible at its existing expiration",()=>{const x=input();x.auctionAcquisition.sourceKind="ordinary_weekly";x.command.occurredAtMs=2000;assert.equal(createBuyoutAggregate(x).annualPenaltyCents,250);});
test("Public command cannot supply an exemption flag",()=>{const x=input();x.command.ignoreBuyoutLock=true;assert.throws(()=>createBuyoutAggregate(x),e=>e.reasonCode==="BUYOUT_INPUT_INVALID");});
