"use strict";
const { requireActor, reject } = require("./dailyRoom");

function createDailyNotificationInbox({ database, clock }) {
  const scope = "user_id=? AND related_feature='daily'";
  return {
    list({ actor }) {
      requireActor(actor);
      const rows = database.prepare(`SELECT * FROM notifications WHERE ${scope} ORDER BY created_at_ms DESC,id DESC LIMIT 200`).all(actor.id);
      return { notifications: rows.map(row => ({ id: row.id, type: row.event_type,
        messageData: JSON.parse(row.message_data_json), createdAtMs: row.created_at_ms, readAtMs: row.read_at_ms,
        related: { feature: "daily", recordId: row.related_record_id } })),
      unreadCount: database.prepare(`SELECT count(*) AS count FROM notifications WHERE ${scope} AND read_at_ms IS NULL`).get(actor.id).count };
    },
    read({ actor, input }) {
      requireActor(actor);
      const ids = input?.ids;
      if (input?.all !== true && (!Array.isArray(ids) || !ids.length || ids.length > 200 ||
        ids.some(id => typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) || new Set(ids).size !== ids.length)) {
        reject(400, "DAILY_NOTIFICATION_IDS", "Choose the Daily notifications to mark as read.");
      }
      return database.transaction(() => {
        const at = clock();
        if (input.all === true) return { changedCount: database.prepare(`UPDATE notifications SET read_at_ms=?,version=version+1 WHERE ${scope} AND read_at_ms IS NULL`).run(at, actor.id).changes };
        const get = database.prepare(`SELECT id FROM notifications WHERE ${scope} AND id=?`);
        if (ids.some(id => !get.get(actor.id, id))) reject(404, "DAILY_NOTIFICATION_MISSING", "Daily notification not found.");
        const update = database.prepare(`UPDATE notifications SET read_at_ms=?,version=version+1 WHERE ${scope} AND id=? AND read_at_ms IS NULL`);
        return { changedCount: ids.reduce((count, id) => count + update.run(at, actor.id, id).changes, 0) };
      })();
    },
  };
}
module.exports = { createDailyNotificationInbox };
