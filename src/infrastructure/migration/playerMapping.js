const {
  canonicalize,
} = require("./sourceInventory");
const {
  normalizeCaseInsensitiveName,
} = require("./transformValues");

const PLAYER_MAPPING_ERROR_CODES = Object.freeze({
  argumentInvalid: "TRANSFORM_ARGUMENT_INVALID",
  notFound: "PLAYER_MAPPING_NOT_FOUND",
  ambiguous: "PLAYER_MAPPING_AMBIGUOUS",
  reviewRequired: "PLAYER_MAPPING_REVIEW_REQUIRED",
});

const CANONICAL_UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

class PlayerMappingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PlayerMappingError";
    this.code = code;
  }
}

function playerMappingError(code, message) {
  return new PlayerMappingError(code, message);
}

function assertBoundedCanonicalText(value, name) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 500 ||
    value.trim() !== value
  ) {
    throw playerMappingError(
      PLAYER_MAPPING_ERROR_CODES.argumentInvalid,
      `${name} must be a non-empty bounded canonical string.`
    );
  }
}

function addMapping(map, key, targetPlayerId) {
  let targets = map.get(key);
  if (!targets) {
    targets = new Set();
    map.set(key, targets);
  }
  targets.add(targetPlayerId);
}

function exactProviderKey(providerType, providerId) {
  return canonicalize([providerType, providerId]);
}

function resolveUniqueTarget(targets, { missingCode }) {
  if (!targets || targets.size === 0) {
    throw playerMappingError(
      missingCode,
      "The player mapping did not resolve to an approved target."
    );
  }
  if (targets.size !== 1) {
    throw playerMappingError(
      PLAYER_MAPPING_ERROR_CODES.ambiguous,
      "The player mapping resolved to multiple targets."
    );
  }
  return [...targets][0];
}

function createPlayerMappingIndex(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw playerMappingError(
      PLAYER_MAPPING_ERROR_CODES.argumentInvalid,
      "At least one approved player candidate is required."
    );
  }

  const providerTargets = new Map();
  const nameTargets = new Map();
  const targetIds = new Set();

  for (const candidate of candidates) {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !CANONICAL_UUID_PATTERN.test(
        candidate.targetPlayerId || ""
      )
    ) {
      throw playerMappingError(
        PLAYER_MAPPING_ERROR_CODES.argumentInvalid,
        "A player candidate has an invalid target ID."
      );
    }
    const name = normalizeCaseInsensitiveName(
      candidate.displayName,
      {
        fieldName: "player display name",
        maximumCodePoints: 200,
      }
    );
    const hasProviderType =
      candidate.providerType !== undefined &&
      candidate.providerType !== null;
    const hasProviderId =
      candidate.providerId !== undefined &&
      candidate.providerId !== null;
    if (hasProviderType !== hasProviderId) {
      throw playerMappingError(
        PLAYER_MAPPING_ERROR_CODES.argumentInvalid,
        "Provider type and provider ID must be supplied together."
      );
    }
    if (hasProviderType) {
      assertBoundedCanonicalText(
        candidate.providerType,
        "providerType"
      );
      assertBoundedCanonicalText(
        candidate.providerId,
        "providerId"
      );
      addMapping(
        providerTargets,
        exactProviderKey(
          candidate.providerType,
          candidate.providerId
        ),
        candidate.targetPlayerId
      );
    }
    addMapping(
      nameTargets,
      name.normalizedValue,
      candidate.targetPlayerId
    );
    targetIds.add(candidate.targetPlayerId);
  }

  function resolve(
    {
      sourceCollection,
      sourceKey,
      providerType = null,
      providerId = null,
      displayName,
    } = {},
    {
      allowReviewedUniqueName = false,
    } = {}
  ) {
    assertBoundedCanonicalText(
      sourceCollection,
      "sourceCollection"
    );
    assertBoundedCanonicalText(sourceKey, "sourceKey");
    const hasProviderType = providerType !== null;
    const hasProviderId = providerId !== null;
    if (hasProviderType !== hasProviderId) {
      throw playerMappingError(
        PLAYER_MAPPING_ERROR_CODES.argumentInvalid,
        "Provider type and provider ID must be supplied together."
      );
    }

    if (hasProviderType) {
      assertBoundedCanonicalText(providerType, "providerType");
      assertBoundedCanonicalText(providerId, "providerId");
      const targetId = resolveUniqueTarget(
        providerTargets.get(
          exactProviderKey(providerType, providerId)
        ),
        {
          missingCode: PLAYER_MAPPING_ERROR_CODES.notFound,
        }
      );
      return Object.freeze({
        sourceCollection,
        sourceKey,
        targetTable: "players",
        targetId,
        mappingMethod: "provider_exact",
        mappingConfidence: "exact",
      });
    }

    if (allowReviewedUniqueName !== true) {
      throw playerMappingError(
        PLAYER_MAPPING_ERROR_CODES.reviewRequired,
        "Name-only player mapping requires the explicit reviewed rule."
      );
    }
    const name = normalizeCaseInsensitiveName(displayName, {
      fieldName: "player display name",
      maximumCodePoints: 200,
    });
    const targetId = resolveUniqueTarget(
      nameTargets.get(name.normalizedValue),
      {
        missingCode: PLAYER_MAPPING_ERROR_CODES.notFound,
      }
    );
    return Object.freeze({
      sourceCollection,
      sourceKey,
      targetTable: "players",
      targetId,
      mappingMethod: "reviewed_unique_name",
      mappingConfidence: "reviewed",
    });
  }

  return Object.freeze({
    candidateCount: candidates.length,
    targetCount: targetIds.size,
    resolve,
  });
}

module.exports = {
  CANONICAL_UUID_PATTERN,
  PLAYER_MAPPING_ERROR_CODES,
  PlayerMappingError,
  createPlayerMappingIndex,
};
