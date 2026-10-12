const { endpoint } = require('../../domain/activity/pushPolicy');
function createWebPushAdapter({ config, client } = {}) {
  if (!config?.enabled) return { available:false };
  const webPush = client || require('web-push');
  return { available:true, send(subscription, payload, ttl) {
    endpoint(subscription.endpoint);
    return webPush.sendNotification(subscription, JSON.stringify(payload), {
      vapidDetails: { subject:config.subject, publicKey:config.publicKey, privateKey:config.privateKey },
      TTL:Math.max(0,Math.min(3600,ttl)), urgency:'normal', timeout:10_000,
      topic:require('node:crypto').createHash('sha256').update(payload.tag).digest('base64url').slice(0,32),
    });
  } };
}
module.exports = { createWebPushAdapter };
