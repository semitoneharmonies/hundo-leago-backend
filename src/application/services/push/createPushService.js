const { preferences, subscription, endpoint, invalid } = require('../../../domain/activity/pushPolicy');
function createPushService({ repository, leagueAuthorization, clock, config = { enabled:false }, adapter = { available:false }, rosterDecision = () => null }) {
  function actor(authenticated) { return leagueAuthorization.requireActiveUser(authenticated).actorUserId; }
  function settings(authenticated) { const userId=actor(authenticated); return { available:adapter.available, publicKey:adapter.available?config.publicKey:null, preferences:repository.preferences(userId) }; }
  let running=false;
  return {
    settings,
    save({authenticated,input}) {
      const userId=actor(authenticated); if(!input || Object.keys(input).join()!=='preferences') invalid();
      repository.savePreferences(userId,preferences(input.preferences),clock.nowMs()); return settings(authenticated);
    },
    subscribe({authenticated,input}) {
      const userId=actor(authenticated);
      if(!adapter.available) throw Object.assign(new Error('Push is not available.'),{code:'PUSH_UNAVAILABLE'});
      if(!input || Object.keys(input).join()!=='subscription' || !authenticated.session?.id) invalid();
      repository.subscribe(userId,authenticated.session.id,subscription(input.subscription),clock.nowMs()); return {enabled:true};
    },
    unsubscribe({authenticated,input}) {
      const userId=actor(authenticated); if(!input || Object.keys(input).join()!=='endpoint') invalid();
      repository.unsubscribe(userId,endpoint(input.endpoint)); return {enabled:false};
    },
    async deliverDue() {
      if(!adapter.available || running) return {status:'skipped',sent:0};
      running=true;
      let sent=0;
      try {
        repository.collect(clock.nowMs(),rosterDecision);
        await Promise.all(repository.due(clock.nowMs()).map(async (delivery) => {
          const now=clock.nowMs();
          const target=repository.authorize(delivery,now,rosterDecision);
          if(!target) { repository.finish(delivery.id,'suppressed',now); return; }
          if(!repository.claim(delivery.id,now)) return;
          try {
            await adapter.send(target,JSON.parse(delivery.payload_json),Math.floor((delivery.expires_at_ms-now)/1000));
            repository.finish(delivery.id,'sent',clock.nowMs()); sent++;
          } catch(error) {
            if([404,410].includes(error?.statusCode)) repository.removeSubscription(delivery.subscription_id);
            else {
              const retry=delivery.attempts<4 && (!error?.statusCode || error.statusCode===429 || error.statusCode>=500);
              repository.finish(delivery.id,retry?'pending':'failed',clock.nowMs()+Math.min(15*60_000,30_000*2**delivery.attempts));
            }
          }
        }));
        return {status:'succeeded',sent};
      } finally { running=false; }
    },
  };
}
module.exports = { createPushService };
