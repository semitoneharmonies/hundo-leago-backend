const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createReleaseQaFixture } = require("../../src/operations/release/createReleaseQaFixture");
const { fixtureId, FIXTURE_DATABASE_ID, FIXTURE_ENVIRONMENT_ID } = require("../../src/operations/release/releaseQaFixtureContract");
const { openDatabase, openReadonlyDatabase } = require("../../src/infrastructure/database/connection");
const { calculateBuyoutPenaltyCents } = require("../../src/domain/contracts/buyoutPolicy");
const { inspectRecoveryFinancialConsistency } = require("../../src/operations/backups/inspectRecoveryFinancialConsistency");
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const migrationsDirectory = path.resolve(__dirname,"../../database/migrations");

test("offline financial inspection identifies relational defects without changing financial history", async t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(),"hundo-financial-recovery-"));
  t.after(() => { const real = fs.realpathSync(temporaryRoot),relative = path.relative(fs.realpathSync(os.tmpdir()),real);
    assert(relative && relative !== ".." && !relative.startsWith(".."+path.sep) && !path.isAbsolute(relative));
    assert.equal(fs.lstatSync(temporaryRoot).isSymbolicLink(),false);fs.rmSync(real,{recursive:true,force:false}); });
  const source = path.join(temporaryRoot,"release-qa.sqlite3");
  await createReleaseQaFixture({databasePath:source,environment:"test",temporaryRoot,migrationsDirectory,password:"Local financial recovery fixture 2026!"});
  const originalHash = hash(source), options = {expectedEnvironmentId:FIXTURE_ENVIRONMENT_ID,expectedDatabaseId:FIXTURE_DATABASE_ID,observedAtMs:Date.now(),migrationsDirectory};
  const inspect = file => {
    const before = hash(file),database = openReadonlyDatabase({databasePath:file});
    try { const result = inspectRecoveryFinancialConsistency({...options,database,plaintextSha256:before});
      assert.equal(hash(file),before);assert.equal(database.prepare("SELECT total_changes() n").get().n,0);
      assert.equal(result.activationReady,false);assert.equal(result.completeFinancialReconciliation,false);assert.equal(result.executable,false);
      assert.equal(JSON.stringify(result).includes("admin@release-qa.example.test"),false);return result;
    } finally { database.close(); }
  };
  let sequence = 0;
  const changed = mutation => {
    const file = path.join(temporaryRoot,`case-${++sequence}.sqlite3`);fs.copyFileSync(source,file,fs.constants.COPYFILE_EXCL);
    const writer = openDatabase({databasePath:file,environment:"test"}).database;
    try { writer.transaction(() => mutation(writer))();assert.deepEqual(writer.pragma("foreign_key_check"),[]);
      assert.deepEqual(writer.pragma("integrity_check"),[{integrity_check:"ok"}]);
    } finally { writer.close(); }
    return file;
  };
  const id = name => fixtureId(name);
  const contract1 = id("contract:leagueA:activeForward1"), contract2 = id("contract:leagueA:activeForward2"), contract3 = id("contract:leagueA:activeForward3");
  await t.test("recognizes the existing fixture's intentional buyout policy overrides and reports cap warnings separately", () => {
    const report = inspect(source);
    assert.deepEqual(report.findings.map(row=>row.code),["BUYOUT_POLICY_AMOUNT_REQUIRES_REVIEW","BUYOUT_POLICY_AMOUNT_REQUIRES_REVIEW"]);
    assert.ok(report.warnings.some(row=>row.code==="TEAM_OVER_CAP"));assert.equal(report.caps.length,16);
  });
  await t.test("a policy-consistent fixture passes even when cap warnings require manager attention", () => {
    const file = changed(db => {
      for (const row of db.prepare("SELECT b.id,c.aav_cents FROM buyout_obligations b JOIN contracts c ON c.id=b.contract_id").all()) {
        const amount = calculateBuyoutPenaltyCents(row.aav_cents);
        db.prepare("UPDATE buyout_obligations SET annual_penalty_basis_cents=? WHERE id=?").run(amount,row.id);
        db.prepare("UPDATE buyout_years SET penalty_cents=? WHERE buyout_obligation_id=?").run(amount,row.id);
      }
      db.prepare("UPDATE league_settings SET salary_cap_cents=1 WHERE league_id=?").run(id("league:leagueA"));
    });
    const report=inspect(file);assert.deepEqual(report.findings,[]);assert.equal(report.checkedRelationsConsistent,true);
    assert.ok(report.warnings.some(row=>row.code==="TEAM_OVER_CAP"));
  });
  const cases = [
    ["contract owner mismatch","ACTIVE_CONTRACT_OWNERSHIP_MISMATCH",db=>db.prepare("UPDATE contracts SET current_team_id=? WHERE id=?").run(id("team:leagueA:2"),contract1)],
    ["missing owned-player contract","ROSTER_CONTRACT_MISMATCH",db=>db.prepare("UPDATE contracts SET status='cancelled' WHERE id=?").run(contract1)],
    ["contract year AAV mismatch","CONTRACT_SCHEDULE_MISMATCH",db=>db.prepare("UPDATE contract_years SET aav_cents=aav_cents+1 WHERE contract_id=? AND year_number=1").run(contract1)],
    ["missing future contract year","CONTRACT_SCHEDULE_MISMATCH",db=>db.prepare("DELETE FROM contract_years WHERE contract_id=? AND year_number=2").run(contract2)],
    ["two current contract years","ACTIVE_CONTRACT_YEARS_MISMATCH",db=>db.prepare("UPDATE contract_years SET status='current' WHERE contract_id=? AND year_number=2").run(contract2)],
    ["normal contract on prospect rights","PROSPECT_RIGHT_CONTRACT_MISMATCH",db=>db.prepare("UPDATE contracts SET contract_type='normal' WHERE id=?").run(id("contract:leagueA:signedProspect"))],
    ["retention attached to wrong player","OBLIGATION_CONTRACT_MISMATCH",db=>db.prepare("UPDATE retention_obligations SET player_id=(SELECT player_id FROM contracts WHERE id=?) WHERE id=?").run(contract2,id("retention:leagueA"))],
    ["retention year amount mismatch","OBLIGATION_YEAR_AMOUNT_MISMATCH",db=>db.prepare("UPDATE retention_years SET retained_aav_cents=76 WHERE retention_obligation_id=?").run(id("retention:leagueA"))],
    ["retention above half AAV","RETENTION_CEILING_EXCEEDED",db=>{
      db.prepare("UPDATE retention_obligations SET retained_aav_cents=101 WHERE id=?").run(id("retention:leagueA"));
      db.prepare("UPDATE retention_years SET retained_aav_cents=101 WHERE retention_obligation_id=?").run(id("retention:leagueA"));}],
    ["missing future retention year","OBLIGATION_REMAINING_SCHEDULE_MISMATCH",db=>db.prepare("UPDATE retention_obligations SET contract_id=?,player_id=(SELECT player_id FROM contracts WHERE id=?) WHERE id=?").run(contract2,contract2,id("retention:leagueA"))],
    ["buyout year amount mismatch","OBLIGATION_YEAR_AMOUNT_MISMATCH",db=>db.prepare("UPDATE buyout_years SET penalty_cents=penalty_cents+1 WHERE buyout_obligation_id=?").run(id("buyout:leagueA"))],
    ["missing buyout schedule","OBLIGATION_SEASON_MISMATCH",db=>db.prepare("DELETE FROM buyout_years WHERE buyout_obligation_id=?").run(id("buyout:leagueA"))],
    ["inactive obligation with live years","INACTIVE_OBLIGATION_HAS_LIVE_YEARS",db=>db.prepare("UPDATE retention_obligations SET status='completed' WHERE id=?").run(id("retention:leagueA"))],
  ];
  for (const [name,code,mutation] of cases) await t.test(name,()=>{
    const file=changed(mutation),report=inspect(file);assert.ok(report.findings.some(row=>row.code===code),JSON.stringify(report.findings));
    assert.equal(hash(source),originalHash);
  });
  await t.test("shortened contracts retain eliminated old years without a false schedule defect",()=>{
    const file=changed(db=>{
      db.prepare("UPDATE contracts SET original_term_years=1,original_total_value_cents=aav_cents WHERE id=?").run(contract3);
      db.prepare("UPDATE contract_years SET status='eliminated',rollover_at_ms=created_at_ms WHERE contract_id=? AND year_number>1").run(contract3);
    });
    assert.equal(inspect(file).findings.some(row=>row.recordId===contract3),false);
  });
  await t.test("wrong source hashes, wrong identity and writable connections fail closed",()=>{
    const reader=openReadonlyDatabase({databasePath:source});
    try {
      assert.throws(()=>inspectRecoveryFinancialConsistency({...options,database:reader,plaintextSha256:"0".repeat(64)}),{code:"RECOVERY_FINANCIAL_SOURCE_CHANGED"});
      assert.throws(()=>inspectRecoveryFinancialConsistency({...options,database:reader,plaintextSha256:originalHash,expectedDatabaseId:"different-fixture"}),{code:"RECOVERY_FINANCIAL_INSPECTION_FAILED"});
      assert.equal(reader.prepare("SELECT total_changes() n").get().n,0);
    } finally { reader.close(); }
    const file=changed(()=>{}),writer=openDatabase({databasePath:file,environment:"test"}).database;
    try { assert.throws(()=>inspectRecoveryFinancialConsistency({...options,database:writer,plaintextSha256:hash(file)}),{code:"RECOVERY_FINANCIAL_INPUT_INVALID"}); }
    finally { writer.close(); }
  });
  assert.equal(hash(source),originalHash);
});
