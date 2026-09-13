const REPOSITORY_ERROR_CODES = Object.freeze({
  argumentInvalid: "REPOSITORY_ARGUMENT_INVALID",
  catalogInvalid: "REPOSITORY_CATALOG_INVALID",
  schemaIncompatible: "REPOSITORY_SCHEMA_INCOMPATIBLE",
  scopeRequired: "REPOSITORY_SCOPE_REQUIRED",
  recordNotFound: "REPOSITORY_RECORD_NOT_FOUND",
  versionConflict: "REPOSITORY_VERSION_CONFLICT",
  constraint: "REPOSITORY_CONSTRAINT",
  transactionAsync: "REPOSITORY_TRANSACTION_ASYNC",
  operationFailed: "REPOSITORY_OPERATION_FAILED",
});

class SqliteRepositoryError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(
      message,
      cause === undefined ? undefined : { cause }
    );
    this.name = "SqliteRepositoryError";
    this.code = code;
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
  }
}

function repositoryError(code, message, options) {
  return new SqliteRepositoryError(code, message, options);
}

function mapRepositoryError(
  error,
  {
    operation,
    tableName,
  } = {}
) {
  if (error instanceof SqliteRepositoryError) {
    return error;
  }

  const details = {
    operation,
    tableName,
  };

  if (
    typeof error?.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  ) {
    return repositoryError(
      REPOSITORY_ERROR_CODES.constraint,
      "The repository operation violated a database constraint.",
      { cause: error, details }
    );
  }

  return repositoryError(
    REPOSITORY_ERROR_CODES.operationFailed,
    "The repository operation failed.",
    { cause: error, details }
  );
}

module.exports = {
  REPOSITORY_ERROR_CODES,
  SqliteRepositoryError,
  mapRepositoryError,
  repositoryError,
};
