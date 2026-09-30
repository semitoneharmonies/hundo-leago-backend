// SQL state for rollback checks inside an outer fixture savepoint. SQLite may
// serialize rolled-back pages differently without changing stored records.
function snapshotSqliteState(database) {
  const schema = database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all();
  const temporarySchema = database.prepare('SELECT type,name,tbl_name,sql FROM sqlite_temp_schema ORDER BY type,name').all();
  const tableKinds = new Map(database.pragma('table_list').filter(row => row.schema === 'main').map(row => [row.name, row.wr]));
  return {
    schema,
    temporarySchema,
    userVersion: database.pragma('user_version', {simple: true}),
    applicationId: database.pragma('application_id', {simple: true}),
    foreignKeys: database.pragma('foreign_key_check'),
    integrity: database.pragma('integrity_check', {simple: true}),
    tables: Object.fromEntries(schema.filter(row => row.type === 'table').map(({name}) => [
      name, database.prepare('SELECT ' + (tableKinds.get(name) === 1 ? '' : 'rowid AS __snapshot_rowid__, ') + '* FROM "' + name.replaceAll('"', '""') + '"').all()
        .map(row => JSON.stringify(row)).sort(),
    ])),
  };
}
module.exports = {snapshotSqliteState};
