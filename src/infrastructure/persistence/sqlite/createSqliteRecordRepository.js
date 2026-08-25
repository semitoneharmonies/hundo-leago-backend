const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  REPOSITORY_SCOPES,
  getRepositoryDefinition,
} = require("./repositoryCatalog");

function quoteIdentifier(identifier) {
  return `"${identifier}"`;
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDatabase(database) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.pragma !== "function"
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An opened SQLite database is required."
    );
  }
}

function assertApprovedDefinition(definition) {
  let approved;
  try {
    approved = getRepositoryDefinition(definition?.tableName);
  } catch (error) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An approved repository definition is required.",
      { cause: error }
    );
  }

  if (approved !== definition) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "The repository definition must come from the approved catalog."
    );
  }
}

function validateDefinitionAgainstSchema(database, definition) {
  const tableInfo = database.pragma(
    `table_info(${definition.tableName})`
  );
  if (tableInfo.length === 0) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "A catalog table is missing from the database schema.",
      { details: { tableName: definition.tableName } }
    );
  }

  const columnsByName = new Map(
    tableInfo.map((column) => [column.name, column])
  );
  const keyColumn = columnsByName.get(definition.keyColumn);
  if (!keyColumn || keyColumn.pk < 1) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "A repository key does not match the database schema.",
      {
        details: {
          tableName: definition.tableName,
          keyColumn: definition.keyColumn,
        },
      }
    );
  }

  const leagueColumn = columnsByName.get("league_id");
  if (
    definition.scope === REPOSITORY_SCOPES.global &&
    leagueColumn
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "A global repository unexpectedly contains league scope.",
      { details: { tableName: definition.tableName } }
    );
  }
  if (
    definition.scope === REPOSITORY_SCOPES.requiredLeague &&
    (!leagueColumn || leagueColumn.notnull !== 1)
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "A required-league repository has incompatible scope.",
      { details: { tableName: definition.tableName } }
    );
  }
  if (
    definition.scope === REPOSITORY_SCOPES.optionalLeague &&
    (!leagueColumn || leagueColumn.notnull !== 0)
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "An optional-league repository has incompatible scope.",
      { details: { tableName: definition.tableName } }
    );
  }

  const hasVersion = columnsByName.has("version");
  if (hasVersion !== definition.versioned) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "A repository version definition does not match the schema.",
      { details: { tableName: definition.tableName } }
    );
  }

  return Object.freeze(
    tableInfo.map((column) => column.name)
  );
}

function assertSafeValue(value, fieldName) {
  if (
    value === null ||
    typeof value === "string"
  ) {
    return;
  }

  if (
    typeof value === "number" &&
    Number.isSafeInteger(value)
  ) {
    return;
  }

  throw repositoryError(
    REPOSITORY_ERROR_CODES.argumentInvalid,
    "Repository values must be strings, null, or safe integers.",
    { details: { fieldName } }
  );
}

function assertKey(key) {
  if (typeof key !== "string" || key.trim() === "") {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "A non-empty record key is required."
    );
  }
  return key;
}

function assertLeagueScope(
  scope,
  options,
  {
    allowGlobal = false,
  } = {}
) {
  const hasLeagueId = Object.prototype.hasOwnProperty.call(
    options,
    "leagueId"
  );

  if (scope === REPOSITORY_SCOPES.global) {
    if (!allowGlobal && hasLeagueId) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "Global repository operations do not accept league scope."
      );
    }
    return undefined;
  }

  if (!hasLeagueId) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.scopeRequired,
      "An explicit league scope is required."
    );
  }

  const { leagueId } = options;
  if (
    leagueId === null &&
    scope === REPOSITORY_SCOPES.optionalLeague
  ) {
    return null;
  }
  if (
    typeof leagueId !== "string" ||
    leagueId.trim() === ""
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.scopeRequired,
      "League scope must be a non-empty ID or an approved null scope."
    );
  }

  return leagueId;
}

function assertExactOptionKeys(options, approvedKeys) {
  if (!isPlainObject(options)) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Repository operation options must be a plain object."
    );
  }

  const approved = new Set(approvedKeys);
  if (Object.keys(options).some((key) => !approved.has(key))) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "Repository operation options contain an unknown field."
    );
  }
}

function createSqliteRecordRepository({
  database,
  definition,
} = {}) {
  assertDatabase(database);
  assertApprovedDefinition(definition);

  const columns = validateDefinitionAgainstSchema(
    database,
    definition
  );
  const columnSet = new Set(columns);
  const tableSql = quoteIdentifier(definition.tableName);
  const keySql = quoteIdentifier(definition.keyColumn);
  const selectColumnsSql = columns
    .map(quoteIdentifier)
    .join(", ");
  const insertStatements = new Map();
  const updateStatements = new Map();

  const globalFindStatement =
    definition.scope === REPOSITORY_SCOPES.global
      ? database.prepare(
          `SELECT ${selectColumnsSql} FROM ${tableSql} ` +
            `WHERE ${keySql} = @key`
        )
      : null;
  const leagueFindStatement =
    definition.scope !== REPOSITORY_SCOPES.global
      ? database.prepare(
          `SELECT ${selectColumnsSql} FROM ${tableSql} ` +
            `WHERE ${keySql} = @key AND league_id = @leagueId`
        )
      : null;
  const nullLeagueFindStatement =
    definition.scope === REPOSITORY_SCOPES.optionalLeague
      ? database.prepare(
          `SELECT ${selectColumnsSql} FROM ${tableSql} ` +
            `WHERE ${keySql} = @key AND league_id IS NULL`
        )
      : null;
  const globalListStatement =
    definition.scope === REPOSITORY_SCOPES.global
      ? database.prepare(
          `SELECT ${selectColumnsSql} FROM ${tableSql} ` +
            `ORDER BY ${keySql} ASC`
        )
      : null;
  const leagueListStatement =
    definition.scope !== REPOSITORY_SCOPES.global
      ? database.prepare(
          `SELECT ${selectColumnsSql} FROM ${tableSql} ` +
            `WHERE league_id = @leagueId ORDER BY ${keySql} ASC`
        )
      : null;
  const nullLeagueListStatement =
    definition.scope === REPOSITORY_SCOPES.optionalLeague
      ? database.prepare(
          `SELECT ${selectColumnsSql} FROM ${tableSql} ` +
            `WHERE league_id IS NULL ORDER BY ${keySql} ASC`
        )
      : null;

  function cloneRow(row) {
    return row ? { ...row } : null;
  }

  function findByKey(options) {
    const approvedKeys =
      definition.scope === REPOSITORY_SCOPES.global
        ? ["key"]
        : ["key", "leagueId"];
    assertExactOptionKeys(options, approvedKeys);
    const key = assertKey(options.key);
    const leagueId = assertLeagueScope(
      definition.scope,
      options
    );

    try {
      if (definition.scope === REPOSITORY_SCOPES.global) {
        return cloneRow(globalFindStatement.get({ key }));
      }
      if (leagueId === null) {
        return cloneRow(nullLeagueFindStatement.get({ key }));
      }
      if (
        definition.keyColumn === "league_id" &&
        key !== leagueId
      ) {
        return null;
      }
      return cloneRow(
        leagueFindStatement.get({ key, leagueId })
      );
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "findByKey",
        tableName: definition.tableName,
      });
    }
  }

  function requireByKey(options) {
    const record = findByKey(options);
    if (!record) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.recordNotFound,
        "The requested repository record does not exist.",
        { details: { tableName: definition.tableName } }
      );
    }
    return record;
  }

  function listAll() {
    try {
      return globalListStatement.all().map(cloneRow);
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "listAll",
        tableName: definition.tableName,
      });
    }
  }

  function listByLeague(options) {
    assertExactOptionKeys(options, ["leagueId"]);
    const leagueId = assertLeagueScope(
      definition.scope,
      options
    );

    try {
      const rows =
        leagueId === null
          ? nullLeagueListStatement.all()
          : leagueListStatement.all({ leagueId });
      return rows.map(cloneRow);
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "listByLeague",
        tableName: definition.tableName,
      });
    }
  }

  function validateRecord(record) {
    if (!isPlainObject(record)) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "A repository record must be a plain object."
      );
    }

    const fieldNames = Object.keys(record);
    if (
      fieldNames.length === 0 ||
      !Object.prototype.hasOwnProperty.call(
        record,
        definition.keyColumn
      )
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "A repository record must include its stable key."
      );
    }

    for (const fieldName of fieldNames) {
      if (!columnSet.has(fieldName)) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.argumentInvalid,
          "A repository record contains an unknown field.",
          {
            details: {
              tableName: definition.tableName,
              fieldName,
            },
          }
        );
      }
      assertSafeValue(record[fieldName], fieldName);
    }

    assertKey(record[definition.keyColumn]);
    if (definition.scope !== REPOSITORY_SCOPES.global) {
      assertLeagueScope(definition.scope, {
        ...(Object.prototype.hasOwnProperty.call(
          record,
          "league_id"
        )
          ? { leagueId: record.league_id }
          : {}),
      });
    }

    return columns.filter((column) => {
      return Object.prototype.hasOwnProperty.call(record, column);
    });
  }

  function insertRecord(record) {
    const fieldNames = validateRecord(record);
    const cacheKey = fieldNames.join(",");
    let statement = insertStatements.get(cacheKey);
    if (!statement) {
      const columnSql = fieldNames
        .map(quoteIdentifier)
        .join(", ");
      const valuesSql = fieldNames
        .map((fieldName) => `@${fieldName}`)
        .join(", ");
      statement = database.prepare(
        `INSERT INTO ${tableSql} (${columnSql}) ` +
          `VALUES (${valuesSql})`
      );
      insertStatements.set(cacheKey, statement);
    }

    try {
      statement.run(record);
      const options = {
        key: record[definition.keyColumn],
      };
      if (definition.scope !== REPOSITORY_SCOPES.global) {
        options.leagueId = record.league_id;
      }
      return requireByKey(options);
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "insert",
        tableName: definition.tableName,
      });
    }
  }

  function assertVersionUpdate(options) {
    assertExactOptionKeys(options, [
      "key",
      "leagueId",
      "expectedVersion",
      "changes",
    ]);
    const key = assertKey(options.key);
    const leagueId = assertLeagueScope(
      definition.scope,
      options
    );
    if (
      !Number.isSafeInteger(options.expectedVersion) ||
      options.expectedVersion < 1
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "A positive safe expected version is required."
      );
    }
    if (
      !isPlainObject(options.changes) ||
      Object.keys(options.changes).length === 0
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "Versioned changes must be a non-empty plain object."
      );
    }

    const forbiddenFields = new Set([
      definition.keyColumn,
      "league_id",
      "version",
    ]);
    const changeFields = columns.filter((column) => {
      return Object.prototype.hasOwnProperty.call(
        options.changes,
        column
      );
    });
    if (
      changeFields.length !== Object.keys(options.changes).length ||
      changeFields.some((fieldName) => {
        return forbiddenFields.has(fieldName);
      })
    ) {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "A versioned update contains an unknown or forbidden field."
      );
    }

    for (const fieldName of changeFields) {
      assertSafeValue(options.changes[fieldName], fieldName);
    }

    return {
      changeFields,
      expectedVersion: options.expectedVersion,
      key,
      leagueId,
    };
  }

  function updateVersioned(options) {
    const {
      changeFields,
      expectedVersion,
      key,
      leagueId,
    } = assertVersionUpdate(options);
    const cacheKey = changeFields.join(",");
    let statement = updateStatements.get(cacheKey);
    if (!statement) {
      const setSql = [
        ...changeFields.map((fieldName) => {
          return `${quoteIdentifier(fieldName)} = @change_${fieldName}`;
        }),
        '"version" = "version" + 1',
      ].join(", ");
      let scopeSql = "";
      if (definition.scope !== REPOSITORY_SCOPES.global) {
        scopeSql =
          definition.scope ===
            REPOSITORY_SCOPES.optionalLeague
            ? " AND ((@leagueId IS NULL AND league_id IS NULL) " +
              "OR league_id = @leagueId)"
            : " AND league_id = @leagueId";
      }
      statement = database.prepare(
        `UPDATE ${tableSql} SET ${setSql} ` +
          `WHERE ${keySql} = @key${scopeSql} ` +
          'AND "version" = @expectedVersion'
      );
      updateStatements.set(cacheKey, statement);
    }

    const parameters = {
      key,
      expectedVersion,
    };
    if (definition.scope !== REPOSITORY_SCOPES.global) {
      parameters.leagueId = leagueId;
    }
    for (const fieldName of changeFields) {
      parameters[`change_${fieldName}`] =
        options.changes[fieldName];
    }

    try {
      const result = statement.run(parameters);
      const lookup = { key };
      if (definition.scope !== REPOSITORY_SCOPES.global) {
        lookup.leagueId = leagueId;
      }

      if (result.changes !== 1) {
        if (!findByKey(lookup)) {
          throw repositoryError(
            REPOSITORY_ERROR_CODES.recordNotFound,
            "The versioned repository record does not exist.",
            { details: { tableName: definition.tableName } }
          );
        }
        throw repositoryError(
          REPOSITORY_ERROR_CODES.versionConflict,
          "The repository record version is stale.",
          { details: { tableName: definition.tableName } }
        );
      }

      return requireByKey(lookup);
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "updateVersioned",
        tableName: definition.tableName,
      });
    }
  }

  const repository = {
    columns,
    definition,
    findByKey,
    insert: insertRecord,
    requireByKey,
    scope: definition.scope,
    tableName: definition.tableName,
  };

  if (definition.scope === REPOSITORY_SCOPES.global) {
    repository.listAll = listAll;
  } else {
    repository.listByLeague = listByLeague;
  }
  if (definition.versioned) {
    repository.updateVersioned = updateVersioned;
  }

  return Object.freeze(repository);
}

module.exports = {
  assertSafeValue,
  createSqliteRecordRepository,
  isPlainObject,
  validateDefinitionAgainstSchema,
};
