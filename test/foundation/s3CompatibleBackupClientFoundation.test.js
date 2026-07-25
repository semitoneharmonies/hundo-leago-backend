const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createS3CompatibleClient,
} = require("../../src/infrastructure/backups/createS3CompatibleClient");
const {
  parseDeployedArguments,
} = require("../../scripts/db-backup");

test("signs private path-style PUT, HEAD, and GET without exposing the secret", async () => {
  const requests = [];
  const payload = Buffer.from("encrypted");
  const digest = require("node:crypto").createHash("sha256").update(payload).digest("hex");
  const client = createS3CompatibleClient({
    endpoint: "https://objects.example.test",
    region: "ca-west-1",
    bucket: "hundo-staging",
    accessKeyId: "access-id",
    secretAccessKey: "do-not-print-secret",
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    async fetchImplementation(url, options) {
      requests.push({ url, options });
      if (options.method === "HEAD") {
        return {
          ok: true,
          headers: new Headers({
            "content-length": String(payload.length),
            "x-amz-meta-sha256": digest,
          }),
        };
      }
      if (options.method === "GET") {
        return { ok: true, arrayBuffer: async () => payload };
      }
      return { ok: true };
    },
  });
  await client.putObject({
    key: "staging/database/a b.enc",
    body: payload,
    contentType: "application/octet-stream",
    metadata: { sha256: digest },
    visibility: "private",
  });
  assert.deepEqual(
    await client.headObject({ key: "staging/database/a b.enc" }),
    { byteSize: payload.length, sha256: digest }
  );
  assert.deepEqual(
    (await client.getObject({ key: "staging/database/a b.enc" })).body,
    payload
  );
  assert.equal(requests[0].url.endsWith("/hundo-staging/staging/database/a%20b.enc"), true);
  assert.match(requests[0].options.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.equal(JSON.stringify(requests).includes("do-not-print-secret"), false);
  assert.equal(requests[0].options.headers["x-amz-acl"], undefined);
});

test("deployed backup arguments are explicit and have no force bypass", () => {
  assert.deepEqual(
    parseDeployedArguments([
      "--reason", "pre-deploy",
      "--requested-by-type", "platform_administrator",
      "--requested-by-id", "operator-id",
      "--retention-class", "pre-change",
      "--expires-at", "2026-10-20T12:00:00.000Z",
    ]),
    {
      reason: "pre-deploy",
      requestedByType: "platform_administrator",
      requestedById: "operator-id",
      retentionClass: "pre-change",
      expiresAt: "2026-10-20T12:00:00.000Z",
    }
  );
  assert.deepEqual(parseDeployedArguments(["--reason", "pre-deploy"]), {
    reason: "pre-deploy",
    requestedByType: "platform_operation",
    requestedById: "deployment-cli",
    retentionClass: "pre-change",
    expiresAt: null,
  });
  assert.throws(
    () => parseDeployedArguments(["--reason", "pre-deploy", "--force", "true"]),
    { code: "BACKUP_ARGUMENT_INVALID" }
  );
});
