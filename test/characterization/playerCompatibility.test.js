const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  createApplication,
} = require("../../src/bootstrap/createApplication");
const {
  createHttpServer,
} = require("../../src/bootstrap/createHttpServer");
const {
  createShutdown,
} = require("../../src/bootstrap/shutdown");
const { loadConfig } = require("../../src/config/loadConfig");
const {
  createPlayerService,
} = require("../../src/application/services/players/createPlayerService");
const {
  normalizePlayers,
} = require("../../src/application/services/players/normalizePlayer");
const {
  createJsonPlayerRepository,
} = require("../../src/infrastructure/persistence/json/JsonPlayerRepository");
const {
  createPlayersCompatibilityRouter,
} = require("../../src/transport/http/routes/playersCompatibilityRouter");
const { hashFile } = require("../helpers/hashTree");
const { httpRequest } = require("../helpers/httpRequest");

async function createPlayerRuntime(t, initialValue) {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "hundo-leago-br02-players-")
  );
  const playerFile = path.join(root, "players.json");
  const repositoryPlayerFile = path.join(root, "repo-players.json");

  t.after(async () => {
    await fs.promises.rm(root, {
      recursive: true,
      force: true,
    });
  });

  if (initialValue !== undefined) {
    await fs.promises.writeFile(
      playerFile,
      typeof initialValue === "string"
        ? initialValue
        : `${JSON.stringify(initialValue, null, 2)}\n`,
      "utf8"
    );
  }

  await fs.promises.writeFile(
    repositoryPlayerFile,
    "[]\n",
    "utf8"
  );

  const repository = createJsonPlayerRepository({
    playerFile,
    repositoryPlayerFile,
  });
  const errors = [];
  const service = createPlayerService({
    repository,
    logger: {
      error(...args) {
        errors.push(args);
      },
    },
  });

  return {
    errors,
    playerFile,
    repository,
    repositoryPlayerFile,
    root,
    service,
  };
}

async function startPlayerServer(t, playerService) {
  const config = loadConfig({
    env: { NODE_ENV: "test" },
    existsSync: () => false,
  });
  const app = createApplication(config);
  app.use(
    createPlayersCompatibilityRouter({
      playerService,
    })
  );
  const runtime = createHttpServer({
    app,
    isAllowedOrigin: config.isAllowedOrigin,
  });
  const shutdown = createShutdown({
    server: runtime.server,
    io: runtime.io,
  });

  t.after(async () => {
    await shutdown.shutdown();
  });

  const address = await runtime.listen({
    port: 0,
    host: "127.0.0.1",
  });

  return `http://127.0.0.1:${address.port}`;
}

describe("player normalization and in-memory service", () => {
  test("preserves current alternate keys, active defaults, and ID filtering", () => {
    const players = normalizePlayers([
      {
        player_id: "101",
        playerName: " Alternate Name ",
        first: " Alternate ",
        last: " Player ",
        pos: "C",
        teamAbbreviation: "TST",
        dateOfBirth: "2000-01-01",
      },
      {
        playerId: 102,
        full_name: "Inactive Player",
        active: false,
      },
      { id: 0, name: "Zero" },
      { id: -1, name: "Negative" },
      { id: "not-a-number", name: "Invalid" },
      null,
    ]);

    assert.deepEqual(players, [
      {
        id: 101,
        fullName: "Alternate Name",
        firstName: "Alternate",
        lastName: "Player",
        position: "C",
        teamAbbrev: "TST",
        active: true,
        birthDate: "2000-01-01",
      },
      {
        id: 102,
        fullName: "Inactive Player",
        firstName: "",
        lastName: "",
        position: null,
        teamAbbrev: null,
        active: false,
        birthDate: null,
      },
    ]);
  });

  test("loads wrapped data, preserves order, and searches active players by all tokens", async (t) => {
    const runtime = await createPlayerRuntime(t, {
      players: [
        {
          id: 201,
          fullName: "Alpha Forward",
          firstName: "Alpha",
          lastName: "Forward",
          active: true,
        },
        {
          id: 202,
          fullName: "Beta Defender",
          firstName: "Beta",
          lastName: "Defender",
          active: false,
        },
        {
          id: 203,
          fullName: "Forward Alpha Two",
          firstName: "Forward",
          lastName: "Alpha Two",
          active: true,
        },
      ],
    });

    const result = runtime.service.reload();

    assert.equal(result.ok, true);
    assert.equal(result.count, 3);
    assert.deepEqual(
      runtime.service.list().map((player) => player.id),
      [201, 202, 203]
    );
    assert.deepEqual(
      runtime.service
        .search("  ALPHA   FORWARD  ", 25)
        .map((player) => player.id),
      [201, 203]
    );
    assert.deepEqual(runtime.service.search("beta", 25), []);
    assert.deepEqual(
      runtime.service.search("alpha", 1).map((player) => player.id),
      [201]
    );
  });

  test("uses the last duplicate ID in the current Map while preserving list entries", async (t) => {
    const runtime = await createPlayerRuntime(t, [
      { id: 301, fullName: "First Duplicate" },
      { id: 301, fullName: "Second Duplicate" },
    ]);

    runtime.service.reload();

    assert.equal(runtime.service.list().length, 2);
    assert.equal(
      runtime.service.getById(301).fullName,
      "Second Duplicate"
    );
  });

  test("reload replaces visible process cache without writing the source", async (t) => {
    const runtime = await createPlayerRuntime(t, [
      { id: 401, fullName: "Before Reload" },
    ]);
    runtime.service.reload();
    assert.equal(
      runtime.service.getById(401).fullName,
      "Before Reload"
    );

    await fs.promises.writeFile(
      runtime.playerFile,
      '[{"id":402,"fullName":"After Reload"}]\n',
      "utf8"
    );
    const beforeReloadHash = await hashFile(runtime.playerFile);
    const result = runtime.service.reload();
    const afterReloadHash = await hashFile(runtime.playerFile);

    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    assert.equal(runtime.service.getById(401), null);
    assert.equal(
      runtime.service.getById(402).fullName,
      "After Reload"
    );
    assert.equal(afterReloadHash, beforeReloadHash);
  });

  test("missing files clear cache without creating a source", async (t) => {
    const runtime = await createPlayerRuntime(t, undefined);
    const result = runtime.service.reload();

    assert.deepEqual(result, {
      ok: true,
      count: 0,
      source: "missing-file",
    });
    assert.equal(runtime.service.getCacheCount(), 0);
    assert.equal(fs.existsSync(runtime.playerFile), false);
  });

  test("malformed JSON reports failure and clears the current cache", async (t) => {
    const runtime = await createPlayerRuntime(t, [
      { id: 501, fullName: "Initially Valid" },
    ]);
    runtime.service.reload();
    await fs.promises.writeFile(
      runtime.playerFile,
      "{ malformed",
      "utf8"
    );
    const beforeReloadHash = await hashFile(runtime.playerFile);
    const result = runtime.service.reload();
    const afterReloadHash = await hashFile(runtime.playerFile);

    assert.equal(result.ok, false);
    assert.equal(result.count, 0);
    assert.match(result.error, /JSON|position|property/i);
    assert.equal(runtime.service.getCacheCount(), 0);
    assert.equal(runtime.service.getById(501), null);
    assert.equal(runtime.errors.length, 1);
    assert.equal(afterReloadHash, beforeReloadHash);
  });

  test("returns current debug file stats without changing either file", async (t) => {
    const runtime = await createPlayerRuntime(t, []);
    const playerBefore = await hashFile(runtime.playerFile);
    const repoBefore = await hashFile(runtime.repositoryPlayerFile);
    const debug = runtime.service.getDebugInfo();

    assert.equal(debug.playerFile, runtime.playerFile);
    assert.equal(debug.disk.exists, true);
    assert.equal(debug.repo.exists, true);
    assert.equal(debug.cacheCount, 0);
    assert.equal(await hashFile(runtime.playerFile), playerBefore);
    assert.equal(
      await hashFile(runtime.repositoryPlayerFile),
      repoBefore
    );
  });
});

describe("player compatibility HTTP routes", () => {
  test("preserves list, search, detail, debug, and read-only behavior", async (t) => {
    const runtime = await createPlayerRuntime(t, [
      {
        id: 1001,
        fullName: "Test Forward",
        firstName: "Test",
        lastName: "Forward",
        active: true,
      },
      {
        id: 1002,
        fullName: "Test Defender",
        firstName: "Test",
        lastName: "Defender",
        active: true,
      },
      {
        id: 1003,
        fullName: "Inactive Test",
        firstName: "Inactive",
        lastName: "Test",
        active: false,
      },
    ]);
    runtime.service.reload();
    const baseUrl = await startPlayerServer(t, runtime.service);
    const beforeHash = await hashFile(runtime.playerFile);

    const all = await httpRequest(baseUrl, "/api/players");
    assert.equal(all.status, 200);
    assert.equal(all.json.ok, true);
    assert.equal(all.json.count, 3);
    assert.equal(all.json.cacheCount, 3);
    assert.equal(all.json.limitUsed, 5000);
    assert.deepEqual(
      all.json.players.map((player) => player.id),
      [1001, 1002, 1003]
    );

    const bounded = await httpRequest(
      baseUrl,
      "/api/players?limit=0"
    );
    assert.equal(bounded.json.limitUsed, 1);
    assert.deepEqual(
      bounded.json.players.map((player) => player.id),
      [1001]
    );

    const search = await httpRequest(
      baseUrl,
      "/api/players?query=test%20forward&limit=999"
    );
    assert.equal(search.status, 200);
    assert.equal(search.json.limitUsed, 100);
    assert.deepEqual(
      search.json.players.map((player) => player.id),
      [1001]
    );

    const queryZero = await httpRequest(
      baseUrl,
      "/api/players?query=test&limit=0"
    );
    assert.equal(queryZero.json.limitUsed, 25);
    assert.deepEqual(
      queryZero.json.players.map((player) => player.id),
      [1001, 1002]
    );

    const detail = await httpRequest(
      baseUrl,
      "/api/players/1001"
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.json.ok, true);
    assert.equal(detail.json.player.fullName, "Test Forward");

    const missing = await httpRequest(
      baseUrl,
      "/api/players/9999"
    );
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json, {
      ok: false,
      error: "Player not found",
    });

    const invalid = await httpRequest(
      baseUrl,
      "/api/players/not-a-number"
    );
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.json, {
      ok: false,
      error: "Invalid player id",
    });

    const debug = await httpRequest(
      baseUrl,
      "/api/players/debug"
    );
    assert.equal(debug.status, 200);
    assert.equal(debug.json.ok, true);
    assert.equal(debug.json.PLAYERS_FILE, runtime.playerFile);
    assert.equal(debug.json.disk.exists, true);
    assert.equal(debug.json.repo.exists, true);
    assert.equal(debug.json.cacheCount, 3);

    assert.equal(await hashFile(runtime.playerFile), beforeHash);
  });

  test("reload replaces route-visible cache without writing the player file", async (t) => {
    const runtime = await createPlayerRuntime(t, [
      { id: 2001, fullName: "Before HTTP Reload" },
    ]);
    runtime.service.reload();
    const baseUrl = await startPlayerServer(t, runtime.service);

    await fs.promises.writeFile(
      runtime.playerFile,
      '[{"id":2002,"fullName":"After HTTP Reload"}]\n',
      "utf8"
    );
    const beforeHash = await hashFile(runtime.playerFile);
    const reload = await httpRequest(
      baseUrl,
      "/api/players/reload",
      { method: "POST" }
    );
    const afterHash = await hashFile(runtime.playerFile);

    assert.equal(reload.status, 200);
    assert.deepEqual(reload.json, {
      ok: true,
      count: 1,
      source: runtime.playerFile,
      error: null,
    });
    assert.equal(afterHash, beforeHash);

    const oldDetail = await httpRequest(
      baseUrl,
      "/api/players/2001"
    );
    const newDetail = await httpRequest(
      baseUrl,
      "/api/players/2002"
    );

    assert.equal(oldDetail.status, 404);
    assert.equal(newDetail.status, 200);
    assert.equal(
      newDetail.json.player.fullName,
      "After HTTP Reload"
    );
  });
});
