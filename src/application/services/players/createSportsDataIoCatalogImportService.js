const { randomUUID } = require("node:crypto");

const {
  PROVIDER_NAME,
} = require("../../../infrastructure/sportsdataio/SportsDataIoNhlAdapter");

class SportsDataIoCatalogImportError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.code = code;
  }
}

function requireMethod(value, method, description) {
  if (!value || typeof value[method] !== "function") {
    throw new TypeError(`SportsDataIO catalog import requires ${description}`);
  }
}

function createSportsDataIoCatalogImportService({
  catalogRepository,
  provider,
  statisticsService,
  seasonStart,
  createId = randomUUID,
} = {}) {
  requireMethod(catalogRepository, "applyCatalog", "catalog persistence");
  requireMethod(provider, "fetchCatalog", "a configured provider adapter");
  requireMethod(statisticsService, "refresh", "statistics persistence");
  if (typeof createId !== "function") {
    throw new TypeError(
      "SportsDataIO catalog import requires an ID factory."
    );
  }
  const canonicalSeasonStart =
    typeof seasonStart === "number" ? String(seasonStart) : seasonStart;
  if (!/^\d{4}$/.test(canonicalSeasonStart)) {
    throw new TypeError(
      "SportsDataIO catalog import requires a four-digit season start year."
    );
  }

  async function importLastSeason({ authorizePersist = null } = {}) {
    if (
      authorizePersist !== null &&
      typeof authorizePersist !== "function"
    ) {
      throw new TypeError(
        "SportsDataIO catalog import persistence authorization must be callable."
      );
    }
    let authorizationFailure = null;
    const guardedAuthorizePersist = authorizePersist
      ? async () => {
        try {
          await authorizePersist();
        } catch (error) {
          authorizationFailure = error;
          throw error;
        }
      }
      : null;
    let catalog;
    try {
      catalog = await provider.fetchCatalog(canonicalSeasonStart);
    } catch (cause) {
      throw new SportsDataIoCatalogImportError(
        "SPORTSDATAIO_CATALOG_PROVIDER_FAILED",
        "The SportsDataIO player catalog could not be retrieved.",
        { cause }
      );
    }
    if (
      catalog?.provider !== PROVIDER_NAME ||
      !Number.isSafeInteger(catalog.capturedAtMs) ||
      !Array.isArray(catalog.rows)
    ) {
      throw new SportsDataIoCatalogImportError(
        "SPORTSDATAIO_CATALOG_PROVIDER_INVALID",
        "The SportsDataIO player catalog response is invalid."
      );
    }

    if (guardedAuthorizePersist) await guardedAuthorizePersist();
    let catalogResult;
    try {
      catalogResult = catalogRepository.applyCatalog({
        sourceOperationId: createId(),
        provider: catalog.provider,
        capturedAtMs: catalog.capturedAtMs,
        rows: catalog.rows,
      });
    } catch (cause) {
      throw new SportsDataIoCatalogImportError(
        "SPORTSDATAIO_CATALOG_PERSISTENCE_FAILED",
        "The SportsDataIO player catalog could not be persisted.",
        { cause }
      );
    }

    let statisticsResult;
    try {
      statisticsResult = await statisticsService.refresh({
        authorizePersist: guardedAuthorizePersist,
      });
    } catch (cause) {
      if (cause === authorizationFailure) throw cause;
      throw new SportsDataIoCatalogImportError(
        "SPORTSDATAIO_STATISTICS_IMPORT_FAILED",
        "The SportsDataIO last-season statistics could not be persisted.",
        { cause }
      );
    }

    return Object.freeze({
      catalog: Object.freeze({ ...catalogResult }),
      provider: PROVIDER_NAME,
      statistics: Object.freeze({ ...statisticsResult }),
    });
  }

  return Object.freeze({ importLastSeason });
}

module.exports = {
  SportsDataIoCatalogImportError,
  createSportsDataIoCatalogImportService,
};
