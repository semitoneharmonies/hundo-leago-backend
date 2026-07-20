const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test } = require("node:test");

const {
  readEndpointManifest,
} = require("../helpers/readEndpointManifest");

const BACKEND_ROOT = path.resolve(
  __dirname,
  "..",
  ".."
);

function listJavaScriptFiles(directoryPath) {
  const files = [];
  for (const entry of fs.readdirSync(
    directoryPath,
    { withFileTypes: true }
  )) {
    const fullPath = path.join(
      directoryPath,
      entry.name
    );
    if (entry.isDirectory()) {
      files.push(
        ...listJavaScriptFiles(fullPath)
      );
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".js")
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function relative(filePath) {
  return path
    .relative(BACKEND_ROOT, filePath)
    .replaceAll("\\", "/");
}

function readSource(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function assertSourcesDoNotMatch({
  files,
  pattern,
  boundary,
}) {
  for (const filePath of files) {
    assert.doesNotMatch(
      readSource(filePath),
      pattern,
      `${relative(filePath)} crossed the ${boundary} boundary`
    );
  }
}

describe("backend refactor completion architecture", () => {
  test("keeps domain, service, route, and job dependencies directional", () => {
    const domainFiles = listJavaScriptFiles(
      path.join(BACKEND_ROOT, "src", "domain")
    );
    const serviceFiles = listJavaScriptFiles(
      path.join(
        BACKEND_ROOT,
        "src",
        "application",
        "services"
      )
    );
    const routeFiles = listJavaScriptFiles(
      path.join(
        BACKEND_ROOT,
        "src",
        "transport",
        "http",
        "routes"
      )
    );
    const jobFiles = listJavaScriptFiles(
      path.join(BACKEND_ROOT, "src", "jobs")
    );

    assertSourcesDoNotMatch({
      files: domainFiles,
      pattern:
        /\brequire\s*\(|process\.env|node:fs|socket\.io|express|infrastructure|transport/,
      boundary: "pure domain",
    });
    assertSourcesDoNotMatch({
      files: serviceFiles,
      pattern:
        /require\(["']express["']\)|infrastructure\/persistence|Json[A-Za-z]+Repository/,
      boundary: "application service",
    });
    assertSourcesDoNotMatch({
      files: routeFiles,
      pattern:
        /infrastructure\/persistence|Json[A-Za-z]+Repository/,
      boundary: "HTTP route",
    });
    assertSourcesDoNotMatch({
      files: jobFiles,
      pattern: /transport\/http\/routes|require\(["']express["']\)/,
      boundary: "scheduled job",
    });
  });

  test("keeps every compatibility endpoint in an explicit route module", () => {
    const manifest = readEndpointManifest(
      BACKEND_ROOT
    );

    assert.equal(manifest.length, 34);
    assert.equal(
      new Set(manifest.map((route) => route.key))
        .size,
      34
    );
    assert.equal(
      manifest.every(
        (route) =>
          route.sourceFile.includes("routes/") &&
          route.sourceFile !== "server.js" &&
          !route.sourceFile.includes(
            "createCompatibilityRuntime"
          )
      ),
      true
    );
  });

  test("keeps concrete persistence selection at composition and compatibility adapters", () => {
    const sourceFiles = [
      path.join(BACKEND_ROOT, "leagueStore.js"),
      path.join(
        BACKEND_ROOT,
        "scripts",
        "refreshStats.js"
      ),
      ...listJavaScriptFiles(
        path.join(BACKEND_ROOT, "src")
      ),
    ];
    const persistenceAdapterUsers = sourceFiles
      .filter(
        (filePath) =>
          !relative(filePath).startsWith(
            "src/infrastructure/persistence/json/"
          )
      )
      .filter((filePath) =>
        /(?:infrastructure\/persistence\/json\/Json|JsonLeagueRepository)/.test(
          readSource(filePath)
        )
      )
      .map(relative)
      .sort();

    assert.deepEqual(persistenceAdapterUsers, [
      "leagueStore.js",
      "scripts/refreshStats.js",
      "src/bootstrap/createCompatibilityRuntime.js",
      "src/bootstrap/createDependencies.js",
    ]);

    const rootStore = readSource(
      path.join(BACKEND_ROOT, "leagueStore.js")
    );
    assert.match(
      rootStore,
      /createJsonLeagueRepository/
    );
    assert.doesNotMatch(
      rootStore,
      /node:fs|require\(["']fs["']\)|writeFile|rename|normalizeLeagueState/
    );
  });

  test("retains all replaceable JSON repository boundaries", () => {
    const repositoryRoot = path.join(
      BACKEND_ROOT,
      "src",
      "infrastructure",
      "persistence",
      "json"
    );
    const repositoryFiles = fs
      .readdirSync(repositoryRoot)
      .filter((fileName) =>
        fileName.endsWith("Repository.js")
      )
      .sort();

    assert.deepEqual(repositoryFiles, [
      "JsonBackupRepository.js",
      "JsonLeagueRepository.js",
      "JsonPlayerRepository.js",
      "JsonSnapshotRepository.js",
      "JsonStatisticsRepository.js",
    ]);

    const dependenciesSource = readSource(
      path.join(
        BACKEND_ROOT,
        "src",
        "bootstrap",
        "createDependencies.js"
      )
    );
    assert.match(
      dependenciesSource,
      /createJsonLeagueRepositoryFactory/
    );
    assert.match(
      dependenciesSource,
      /leagueRepository/
    );
    assert.match(
      dependenciesSource,
      /leagueStore: leagueRepository/
    );

    const runtimeSource = readSource(
      path.join(
        BACKEND_ROOT,
        "src",
        "bootstrap",
        "createCompatibilityRuntime.js"
      )
    );
    assert.match(
      runtimeSource,
      /createDependencies\(\{/
    );
    assert.match(
      runtimeSource,
      /createJsonPlayerRepository/
    );
    assert.match(
      runtimeSource,
      /createJsonStatisticsRepository/
    );
    assert.match(
      runtimeSource,
      /createJsonSnapshotRepository/
    );
  });
});
