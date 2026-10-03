const crypto = require('node:crypto');

// Called only inside the confirmed change's transaction. Notifications stay with
// their original writer: a dashboard notice must not send them a second time.
function publishLeagueChangeAnnouncement(database, {id, leagueId, actorUserId, title, message, reason, nowMs}) {
  if (!database.inTransaction) throw new Error('League announcements require the change transaction.');
  const summary = message.length > 2350 ? message.slice(0, 2300).replace(/\n[^\n]*$/, '') + '\nMore changes are available in league change history.' : message;
  const body = [summary, reason ? 'Reason: ' + reason : null].filter(Boolean).join('\n\n');
  if (body.length > 3000) throw new Error('League change announcement is too long.');
  const key = 'automatic-change:' + id;
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({title, body})).digest('hex');
  database.prepare(`INSERT INTO league_communications
    (id,league_id,created_by_user_id,kind,title,body,audience,pinned,expires_at_ms,notify,recipient_count,client_key,request_hash,created_at_ms)
    VALUES(?,?,?,'announcement',?,?,'members',0,NULL,0,0,?,?,?)
    ON CONFLICT(league_id,created_by_user_id,client_key) DO NOTHING`)
    .run(crypto.randomUUID(),leagueId,actorUserId,title,body,key,requestHash,nowMs);
}

function displayDate(value, timeZone='America/Vancouver') {
  return value == null ? 'Not set' : new Intl.DateTimeFormat('en-CA', {timeZone,dateStyle:'medium',timeStyle:'short'}).format(value);
}

function changedDates(before, after, fields, timeZone) {
  return Object.entries(fields).filter(([key])=>before[key]!==after[key])
    .map(([key,label])=>label+': '+displayDate(before[key],timeZone)+' → '+displayDate(after[key],timeZone));
}

module.exports = {publishLeagueChangeAnnouncement, displayDate, changedDates};
