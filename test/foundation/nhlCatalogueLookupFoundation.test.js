const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createNhlCatalogueLookup,normalizeNhlCataloguePlayer}=require('../../src/infrastructure/nhl/NhlCatalogueLookup');
const value={playerId:8479999,firstName:{default:'Casey'},lastName:{default:'Skater'},birthDate:'1998-02-03',isActive:true,position:'C',currentTeamAbbrev:'VAN'};
test('NHL catalogue normalization validates source identity and supported skaters',()=>{
 const result=normalizeNhlCataloguePlayer(value,'8479999');assert.equal(result.fullName,'Casey Skater');assert.equal(result.normalizedPosition,'F');
 for(const change of [{playerId:12},{position:'G'},{isActive:null},{birthDate:'1998-02-31'},{firstName:{default:''}},{currentTeamAbbrev:'<script>'}])assert.throws(()=>normalizeNhlCataloguePlayer({...value,...change},'8479999'));
 assert.equal(normalizeNhlCataloguePlayer({...value,position:'D',isActive:false,currentTeamAbbrev:null},'8479999').status,'historical');
});
test('lookup uses only a bounded fixed-origin request and fails closed on provider and timeout errors',async()=>{
 let calls=0;const provider=createNhlCatalogueLookup({fetchImpl:async(url,o)=>{calls++;assert.equal(url,'https://api-web.nhle.com/v1/player/8479999/landing');assert.equal(o.redirect,'error');return {ok:true,text:async()=>JSON.stringify(value)};}});
 await assert.rejects(provider.lookup('https://internal'),{code:'CATALOGUE_PROVIDER_UNAVAILABLE'});assert.equal(calls,0);assert.equal((await provider.lookup('8479999')).fullName,'Casey Skater');
 const stalled=createNhlCatalogueLookup({fetchImpl:()=>new Promise(()=>{}),timeoutMs:10});await assert.rejects(stalled.lookup('8479999'),{code:'CATALOGUE_PROVIDER_UNAVAILABLE'});
 for(const response of [{ok:false},{ok:true,text:async()=>'{invalid'},{ok:true,text:async()=>'x'.repeat(1_000_001)}])await assert.rejects(createNhlCatalogueLookup({fetchImpl:async()=>response}).lookup('8479999'),{code:'CATALOGUE_PROVIDER_UNAVAILABLE'});
});
