const test=require('node:test');
const assert=require('node:assert/strict');
const {createLeagueResetArchiveCipher}=require('../../src/infrastructure/security/leagueResetArchiveCipher');
test('reset archive authenticates its exact league, identity, key and encrypted contents',()=>{
 const cipher=createLeagueResetArchiveCipher({encodedKey:Buffer.alloc(32,1).toString('base64url'),keyVersion:1});
 const snapshot={leagueId:'one',tables:{private:[{bid:999,card:'private candidate'}]}},sealed=cipher.seal({snapshot,archiveId:'archive'});
 const archive={id:'archive',league_id:'one',key_version:1,nonce:sealed.nonce,ciphertext:sealed.ciphertext,authentication_tag:sealed.authenticationTag};
 assert.deepEqual(cipher.open(archive),snapshot);assert.doesNotMatch(sealed.ciphertext,/private candidate/);
 for(const patch of [{league_id:'other'},{id:'another'},{key_version:2},{nonce:Buffer.alloc(12).toString('base64url')},{authentication_tag:Buffer.alloc(16).toString('base64url')},{ciphertext:'tampered'}])assert.throws(()=>cipher.open({...archive,...patch}),{code:'LEAGUE_RESET_ARCHIVE_UNAVAILABLE'});
 const wrong=createLeagueResetArchiveCipher({encodedKey:Buffer.alloc(32,2).toString('base64url'),keyVersion:1});assert.throws(()=>wrong.open(archive),{code:'LEAGUE_RESET_ARCHIVE_UNAVAILABLE'});
});
