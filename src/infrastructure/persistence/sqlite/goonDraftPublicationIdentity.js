const { GOON_ID } = require('./goonDraftTiming');
const { createFreeAgentDraftNotificationContract } = require('../../../domain/freeAgentDraft/freeAgentDraftNotificationContracts');

// A reopened draft keeps its identity and earlier notifications. Its confirmed
// scheduling receipt separates the new publication from those historic events.
function createGoonDraftPublicationIdentity(database, baseUuid) {
  const supported=database?.pragma?.('user_version',{simple:true})>=93;
  const receipt=supported ? database.prepare('SELECT id FROM goon_draft_scheduling_receipts WHERE league_id=? AND fad_id=?') : null;
  const namespaceReceipt=supported ? database.prepare('SELECT id FROM goon_draft_scheduling_receipts WHERE league_id=? AND instr(?,fad_id)>0') : null;
  return {
    uuid(namespace) {
      const id=namespaceReceipt?.get(GOON_ID,namespace)?.id;
      return baseUuid(id ? `${namespace}:schedule:${id}` : namespace);
    },
    contract(input) {
      const contract=createFreeAgentDraftNotificationContract(input);
      const id=contract.messageData.leagueId===GOON_ID ? receipt?.get(GOON_ID,contract.messageData.fadId)?.id : null;
      return id ? Object.freeze({...contract,deduplicationKey:`${contract.deduplicationKey}:schedule:${id}`}) : contract;
    },
  };
}
module.exports={createGoonDraftPublicationIdentity};
