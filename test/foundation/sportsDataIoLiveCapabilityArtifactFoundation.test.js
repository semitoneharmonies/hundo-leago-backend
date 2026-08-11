const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  serializeCanonicalJsonV1,
} = require(
  "../../src/domain/leagues/seasonRolloverEvidencePolicy"
);
const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN,
  SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_KIND,
  SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_RESULT_CODE,
  SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS,
  createSportsDataIoLiveCapabilityEvidence,
} = require(
  "../../src/domain/statistics/sportsDataIoLiveCapabilityEvidencePolicy"
);
const {
  createSportsDataIoLiveCapabilityAuthenticator,
} = require(
  "../../src/infrastructure/security/createSportsDataIoLiveCapabilityAuthenticator"
);
const {
  SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_DIRECTORY_MODE,
  SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES,
  SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FAILURE_SEAMS,
  SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE,
  SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_MAX_BYTES,
  SportsDataIoLiveCapabilityArtifactError,
  createSportsDataIoLiveCapabilityArtifact,
} = require(
  "../../src/infrastructure/statistics/SportsDataIoLiveCapabilityArtifact"
);

const CAPABILITY_SECRET =
  "artifact-capability-secret-0123456789abcdef-0123456789";
const DEDICATED_LIVE_API_KEY =
  "artifact-dedicated-live-api-key-123456";
const ISSUED_AT_MS = 1_750_000_000_000;
const NOW_MS = ISSUED_AT_MS + 1_000;
const CAPTURED_AT_MS = ISSUED_AT_MS - 10_000;
const GAME_START_MS = ISSUED_AT_MS - 86_400_000;
const SOURCE_UPDATED_AT_MS = CAPTURED_AT_MS - 1_000;
const PLAYER_ONE =
  "00000000-0000-4000-8000-000000000001";
const PLAYER_TWO =
  "00000000-0000-4000-8000-000000000002";
const PLAYER_THREE =
  "00000000-0000-4000-8000-000000000003";

function endpointProof(
  endpointKind,
  scopeKind,
  scopeValue,
  fill
) {
  return {
    endpointKind,
    scopeKind,
    scopeValue,
    httpStatus: 200,
    rowCount: 1,
    responseSha256: fill.repeat(64),
  };
}

function evidenceInput(sequence, credentialBindingHmacSha256) {
  const sourceHash = crypto
    .createHash("sha256")
    .update(`source-${sequence}`, "utf8")
    .digest("hex");
  return {
    domain: SPORTS_DATA_IO_LIVE_CAPABILITY_EVIDENCE_DOMAIN,
    schemaVersion: 1,
    evidenceId:
      `00000000-0000-4000-8000-${String(
        100 + sequence
      ).padStart(12, "0")}`,
    status: "passed",
    provider: "sportsdataio-live",
    appEnv: "staging",
    environmentId: "render-staging-service",
    backendBuildId: "build-0123456789abcdef",
    origin: "https://hundo-stage.example",
    configuredNhlSeasonKey: "20252026",
    probeNhlSeasonKey: "20242025",
    probeKind: "historical_offseason",
    probeManifestSha256: "f".repeat(64),
    capabilityKeyVersion: 7,
    credentialBindingHmacSha256,
    issuedAtMs: ISSUED_AT_MS,
    expiresAtMs:
      ISSUED_AT_MS +
      SPORTS_DATA_IO_LIVE_CAPABILITY_VALIDITY_MS,
    request: {
      requiredPlayers: [
        {
          playerId: PLAYER_ONE,
          providerPlayerId: "101",
        },
        {
          playerId: PLAYER_TWO,
          providerPlayerId: "102",
        },
        {
          playerId: PLAYER_THREE,
          providerPlayerId: "103",
        },
      ],
      requiredPlayerGames: [
        {
          playerId: PLAYER_ONE,
          providerPlayerId: "101",
          providerTeamId: "10",
          nhlGameId: "9001",
          nhlGameScheduledStartsAtMs: GAME_START_MS,
        },
      ],
    },
    capture: {
      capturedAtMs: CAPTURED_AT_MS,
      sourceVersion: `sportsdataio-live-sha256-${sourceHash}`,
      coverage: [
        {
          playerId: PLAYER_ONE,
          providerPlayerId: "101",
          providerTeamId: "10",
          disposition: "expected_game",
          nhlGameId: "9001",
          nhlGameScheduledStartsAtMs: GAME_START_MS,
          observedGameState: "final",
        },
        {
          playerId: PLAYER_TWO,
          providerPlayerId: "102",
          providerTeamId: "20",
          disposition: "no_due_game",
          nhlGameId: null,
          nhlGameScheduledStartsAtMs: null,
          observedGameState: null,
        },
        {
          playerId: PLAYER_THREE,
          providerPlayerId: "103",
          providerTeamId: null,
          disposition: "no_team",
          nhlGameId: null,
          nhlGameScheduledStartsAtMs: null,
          observedGameState: null,
        },
      ],
      observations: [
        {
          externalPlayerId: "101",
          nhlGameId: "9001",
          nhlGameScheduledStartsAtMs: GAME_START_MS,
          observedGameState: "final",
          goals: 0,
          assists: 0,
          nhlPoints: 0,
          fantasyPointsHundredths: 0,
          sourceUpdatedAtMs: SOURCE_UPDATED_AT_MS,
        },
      ],
    },
    endpointProofs: [
      endpointProof(
        "free_agents",
        "season",
        "20252026",
        "1"
      ),
      endpointProof(
        "player_game",
        "date",
        "2025-06-14",
        "2"
      ),
      endpointProof(
        "player_game",
        "date",
        "2025-06-15",
        "6"
      ),
      endpointProof(
        "players",
        "season",
        "20252026",
        "3"
      ),
      endpointProof(
        "schedule",
        "date",
        "2025-06-14",
        "4"
      ),
      endpointProof(
        "schedule",
        "date",
        "2025-06-15",
        "7"
      ),
      endpointProof(
        "season_totals",
        "season",
        "20242025",
        "5"
      ),
    ],
    explicitZeroPair: {
      playerId: PLAYER_ONE,
      providerPlayerId: "101",
      providerTeamId: "10",
      nhlGameId: "9001",
      nhlGameScheduledStartsAtMs: GAME_START_MS,
      observedGameState: "final",
      goals: 0,
      assists: 0,
      nhlPoints: 0,
      fantasyPointsHundredths: 0,
      sourceUpdatedAtMs: SOURCE_UPDATED_AT_MS,
    },
    omissionProof: {
      kind: SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_KIND,
      omittedPlayerId: PLAYER_ONE,
      omittedNhlGameId: "9001",
      resultCode:
        SPORTS_DATA_IO_LIVE_CAPABILITY_OMISSION_RESULT_CODE,
    },
    assertions:
      SPORTS_DATA_IO_LIVE_CAPABILITY_ASSERTION_KINDS.map(
        (kind) => ({ kind, passed: true })
      ),
  };
}

function expectedBindings(evidence) {
  return {
    appEnv: evidence.appEnv,
    environmentId: evidence.environmentId,
    backendBuildId: evidence.backendBuildId,
    origin: evidence.origin,
    configuredNhlSeasonKey:
      evidence.configuredNhlSeasonKey,
    probeNhlSeasonKey: evidence.probeNhlSeasonKey,
    probeKind: evidence.probeKind,
    probeManifestSha256: evidence.probeManifestSha256,
  };
}

function uuidSequence() {
  let next = 10_000;
  return () => {
    const suffix = (next += 1).toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${suffix}`;
  };
}

function fixture(
  t,
  {
    fsModule = fs,
    failureInjector,
    rootPath,
    artifactPath,
  } = {}
) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-capability-artifact-")
  );
  t.after(() => {
    fs.rmSync(temporaryRoot, {
      recursive: true,
      force: true,
    });
  });
  const persistentRoot =
    rootPath || path.join(temporaryRoot, "persistent");
  if (!rootPath) {
    fs.mkdirSync(persistentRoot, {
      mode: SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_DIRECTORY_MODE,
    });
  }
  const targetPath =
    artifactPath ||
    path.join(
      persistentRoot,
      "provider-capability",
      "sportsdataio-live-v1.json"
    );
  const authenticator =
    createSportsDataIoLiveCapabilityAuthenticator({
      capabilitySecret: CAPABILITY_SECRET,
      dedicatedLiveApiKey: DEDICATED_LIVE_API_KEY,
      capabilityKeyVersion: 7,
    });
  const artifacts = [1, 2, 3].map((sequence) => {
    const evidence = createSportsDataIoLiveCapabilityEvidence(
      evidenceInput(
        sequence,
        authenticator.credentialBindingHmacSha256()
      )
    );
    return authenticator.createArtifact(evidence);
  });
  const bindings = expectedBindings(artifacts[0].evidence);
  const createStore = (overrides = {}) =>
    createSportsDataIoLiveCapabilityArtifact({
      persistentRoot,
      artifactPath: targetPath,
      authenticator,
      fsModule,
      randomUUID: uuidSequence(),
      ...(failureInjector === undefined
        ? {}
        : { failureInjector }),
      ...overrides,
    });
  return {
    temporaryRoot,
    persistentRoot,
    artifactPath: targetPath,
    artifactDirectory: path.dirname(targetPath),
    lockPath: path.join(
      path.dirname(targetPath),
      `.${path.basename(targetPath)}.publish.lock`
    ),
    authenticator,
    artifacts,
    bindings,
    createStore,
  };
}

function publicationInput(runtime, artifact) {
  return {
    artifact,
    expectedBindings: runtime.bindings,
    nowMs: NOW_MS,
  };
}

function readInput(runtime) {
  return {
    expectedBindings: runtime.bindings,
    nowMs: NOW_MS,
  };
}

function assertArtifactError(operation, expectedCode) {
  assert.throws(
    operation,
    (error) =>
      error instanceof SportsDataIoLiveCapabilityArtifactError &&
      error.code === expectedCode &&
      error.message ===
        "The SportsDataIO live capability artifact operation failed."
  );
}

function artifactLeftovers(runtime) {
  if (!fs.existsSync(runtime.artifactDirectory)) return [];
  return fs
    .readdirSync(runtime.artifactDirectory)
    .filter(
      (name) =>
        name !== path.basename(runtime.artifactPath)
    )
    .sort();
}

test("publishes exact canonical bytes and supports synchronous pre-database verification", (t) => {
  const runtime = fixture(t);
  const store = runtime.createStore();
  const artifact = runtime.artifacts[0];
  const expectedRaw = serializeCanonicalJsonV1(artifact);

  const published = store.publish(
    publicationInput(runtime, artifact)
  );
  const read = store.readAndVerify(readInput(runtime));

  assert.equal(published.status, "published");
  assert.equal(published.artifactBytes, Buffer.byteLength(expectedRaw));
  assert.equal(fs.readFileSync(runtime.artifactPath, "utf8"), expectedRaw);
  assert.equal(expectedRaw.endsWith("\n"), false);
  assert.equal(read instanceof Promise, false);
  assert.equal(read.status, "verified");
  assert.equal(read.artifact.evidenceSha256, artifact.evidenceSha256);
  assert.equal(read.verification.status, "verified");
  assert.equal(Object.isFrozen(read), true);
  assert.equal(Object.isFrozen(read.artifact), true);
  assert.deepEqual(artifactLeftovers(runtime), []);

  if (process.platform !== "win32") {
    assert.equal(
      fs.statSync(runtime.artifactDirectory).mode & 0o777,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_DIRECTORY_MODE
    );
    assert.equal(
      fs.statSync(runtime.artifactPath).mode & 0o777,
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE
    );
  }
});

test("replays exact bytes deterministically without replacing the file or foreign lock", (t) => {
  const runtime = fixture(t);
  const store = runtime.createStore();
  const artifact = runtime.artifacts[0];
  store.publish(publicationInput(runtime, artifact));
  const before = fs.statSync(runtime.artifactPath);
  const foreignLock = "foreign-active-lock";
  fs.writeFileSync(runtime.lockPath, foreignLock, {
    mode: SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE,
  });

  const replay = store.publish(
    publicationInput(runtime, artifact)
  );
  const after = fs.statSync(runtime.artifactPath);

  assert.equal(replay.status, "replayed");
  assert.equal(before.dev, after.dev);
  assert.equal(before.ino, after.ino);
  assert.equal(fs.readFileSync(runtime.lockPath, "utf8"), foreignLock);
});

test("atomically replaces one valid artifact and leaves no owned temporary state", (t) => {
  const runtime = fixture(t);
  const store = runtime.createStore();
  store.publish(publicationInput(runtime, runtime.artifacts[0]));
  const prior = fs.statSync(runtime.artifactPath);

  const replaced = store.publish(
    publicationInput(runtime, runtime.artifacts[1])
  );
  const current = fs.statSync(runtime.artifactPath);

  assert.equal(replaced.status, "replaced");
  assert.notEqual(prior.ino, current.ino);
  assert.equal(
    store.readAndVerify(readInput(runtime)).artifact.evidenceSha256,
    runtime.artifacts[1].evidenceSha256
  );
  assert.deepEqual(artifactLeftovers(runtime), []);
});

test("every publication failure seam removes a new artifact and only owned files", async (t) => {
  for (const seam of
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FAILURE_SEAMS) {
    await t.test(seam, () => {
      const runtime = fixture(t);
      const store = runtime.createStore({
        failureInjector(step) {
          if (step === seam) throw new Error("private injected failure");
        },
      });

      assertArtifactError(
        () =>
          store.publish(
            publicationInput(runtime, runtime.artifacts[0])
          ),
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationFailed
      );
      assert.equal(fs.existsSync(runtime.artifactPath), false);
      assert.deepEqual(artifactLeftovers(runtime), []);
    });
  }
});

test("every publication failure seam preserves the prior valid artifact byte-for-byte", async (t) => {
  for (const seam of
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FAILURE_SEAMS) {
    await t.test(seam, () => {
      const runtime = fixture(t);
      const baseStore = runtime.createStore();
      baseStore.publish(
        publicationInput(runtime, runtime.artifacts[0])
      );
      const priorRaw = fs.readFileSync(runtime.artifactPath);
      const priorStat = fs.statSync(runtime.artifactPath);
      const failingStore = runtime.createStore({
        failureInjector(step) {
          if (step === seam) throw new Error("private injected failure");
        },
      });

      assertArtifactError(
        () =>
          failingStore.publish(
            publicationInput(runtime, runtime.artifacts[1])
          ),
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationFailed
      );

      assert.deepEqual(
        fs.readFileSync(runtime.artifactPath),
        priorRaw
      );
      const verified = baseStore.readAndVerify(readInput(runtime));
      assert.equal(
        verified.artifact.evidenceSha256,
        runtime.artifacts[0].evidenceSha256
      );
      if (![
        "after_rename",
        "directory_fsynced",
        "final_reread_verified",
      ].includes(seam)) {
        assert.equal(fs.statSync(runtime.artifactPath).ino, priorStat.ino);
      }
      assert.deepEqual(artifactLeftovers(runtime), []);
    });
  }
});

test("active, stale, malformed, and symlink locks contend and remain untouched", async (t) => {
  for (const [name, createLock] of [
    [
      "active",
      (runtime) =>
        fs.writeFileSync(runtime.lockPath, "active", {
          mode: SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE,
        }),
    ],
    [
      "stale",
      (runtime) => {
        fs.writeFileSync(runtime.lockPath, "stale", {
          mode: SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE,
        });
        fs.utimesSync(runtime.lockPath, new Date(0), new Date(0));
      },
    ],
    [
      "malformed",
      (runtime) =>
        fs.writeFileSync(runtime.lockPath, "{", {
          mode: SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE,
        }),
    ],
  ]) {
    await t.test(name, () => {
      const runtime = fixture(t);
      const store = runtime.createStore();
      store.publish(publicationInput(runtime, runtime.artifacts[0]));
      createLock(runtime);
      const lockBefore = fs.readFileSync(runtime.lockPath);
      const artifactBefore = fs.readFileSync(runtime.artifactPath);

      assertArtifactError(
        () =>
          store.publish(
            publicationInput(runtime, runtime.artifacts[1])
          ),
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationContended
      );
      assert.deepEqual(fs.readFileSync(runtime.lockPath), lockBefore);
      assert.deepEqual(
        fs.readFileSync(runtime.artifactPath),
        artifactBefore
      );
    });
  }

  await t.test("symlink", (subtest) => {
    const runtime = fixture(subtest);
    const store = runtime.createStore();
    store.publish(publicationInput(runtime, runtime.artifacts[0]));
    const target = path.join(runtime.temporaryRoot, "foreign-lock");
    fs.writeFileSync(target, "foreign");
    try {
      fs.symlinkSync(target, runtime.lockPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) {
        subtest.skip("symlink creation is unavailable");
        return;
      }
      throw error;
    }
    assertArtifactError(
      () =>
        store.publish(
          publicationInput(runtime, runtime.artifacts[1])
        ),
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .publicationContended
    );
    assert.equal(fs.readFileSync(target, "utf8"), "foreign");
    assert.equal(fs.lstatSync(runtime.lockPath).isSymbolicLink(), true);
  });
});

test("release never deletes a foreign lock swapped into the owned pathname", (t) => {
  const runtime = fixture(t);
  const swappingFs = Object.create(fs);
  let swapped = false;
  swappingFs.renameSync = (sourcePath, targetPath) => {
    if (
      !swapped &&
      sourcePath === runtime.lockPath &&
      targetPath.includes(".release-")
    ) {
      swapped = true;
      fs.renameSync(
        sourcePath,
        `${sourcePath}.original-owner`
      );
      fs.writeFileSync(sourcePath, "foreign-replacement", {
        mode: SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE,
      });
    }
    return fs.renameSync(sourcePath, targetPath);
  };
  const store = runtime.createStore({ fsModule: swappingFs });

  assert.equal(
    store.publish(
      publicationInput(runtime, runtime.artifacts[0])
    ).status,
    "published"
  );
  assert.equal(swapped, true);
  assert.equal(
    fs.readFileSync(runtime.lockPath, "utf8"),
    "foreign-replacement"
  );
});

test("rejects relative, broad, direct-root, escaping, and non-JSON artifact paths", (t) => {
  const runtime = fixture(t);
  const authenticator = runtime.authenticator;
  const invalidLayouts = [
    {
      persistentRoot: "relative-root",
      artifactPath: runtime.artifactPath,
    },
    {
      persistentRoot: path.parse(runtime.persistentRoot).root,
      artifactPath: runtime.artifactPath,
    },
    {
      persistentRoot: runtime.persistentRoot,
      artifactPath: "relative-artifact.json",
    },
    {
      persistentRoot: runtime.persistentRoot,
      artifactPath: path.join(
        runtime.persistentRoot,
        "direct.json"
      ),
    },
    {
      persistentRoot: runtime.persistentRoot,
      artifactPath: path.join(
        runtime.persistentRoot,
        "..",
        "escape.json"
      ),
    },
    {
      persistentRoot: runtime.persistentRoot,
      artifactPath: path.join(
        runtime.persistentRoot,
        "provider-capability",
        "artifact.txt"
      ),
    },
  ];

  for (const layout of invalidLayouts) {
    assertArtifactError(
      () =>
        createSportsDataIoLiveCapabilityArtifact({
          ...layout,
          authenticator,
        }),
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
  }
});

test("rejects symlink or reparse parents and artifact targets without touching their targets", async (t) => {
  await t.test("parent", (subtest) => {
    const runtime = fixture(subtest);
    const outside = path.join(runtime.temporaryRoot, "outside-parent");
    const linked = path.join(runtime.persistentRoot, "linked-parent");
    fs.mkdirSync(outside);
    try {
      fs.symlinkSync(
        outside,
        linked,
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) {
        subtest.skip("directory links are unavailable");
        return;
      }
      throw error;
    }
    assertArtifactError(
      () =>
        createSportsDataIoLiveCapabilityArtifact({
          persistentRoot: runtime.persistentRoot,
          artifactPath: path.join(linked, "artifact.json"),
          authenticator: runtime.authenticator,
        }),
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  await t.test("target", (subtest) => {
    const runtime = fixture(subtest);
    fs.mkdirSync(runtime.artifactDirectory, {
      mode: SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_DIRECTORY_MODE,
    });
    const outside = path.join(runtime.temporaryRoot, "outside-target");
    fs.writeFileSync(outside, "do-not-touch");
    try {
      fs.symlinkSync(outside, runtime.artifactPath, "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error?.code)) {
        subtest.skip("file links are unavailable");
        return;
      }
      throw error;
    }
    const store = runtime.createStore();
    assertArtifactError(
      () => store.readAndVerify(readInput(runtime)),
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
    assertArtifactError(
      () =>
        store.publish(
          publicationInput(runtime, runtime.artifacts[0])
        ),
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
    assert.equal(fs.readFileSync(outside, "utf8"), "do-not-touch");
  });
});

test("simulated reparse metadata fails closed when host symlink privileges are unavailable", (t) => {
  const runtime = fixture(t);
  fs.mkdirSync(runtime.artifactDirectory, {
    mode: SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_DIRECTORY_MODE,
  });
  const parentReparseFs = Object.create(fs);
  parentReparseFs.lstatSync = (filePath) => {
    const stat = fs.lstatSync(filePath);
    if (filePath === runtime.artifactDirectory) {
      return Object.create(stat, {
        isSymbolicLink: {
          value: () => true,
        },
      });
    }
    return stat;
  };
  assertArtifactError(
    () => runtime.createStore({ fsModule: parentReparseFs }),
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .pathUnsafe
  );

  const normalStore = runtime.createStore();
  normalStore.publish(
    publicationInput(runtime, runtime.artifacts[0])
  );
  const targetReparseFs = Object.create(fs);
  targetReparseFs.lstatSync = (filePath) => {
    const stat = fs.lstatSync(filePath);
    if (filePath === runtime.artifactPath) {
      return Object.create(stat, {
        isSymbolicLink: {
          value: () => true,
        },
      });
    }
    return stat;
  };
  const targetStore = runtime.createStore({
    fsModule: targetReparseFs,
  });
  assertArtifactError(
    () => targetStore.readAndVerify(readInput(runtime)),
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .pathUnsafe
  );
});

test("requests exact private modes and executes the durable publication seams in order", (t) => {
  const runtime = fixture(t);
  const observedDirectoryModes = [];
  const observedFileModes = [];
  const observedSeams = [];
  const recordingFs = Object.create(fs);
  recordingFs.mkdirSync = (directoryPath, options) => {
    observedDirectoryModes.push(options?.mode);
    return fs.mkdirSync(directoryPath, options);
  };
  recordingFs.openSync = (filePath, flags, mode) => {
    if (mode !== undefined) observedFileModes.push(mode);
    return fs.openSync(filePath, flags, mode);
  };
  const store = runtime.createStore({
    fsModule: recordingFs,
    failureInjector(step) {
      observedSeams.push(step);
    },
  });

  store.publish(publicationInput(runtime, runtime.artifacts[0]));

  assert.ok(observedDirectoryModes.length >= 1);
  assert.equal(
    observedDirectoryModes.every(
      (mode) =>
        mode ===
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_DIRECTORY_MODE
    ),
    true
  );
  assert.ok(observedFileModes.length >= 2);
  assert.equal(
    observedFileModes.every(
      (mode) =>
        mode === SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE
    ),
    true
  );
  assert.deepEqual(
    observedSeams,
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FAILURE_SEAMS
  );
});

test("rejects corrupt, truncated, noncanonical, invalid-UTF8, oversized, and non-file artifacts", async (t) => {
  const cases = [
    ["corrupt", () => Buffer.from("{")],
    [
      "truncated",
      (artifact) =>
        Buffer.from(serializeCanonicalJsonV1(artifact).slice(0, -1)),
    ],
    [
      "noncanonical",
      (artifact) => Buffer.from(`${JSON.stringify(artifact)}\n`),
    ],
    ["invalid-utf8", () => Buffer.from([0xff, 0xfe, 0xfd])],
    [
      "oversized",
      () =>
        Buffer.alloc(
          SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_MAX_BYTES + 1,
          0x61
        ),
    ],
  ];
  for (const [name, bytes] of cases) {
    await t.test(name, () => {
      const runtime = fixture(t);
      fs.mkdirSync(runtime.artifactDirectory, {
        mode: SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_DIRECTORY_MODE,
      });
      const corrupt = bytes(runtime.artifacts[0]);
      fs.writeFileSync(runtime.artifactPath, corrupt, {
        mode: SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_FILE_MODE,
      });
      const store = runtime.createStore();

      assertArtifactError(
        () => store.readAndVerify(readInput(runtime)),
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
      assertArtifactError(
        () =>
          store.publish(
            publicationInput(runtime, runtime.artifacts[1])
          ),
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .verificationFailed
      );
      assert.deepEqual(fs.readFileSync(runtime.artifactPath), corrupt);
    });
  }

  await t.test("directory-target", () => {
    const runtime = fixture(t);
    fs.mkdirSync(runtime.artifactDirectory, {
      mode: SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_DIRECTORY_MODE,
    });
    fs.mkdirSync(runtime.artifactPath);
    const store = runtime.createStore();
    assertArtifactError(
      () => store.readAndVerify(readInput(runtime)),
      SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
        .pathUnsafe
    );
  });
});

test("rejects a partial descriptor read as truncation", (t) => {
  const runtime = fixture(t);
  const normalStore = runtime.createStore();
  normalStore.publish(
    publicationInput(runtime, runtime.artifacts[0])
  );
  const shortReadFs = Object.create(fs);
  let reads = 0;
  shortReadFs.readSync = (...args) => {
    reads += 1;
    if (reads === 1) return 0;
    return fs.readSync(...args);
  };
  const store = runtime.createStore({ fsModule: shortReadFs });

  assertArtifactError(
    () => store.readAndVerify(readInput(runtime)),
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .verificationFailed
  );
});

test("one-shot write, rename, and directory-fsync failures preserve the prior artifact", async (t) => {
  for (const failureKind of ["write", "rename", "directory-fsync"]) {
    await t.test(failureKind, () => {
      const runtime = fixture(t);
      const baseStore = runtime.createStore();
      baseStore.publish(
        publicationInput(runtime, runtime.artifacts[0])
      );
      const prior = fs.readFileSync(runtime.artifactPath);
      const failingFs = Object.create(fs);
      let failed = false;
      const descriptorPaths = new Map();
      failingFs.openSync = (...args) => {
        const descriptor = fs.openSync(...args);
        descriptorPaths.set(descriptor, args[0]);
        return descriptor;
      };
      failingFs.closeSync = (descriptor) => {
        descriptorPaths.delete(descriptor);
        return fs.closeSync(descriptor);
      };
      failingFs.writeFileSync = (target, ...args) => {
        if (
          failureKind === "write" &&
          !failed &&
          typeof target === "number" &&
          String(descriptorPaths.get(target)).includes(".temp-")
        ) {
          failed = true;
          const error = new Error("private write failure");
          error.code = "EIO";
          throw error;
        }
        return fs.writeFileSync(target, ...args);
      };
      failingFs.renameSync = (source, target) => {
        if (
          failureKind === "rename" &&
          !failed &&
          source.includes(".temp-") &&
          target === runtime.artifactPath
        ) {
          failed = true;
          const error = new Error("private rename failure");
          error.code = "EIO";
          throw error;
        }
        return fs.renameSync(source, target);
      };
      failingFs.fsyncSync = (descriptor) => {
        if (
          failureKind === "directory-fsync" &&
          !failed &&
          descriptorPaths.get(descriptor) ===
            runtime.artifactDirectory
        ) {
          failed = true;
          const error = new Error("private directory fsync failure");
          error.code = "EIO";
          throw error;
        }
        return fs.fsyncSync(descriptor);
      };
      const store = runtime.createStore({ fsModule: failingFs });

      assertArtifactError(
        () =>
          store.publish(
            publicationInput(runtime, runtime.artifacts[1])
          ),
        SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
          .publicationFailed
      );
      assert.equal(failed, true);
      assert.deepEqual(fs.readFileSync(runtime.artifactPath), prior);
      assert.equal(
        baseStore.readAndVerify(readInput(runtime)).artifact
          .evidenceSha256,
        runtime.artifacts[0].evidenceSha256
      );
      assert.deepEqual(artifactLeftovers(runtime), []);
    });
  }
});

test("invalid candidate or cross-binding evidence writes no file", (t) => {
  const runtime = fixture(t);
  const store = runtime.createStore();
  const tampered = structuredClone(runtime.artifacts[0]);
  tampered.evidenceHmacSha256 = "0".repeat(64);
  assertArtifactError(
    () =>
      store.publish(publicationInput(runtime, tampered)),
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .verificationFailed
  );
  assert.equal(fs.existsSync(runtime.artifactPath), false);

  assertArtifactError(
    () =>
      store.publish({
        artifact: runtime.artifacts[0],
        expectedBindings: {
          ...runtime.bindings,
          environmentId: "different-environment",
        },
        nowMs: NOW_MS,
      }),
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .verificationFailed
  );
  assert.equal(fs.existsSync(runtime.artifactPath), false);
});

test("missing and open request shapes fail closed", (t) => {
  const runtime = fixture(t);
  const store = runtime.createStore();
  assertArtifactError(
    () => store.readAndVerify(readInput(runtime)),
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES.notFound
  );
  assertArtifactError(
    () =>
      store.readAndVerify({
        ...readInput(runtime),
        extra: true,
      }),
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .argumentInvalid
  );
  assertArtifactError(
    () =>
      store.publish({
        ...publicationInput(runtime, runtime.artifacts[0]),
        extra: true,
      }),
    SPORTS_DATA_IO_LIVE_CAPABILITY_ARTIFACT_ERROR_CODES
      .argumentInvalid
  );
});

test("configuration and failures never disclose credentials, payloads, or filesystem details", (t) => {
  const runtime = fixture(t);
  const store = runtime.createStore({
    failureInjector() {
      throw new Error(
        `${CAPABILITY_SECRET}:${DEDICATED_LIVE_API_KEY}:raw-provider-payload`
      );
    },
  });
  let rendered = "";
  try {
    store.publish(
      publicationInput(runtime, runtime.artifacts[0])
    );
  } catch (error) {
    rendered = JSON.stringify({
      name: error.name,
      code: error.code,
      message: error.message,
    });
  }

  for (const forbidden of [
    CAPABILITY_SECRET,
    DEDICATED_LIVE_API_KEY,
    "raw-provider-payload",
    runtime.persistentRoot,
  ]) {
    assert.equal(rendered.includes(forbidden), false);
  }
});
