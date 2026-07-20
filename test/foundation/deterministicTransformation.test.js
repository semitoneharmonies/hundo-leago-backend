const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  HUNDO_LEAGO_MIGRATION_NAMESPACE,
  UUID_PATTERN,
  canonicalIdentityName,
  createDeterministicId,
  createDeterministicMapping,
  uuidV5,
} = require("../../src/infrastructure/migration/deterministicIds");
const {
  PLAYER_MAPPING_ERROR_CODES,
  createPlayerMappingIndex,
} = require("../../src/infrastructure/migration/playerMapping");
const {
  TRANSFORM_ERROR_CODES,
  buildLevelYearSchedule,
  countCodePoints,
  normalizeCaseInsensitiveName,
  normalizeEmail,
  normalizePlayerPosition,
  requireExplicitStatus,
  toFantasyPointHundredths,
  toIntegerCents,
  toUtcUnixMilliseconds,
} = require("../../src/infrastructure/migration/transformValues");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const PROTECTED_JSON_FILES = [
  "league-state.json",
  "league.json",
  "league_dump.json",
  "league_with_meta.json",
  "players.json",
];

function assertErrorCode(code) {
  return (error) => error?.code === code;
}

function playerId(sourceKey) {
  return createDeterministicId({
    sourceBundleType: "synthetic-json-v1",
    sourceCollection: "players",
    sourceKey,
    targetTable: "players",
  });
}

function sha256File(relativePath) {
  return crypto
    .createHash("sha256")
    .update(
      fs.readFileSync(path.join(ROOT_DIRECTORY, relativePath))
    )
    .digest("hex");
}

function protectedFingerprints() {
  return Object.fromEntries(
    PROTECTED_JSON_FILES.map((relativePath) => [
      relativePath,
      sha256File(relativePath),
    ])
  );
}

function collectDataArtifacts() {
  const artifacts = [];
  const ignoredDirectories = new Set([".git", "node_modules"]);

  function walk(directoryPath) {
    for (const entry of fs.readdirSync(directoryPath, {
      withFileTypes: true,
    })) {
      if (
        entry.isDirectory() &&
        ignoredDirectories.has(entry.name)
      ) {
        continue;
      }
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (
        entry.name === "source-bundle.json" ||
        /\.(?:sqlite|sqlite3|db)(?:-(?:wal|shm))?$/i.test(
          entry.name
        )
      ) {
        artifacts.push(
          path.relative(ROOT_DIRECTORY, entryPath)
        );
      }
    }
  }

  walk(ROOT_DIRECTORY);
  return artifacts.sort();
}

describe("M2-08 deterministic IDs and pure transforms", () => {
  test("implements RFC UUIDv5 and stable collision-safe source identities", () => {
    assert.equal(
      uuidV5(
        "www.example.com",
        "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
      ),
      "2ed6657d-e927-568b-95e1-2665a8aea6a2"
    );
    assert.equal(
      HUNDO_LEAGO_MIGRATION_NAMESPACE,
      "8dc8b3a0-4c15-5f91-9b6d-20ac79c24731"
    );

    const identity = {
      sourceBundleType: "json-v1",
      sourceCollection: "players",
      sourceKey: "8478402",
      targetTable: "players",
    };
    const id = createDeterministicId(identity);
    assert.equal(id, "caae3b8f-922a-50e7-8985-e37c323bee85");
    assert.match(id, UUID_PATTERN);
    assert.equal(createDeterministicId(identity), id);

    for (const field of Object.keys(identity)) {
      assert.notEqual(
        createDeterministicId({
          ...identity,
          [field]: `${identity[field]}-changed`,
        }),
        id
      );
    }
    assert.notEqual(
      canonicalIdentityName({
        ...identity,
        sourceCollection: "players:a",
        sourceKey: "b",
      }),
      canonicalIdentityName({
        ...identity,
        sourceCollection: "players",
        sourceKey: "a:b",
      })
    );
    assert.throws(
      () =>
        createDeterministicId({
          ...identity,
          sourceKey: " untrimmed ",
        }),
      assertErrorCode(TRANSFORM_ERROR_CODES.argumentInvalid)
    );
  });

  test("returns immutable deterministic mapping report metadata", () => {
    const identity = {
      sourceBundleType: "json-v1",
      sourceCollection: "players",
      sourceKey: "8478402",
      targetTable: "players",
    };
    const mapping = createDeterministicMapping(identity);

    assert.deepEqual(mapping, {
      sourceCollection: "players",
      sourceKey: "8478402",
      targetTable: "players",
      targetId: "caae3b8f-922a-50e7-8985-e37c323bee85",
      mappingMethod: "uuid_v5_canonical_source_identity",
      mappingConfidence: "exact",
    });
    assert.equal(Object.isFrozen(mapping), true);
    mapping.sourceKey = "changed";
    assert.equal(mapping.sourceKey, "8478402");
  });

  test("preserves display values separately from case-insensitive keys and counts Unicode code points", () => {
    const emailSource = "  Grae.Ü@example.COM  ";
    const nameSource = "  Équipe 🚀  ";
    const email = normalizeEmail(emailSource);
    const name = normalizeCaseInsensitiveName(nameSource, {
      maximumCodePoints: 8,
    });

    assert.deepEqual(email, {
      emailDisplay: "Grae.Ü@example.COM",
      emailNormalized: "grae.ü@example.com",
    });
    assert.deepEqual(name, {
      displayValue: "Équipe 🚀",
      normalizedValue: "équipe 🚀",
    });
    assert.equal(countCodePoints("🚀"), 1);
    assert.equal(emailSource, "  Grae.Ü@example.COM  ");
    assert.equal(nameSource, "  Équipe 🚀  ");
    assert.equal(Object.isFrozen(email), true);
    assert.equal(Object.isFrozen(name), true);
    assert.throws(
      () =>
        normalizeCaseInsensitiveName("🚀🚀", {
          maximumCodePoints: 1,
        }),
      assertErrorCode(TRANSFORM_ERROR_CODES.argumentInvalid)
    );
  });

  test("converts decimals to safe integer hundredths with exact half-up rounding", () => {
    assert.equal(toIntegerCents("0"), 0);
    assert.equal(toIntegerCents("1"), 100);
    assert.equal(toIntegerCents("1.004"), 100);
    assert.equal(toIntegerCents("1.005"), 101);
    assert.equal(toIntegerCents(1.005), 101);
    assert.equal(toIntegerCents("999.999"), 100000);
    assert.equal(
      toIntegerCents("90071992547409.91"),
      Number.MAX_SAFE_INTEGER
    );
    assert.equal(toFantasyPointHundredths("1.25"), 125);

    for (const invalid of [
      "-1",
      "1e2",
      "",
      "one",
      Number.POSITIVE_INFINITY,
      1e-7,
    ]) {
      assert.throws(
        () => toIntegerCents(invalid),
        assertErrorCode(TRANSFORM_ERROR_CODES.argumentInvalid)
      );
    }
    assert.throws(
      () => toIntegerCents("90071992547409.92"),
      assertErrorCode(TRANSFORM_ERROR_CODES.unrepresentable)
    );
  });

  test("requires explicit timestamps, positions, and statuses", () => {
    assert.equal(toUtcUnixMilliseconds(0), 0);
    assert.equal(
      toUtcUnixMilliseconds("2026-07-19T19:00:00Z"),
      1784487600000
    );
    assert.equal(
      toUtcUnixMilliseconds("2026-07-19T12:00:00-07:00"),
      1784487600000
    );
    for (const invalid of [
      -1,
      "2026-07-19T12:00:00",
      "2026-02-30T12:00:00Z",
      "2026-07-19T12:00:00+24:00",
      "not-a-time",
    ]) {
      assert.throws(
        () => toUtcUnixMilliseconds(invalid),
        (error) =>
          error?.code ===
            TRANSFORM_ERROR_CODES.argumentInvalid ||
          error?.code ===
            TRANSFORM_ERROR_CODES.unrepresentable
      );
    }

    for (const source of ["C", "LW", "rw", " F "]) {
      assert.equal(normalizePlayerPosition(source), "F");
    }
    for (const source of ["LD", "rd", "D"]) {
      assert.equal(normalizePlayerPosition(source), "D");
    }
    assert.equal(normalizePlayerPosition("G"), "G");
    assert.throws(
      () => normalizePlayerPosition("UTIL"),
      assertErrorCode(TRANSFORM_ERROR_CODES.argumentInvalid)
    );
    assert.equal(
      requireExplicitStatus("active", ["active", "inactive"]),
      "active"
    );
    assert.throws(
      () =>
        requireExplicitStatus(undefined, [
          "active",
          "inactive",
        ]),
      assertErrorCode(TRANSFORM_ERROR_CODES.argumentInvalid)
    );
  });

  test("constructs immutable level schedules with exactly reconciled totals", () => {
    const schedule = buildLevelYearSchedule({
      family: "contract",
      annualAmountCents: 333,
      termYears: 3,
      startSeasonYear: 2026,
    });

    assert.deepEqual(schedule, {
      family: "contract",
      startSeasonYear: 2026,
      termYears: 3,
      annualAmountCents: 333,
      totalAmountCents: 999,
      years: [
        {
          sequence: 1,
          seasonYear: 2026,
          amountCents: 333,
        },
        {
          sequence: 2,
          seasonYear: 2027,
          amountCents: 333,
        },
        {
          sequence: 3,
          seasonYear: 2028,
          amountCents: 333,
        },
      ],
    });
    assert.equal(Object.isFrozen(schedule), true);
    assert.equal(Object.isFrozen(schedule.years), true);
    assert.equal(
      schedule.years.reduce(
        (total, year) => total + year.amountCents,
        0
      ),
      schedule.totalAmountCents
    );
    for (const invalid of [
      {},
      {
        family: "unknown",
        annualAmountCents: 1,
        termYears: 1,
        startSeasonYear: 2026,
      },
      {
        family: "buyout",
        annualAmountCents: -1,
        termYears: 1,
        startSeasonYear: 2026,
      },
      {
        family: "retention",
        annualAmountCents: 1,
        termYears: 0,
        startSeasonYear: 2026,
      },
    ]) {
      assert.throws(
        () => buildLevelYearSchedule(invalid),
        assertErrorCode(TRANSFORM_ERROR_CODES.argumentInvalid)
      );
    }
    assert.throws(
      () =>
        buildLevelYearSchedule({
          family: "contract",
          annualAmountCents: Number.MAX_SAFE_INTEGER,
          termYears: 2,
          startSeasonYear: 2026,
        }),
      assertErrorCode(TRANSFORM_ERROR_CODES.unrepresentable)
    );
  });

  test("maps players by exact provider ID and allows only reviewed unique-name fallback", () => {
    const candidates = [
      {
        targetPlayerId: playerId("one"),
        displayName: "Alex One",
        providerType: "nhl",
        providerId: "1001",
      },
      {
        targetPlayerId: playerId("two"),
        displayName: "Shared Name",
        providerType: "nhl",
        providerId: "1002",
      },
      {
        targetPlayerId: playerId("three"),
        displayName: "shared name",
        providerType: "nhl",
        providerId: "1003",
      },
    ];
    const index = createPlayerMappingIndex(candidates);
    const providerMapping = index.resolve({
      sourceCollection: "rosters",
      sourceKey: "row-1",
      providerType: "nhl",
      providerId: "1001",
      displayName: "Wrong Name",
    });

    assert.equal(index.candidateCount, 3);
    assert.equal(index.targetCount, 3);
    assert.equal(Object.isFrozen(index), true);
    assert.deepEqual(providerMapping, {
      sourceCollection: "rosters",
      sourceKey: "row-1",
      targetTable: "players",
      targetId: playerId("one"),
      mappingMethod: "provider_exact",
      mappingConfidence: "exact",
    });

    assert.throws(
      () =>
        index.resolve({
          sourceCollection: "rosters",
          sourceKey: "row-2",
          providerType: "nhl",
          providerId: "missing",
          displayName: "Alex One",
        }),
      assertErrorCode(PLAYER_MAPPING_ERROR_CODES.notFound)
    );
    assert.throws(
      () =>
        index.resolve({
          sourceCollection: "rosters",
          sourceKey: "row-3",
          displayName: "Alex One",
        }),
      assertErrorCode(
        PLAYER_MAPPING_ERROR_CODES.reviewRequired
      )
    );

    const nameMapping = index.resolve(
      {
        sourceCollection: "rosters",
        sourceKey: "row-4",
        displayName: " alex ONE ",
      },
      { allowReviewedUniqueName: true }
    );
    assert.equal(
      nameMapping.mappingMethod,
      "reviewed_unique_name"
    );
    assert.equal(nameMapping.mappingConfidence, "reviewed");
    assert.equal(nameMapping.targetId, playerId("one"));
    assert.throws(
      () =>
        index.resolve(
          {
            sourceCollection: "rosters",
            sourceKey: "row-5",
            displayName: "Shared Name",
          },
          { allowReviewedUniqueName: true }
        ),
      assertErrorCode(PLAYER_MAPPING_ERROR_CODES.ambiguous)
    );
  });

  test("fails duplicate provider mappings and leaves protected data and repository artifacts unchanged", () => {
    const hashesBefore = protectedFingerprints();
    const artifactsBefore = collectDataArtifacts();
    const index = createPlayerMappingIndex([
      {
        targetPlayerId: playerId("one"),
        displayName: "One",
        providerType: "nhl",
        providerId: "duplicate",
      },
      {
        targetPlayerId: playerId("two"),
        displayName: "Two",
        providerType: "nhl",
        providerId: "duplicate",
      },
    ]);

    assert.throws(
      () =>
        index.resolve({
          sourceCollection: "players",
          sourceKey: "duplicate",
          providerType: "nhl",
          providerId: "duplicate",
          displayName: "ignored",
        }),
      assertErrorCode(PLAYER_MAPPING_ERROR_CODES.ambiguous)
    );
    assert.deepEqual(protectedFingerprints(), hashesBefore);
    assert.deepEqual(collectDataArtifacts(), artifactsBefore);
    assert.deepEqual(artifactsBefore, []);
  });
});
