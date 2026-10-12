function loadWebPushConfig(env = process.env) {
  if (env.WEB_PUSH_ENABLED === undefined || env.WEB_PUSH_ENABLED === 'false') return Object.freeze({ enabled:false });
  if (env.WEB_PUSH_ENABLED !== 'true') throw new Error('WEB_PUSH_ENABLED must be true or false.');
  const publicKey = env.WEB_PUSH_PUBLIC_KEY;
  const privateKey = env.WEB_PUSH_PRIVATE_KEY;
  const subject = env.WEB_PUSH_SUBJECT;
  if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey || '') || !/^[A-Za-z0-9_-]{43}$/.test(privateKey || '') ||
    !/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject || '')) throw new Error('Web push requires valid VAPID keys and a contact mailto address.');
  const key = require('node:crypto').createECDH('prime256v1');
  key.setPrivateKey(Buffer.from(privateKey,'base64url'));
  if (key.getPublicKey().toString('base64url') !== publicKey) throw new Error('Web push keys do not match.');
  return Object.freeze({ enabled:true, publicKey, privateKey, subject });
}
module.exports = { loadWebPushConfig };
