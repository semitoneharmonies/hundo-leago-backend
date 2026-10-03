const {createHmac,createCipheriv,createDecipheriv,randomBytes}=require('node:crypto');
function createLeagueResetArchiveCipher({encodedKey,keyVersion}){
 const master=Buffer.from(encodedKey,'base64url');
 if(master.length!==32||!Number.isSafeInteger(keyVersion)||keyVersion<1)throw new TypeError('A configured recovery encryption key is required.');
 const key=createHmac('sha256',master).update('hundo:league-reset:archive:v1').digest();
 const aad=(leagueId,archiveId)=>Buffer.from(JSON.stringify({purpose:'league-reset-v1',leagueId,archiveId,keyVersion}));
 return {keyVersion,
  seal({snapshot,archiveId}){const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);cipher.setAAD(aad(snapshot.leagueId,archiveId));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(snapshot),'utf8'),cipher.final()]);return {keyVersion,nonce:nonce.toString('base64url'),ciphertext:ciphertext.toString('base64url'),authenticationTag:cipher.getAuthTag().toString('base64url')};},
  open(archive){
   try{if(archive.key_version!==keyVersion||archive.ciphertext.length>36*1024*1024)throw Error('Archive key or size mismatch');
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(archive.nonce,'base64url'));decipher.setAAD(aad(archive.league_id,archive.id));decipher.setAuthTag(Buffer.from(archive.authentication_tag,'base64url'));
    const snapshot=JSON.parse(Buffer.concat([decipher.update(Buffer.from(archive.ciphertext,'base64url')),decipher.final()]).toString('utf8'));
    if(snapshot.leagueId!==archive.league_id)throw Error('Wrong league');return snapshot;
   }catch{throw Object.assign(new Error('The retained recovery archive could not be verified with the configured key.'),{code:'LEAGUE_RESET_ARCHIVE_UNAVAILABLE'});}
  },
 };
}
module.exports={createLeagueResetArchiveCipher};
