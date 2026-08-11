const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, test } = require("node:test");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const SOURCE_DIRECTORY = path.join(ROOT_DIRECTORY, "src");
const SQLITE_DIRECTORY = path.join(
  SOURCE_DIRECTORY,
  "infrastructure",
  "persistence",
  "sqlite"
);

function read(relativePath) {
  return fs.readFileSync(
    path.join(ROOT_DIRECTORY, relativePath),
    "utf8"
  );
}

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolutePath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? listJavaScriptFiles(absolutePath)
        : entry.isFile() && entry.name.endsWith(".js")
          ? [absolutePath]
          : [];
    });
}

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

describe("FAD-02 league reliability composition", () => {
  test("keeps notification inserts behind one shared target-runtime writer", () => {
    const writerPath = path.join(
      SQLITE_DIRECTORY,
      "SqliteNotificationWriter.js"
    );
    const directInsertPaths = listJavaScriptFiles(SOURCE_DIRECTORY)
      .filter((filePath) =>
        /INSERT\s+INTO\s+notifications/i.test(
          fs.readFileSync(filePath, "utf8")
        )
      );
    assert.deepEqual(directInsertPaths, [writerPath]);

    const producerNames = [
      "SqliteCandidateAllocationRepository.js",
      "SqliteCommissionerAssignmentRepository.js",
      "SqliteFreeAgentDraftRepository.js",
      "SqliteLeagueInvitationRepository.js",
      "SqliteTeamManagerAssignmentRepository.js",
      "SqliteTradeProposalRepository.js",
    ];
    for (const producerName of producerNames) {
      const source = fs.readFileSync(
        path.join(SQLITE_DIRECTORY, producerName),
        "utf8"
      );
      assert.match(source, /resolveSqliteNotificationWriter/);
      assert.doesNotMatch(
        source,
        /getRepositoryDefinition\(\s*["']notifications["']\s*\)/
      );
    }

    const runtimeSource = read(
      "src/bootstrap/createTargetRuntime.js"
    );
    assert.equal(
      countMatches(
        runtimeSource,
        /const notificationWriter = createSqliteNotificationWriter\(\{/g
      ),
      1
    );
    for (const repositoryName of [
      "commissionerAssignments",
      "leagueInvitations",
      "teamManagerAssignments",
      "tradeProposals",
    ]) {
      assert.match(
        runtimeSource,
        new RegExp(
          `${repositoryName}: createSqlite[\\s\\S]{0,180}` +
          "notificationWriter,"
        )
      );
    }
  });

  test("keeps league outbox inserts behind one shared target-runtime writer", () => {
    const allowedPaths = [
      path.join(
        SQLITE_DIRECTORY,
        "SqliteLeagueOutboxWriter.js"
      ),
      path.join(
        SQLITE_DIRECTORY,
        "SqliteOutboxEventRepository.js"
      ),
    ].sort();
    const directInsertPaths = listJavaScriptFiles(SOURCE_DIRECTORY)
      .filter((filePath) =>
        /getRepositoryDefinition\(\s*["']outbox_events["']\s*\)/.test(
          fs.readFileSync(filePath, "utf8")
        )
      )
      .sort();
    assert.deepEqual(directInsertPaths, allowedPaths);

    const runtimeSource = read(
      "src/bootstrap/createTargetRuntime.js"
    );
    assert.equal(
      countMatches(
        runtimeSource,
        /const leagueOutboxWriter = createSqliteLeagueOutboxWriter\(\{/g
      ),
      1
    );
    for (const repositoryName of [
      "auctionResolutions",
      "tradeProposals",
      "tradeExpiries",
      "tradeRecovery",
    ]) {
      assert.match(
        runtimeSource,
        new RegExp(
          `${repositoryName}: createSqlite[\\s\\S]{0,180}` +
          "leagueOutboxWriter,"
        )
      );
    }
  });

  test("keeps the release-QA fixture on the same atomic writer paths", () => {
    const source = read(
      "src/operations/release/createReleaseQaFixture.js"
    );
    assert.doesNotMatch(
      source,
      /INSERT\s+INTO\s+(?:notifications|outbox_events)/i
    );
    assert.doesNotMatch(
      source,
      /getRepositoryDefinition\(\s*["'](?:notifications|outbox_events)["']\s*\)/
    );
    assert.equal(
      countMatches(
        source,
        /createSqliteNotificationWriter\(\{ database \}\)/g
      ),
      1
    );
    assert.equal(
      countMatches(
        source,
        /createSqliteLeagueOutboxWriter\(\{ database \}\)/g
      ),
      1
    );
  });
});
