'use strict';

// Connection-local BEFORE triggers confine an exceptional operation to its
// reviewed rows and columns. Nothing is installed in the persistent schema.
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const identifier = value => '"' + String(value).replaceAll('"', '""') + '"';

function installWriteFence(database, {leagueId, inserts, updates, deletes}) {
  const names = [];
  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  try {
    for (const {name: table} of tables) {
      for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = action === 'DELETE' ? 'OLD' : 'NEW';
        const allowed = action === 'INSERT' ? inserts[table] : action === 'DELETE' ? deletes[table] : updates[table]?.ids;
        let permitted = '0';
        if (allowed?.length) {
          permitted = `${row}.league_id=${quote(leagueId)} AND ${row}.id IN (${allowed.map(quote).join(',')})`;
          if (action === 'UPDATE') {
            const columns = database.pragma(`table_info(${identifier(table)})`).map(c => c.name);
            for (const column of columns.filter(c => !updates[table].fields.includes(c))) {
              permitted += ` AND NEW.${identifier(column)} IS OLD.${identifier(column)}`;
            }
          }
        }
        const trigger = 'team_removal_fence_' + table + '_' + action.toLowerCase();
        database.exec(`CREATE TEMP TRIGGER ${identifier(trigger)} BEFORE ${action} ON main.${identifier(table)}
          WHEN COALESCE((${permitted}),0) <> 1 BEGIN SELECT RAISE(ABORT, ${quote('TEAM_REMOVAL_UNAPPROVED_WRITE:'+table+':'+action)}); END;`);
        names.push(trigger);
      }
    }
  } catch (error) {
    for (const name of names) database.exec(`DROP TRIGGER IF EXISTS temp.${identifier(name)}`);
    throw error;
  }
  let removed = false;
  return () => {
    if (removed) return;
    for (const name of names) database.exec(`DROP TRIGGER IF EXISTS temp.${identifier(name)}`);
    removed = true;
  };
}

module.exports = {installWriteFence};
