const {
  REPOSITORY_ERROR_CODES,
  mapRepositoryError,
  repositoryError,
} = require("./SqliteRepositoryError");
const {
  REPOSITORY_CATALOG,
  getRepositoryDefinition,
} = require("./repositoryCatalog");
const {
  createSqliteRecordRepository,
} = require("./createSqliteRecordRepository");

function validateCompleteRepositorySchema(database) {
  if (
    !database ||
    typeof database.prepare !== "function" ||
    typeof database.transaction !== "function"
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.argumentInvalid,
      "An opened SQLite database is required."
    );
  }

  let actualTables;
  try {
    actualTables = database
      .prepare(
        "SELECT name FROM sqlite_schema " +
          "WHERE type = ? AND name NOT LIKE ? AND name <> ? " +
          "ORDER BY name ASC"
      )
      .all("table", "sqlite_%", "schema_migrations")
      .map(({ name }) => name);
  } catch (error) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "The repository schema inventory could not be read.",
      { cause: error }
    );
  }

  const catalogTables = REPOSITORY_CATALOG.map(
    ({ tableName }) => tableName
  ).sort();
  if (
    actualTables.length !== catalogTables.length ||
    actualTables.some((tableName, index) => {
      return tableName !== catalogTables[index];
    })
  ) {
    throw repositoryError(
      REPOSITORY_ERROR_CODES.schemaIncompatible,
      "The repository catalog does not match the database schema.",
      {
        details: {
          actualTableCount: actualTables.length,
          catalogTableCount: catalogTables.length,
        },
      }
    );
  }

  return Object.freeze([...actualTables]);
}

function createSqliteRepositoryContext({ database } = {}) {
  const schemaTables =
    validateCompleteRepositorySchema(database);
  const repositoryEntries = REPOSITORY_CATALOG.map(
    (definition) => [
      definition.tableName,
      createSqliteRecordRepository({
        database,
        definition,
      }),
    ]
  );
  const repositories = Object.freeze(
    Object.fromEntries(repositoryEntries)
  );
  let context;

  const executeTransaction = database.transaction(
    (callback) => {
      const result = callback(context);
      if (
        result &&
        (typeof result === "object" ||
          typeof result === "function") &&
        typeof result.then === "function"
      ) {
        throw repositoryError(
          REPOSITORY_ERROR_CODES.transactionAsync,
          "Repository transactions must complete synchronously."
        );
      }
      return result;
    }
  );

  function getRepository(tableName) {
    const definition = getRepositoryDefinition(tableName);
    return repositories[definition.tableName];
  }

  function transaction(callback) {
    if (typeof callback !== "function") {
      throw repositoryError(
        REPOSITORY_ERROR_CODES.argumentInvalid,
        "A repository transaction callback is required."
      );
    }

    try {
      return executeTransaction.immediate(callback);
    } catch (error) {
      throw mapRepositoryError(error, {
        operation: "transaction",
      });
    }
  }

  context = Object.freeze({
    getRepository,
    repositories,
    schemaTables,
    transaction,
  });

  return context;
}

module.exports = {
  createSqliteRepositoryContext,
  validateCompleteRepositorySchema,
};
