const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, test } = require("node:test");
const zlib = require("node:zlib");
const express = require("express");

const {
  MAXIMUM_LOGO_BYTES,
  TeamProfilePolicyError,
  inspectTeamLogo,
  validateTeamProfileInput,
} = require("../../src/domain/leagues/teamProfilePolicy");
const {
  createTeamProfileService,
} = require(
  "../../src/application/services/leagues/createTeamProfileService"
);
const {
  createLeagueAuthorizationService,
} = require(
  "../../src/application/services/authorization/requireLeagueAuthority"
);
const {
  createTeamAuthorizationService,
} = require(
  "../../src/application/services/authorization/requireTeamManagerAuthority"
);
const {
  openDatabase,
} = require("../../src/infrastructure/database/connection");
const {
  migrateDatabase,
} = require("../../src/infrastructure/database/migrate");
const {
  createSqliteRepositoryContext,
} = require(
  "../../src/infrastructure/persistence/sqlite/createSqliteRepositoryContext"
);
const {
  createSqliteTeamProfileRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteTeamProfileRepository"
);
const {
  createSqliteLeagueAccessRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteLeagueAccessRepository"
);
const {
  createSqliteSecurityAuditRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteSecurityAuditRepository"
);
const {
  createSqliteTeamAuthorityRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteTeamAuthorityRepository"
);
const {
  createSqliteTeamReadRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteTeamReadRepository"
);
const {
  createSqliteUserRepository,
} = require(
  "../../src/infrastructure/persistence/sqlite/SqliteUserRepository"
);
const {
  createTargetRequestSecurity,
} = require("../../src/transport/http/createTargetRequestSecurity");
const {
  createSessionCookie,
} = require("../../src/transport/http/sessionCookie");
const {
  createTeamProfileRouter,
} = require("../../src/transport/http/createTeamProfileRouter");

const ROOT_DIRECTORY = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIRECTORY = path.join(
  ROOT_DIRECTORY,
  "database",
  "migrations"
);
const NOW_MS = Date.parse("2026-07-22T09:00:00.000Z");
const COMMISSIONER_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const OUTSIDER_ID = "00000000-0000-4000-8000-000000000003";
const LEAGUE_ID = "00000000-0000-4000-8000-000000000010";
const OTHER_LEAGUE_ID = "00000000-0000-4000-8000-000000000011";
const TEAM_ID = "00000000-0000-4000-8000-000000000020";
const OTHER_TEAM_ID = "00000000-0000-4000-8000-000000000021";
const PUBLIC_FRONTEND_ORIGIN = "https://staging.hundo.example";
const SESSION_TOKENS = Object.freeze({
  [COMMISSIONER_ID]: Buffer.alloc(32, 0x61).toString("base64url"),
  [USER_ID]: Buffer.alloc(32, 0x62).toString("base64url"),
  [OUTSIDER_ID]: Buffer.alloc(32, 0x63).toString("base64url"),
});
const CSRF_TOKENS = Object.freeze({
  [COMMISSIONER_ID]: Buffer.alloc(32, 0x64).toString("base64url"),
  [USER_ID]: Buffer.alloc(32, 0x65).toString("base64url"),
  [OUTSIDER_ID]: Buffer.alloc(32, 0x66).toString("base64url"),
});

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function authenticated(userId) {
  return {
    valid: true,
    session: { id: uuid(900 + Number(userId.slice(-1))), userId },
    user: { id: userId, status: "active", version: 1 },
  };
}

function createRepositoryRuntime(t) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "hundo-m3-18-profile-")
  );
  const connection = openDatabase({
    databasePath: path.join(temporaryRoot, "league.sqlite3"),
    environment: "test",
  });
  migrateDatabase({
    database: connection.database,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    applicationBuildId: "m3-18-profile-test",
    now: () => NOW_MS,
  });
  t.after(() => {
    if (connection.database.open) connection.database.close();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });
  const context = createSqliteRepositoryContext({
    database: connection.database,
  });
  for (const [id, email, displayName] of [
    [COMMISSIONER_ID, "commissioner@example.test", "Commissioner"],
    [USER_ID, "manager@example.test", "Team Manager"],
    [OUTSIDER_ID, "outsider@example.test", "Outsider"],
  ]) {
    context.repositories.users.insert({
      id,
      email_normalized: email,
      email_display: email,
      display_name: displayName,
      display_name_normalized: displayName.toLowerCase(),
      status: "active",
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
    context.repositories.sessions.insert({
      id: uuid(900 + Number(id.slice(-1))),
      user_id: id,
      token_digest: id.slice(-1).repeat(64),
      csrf_secret_digest: id.slice(-1).repeat(64),
      status: "active",
      created_at_ms: NOW_MS,
      last_used_at_ms: NOW_MS,
      idle_expires_at_ms: NOW_MS + 60_000,
      absolute_expires_at_ms: NOW_MS + 120_000,
      revoked_at_ms: null,
      revocation_reason: null,
      client_metadata_json: null,
      version: 1,
    });
  }
  for (const [id, name] of [
    [LEAGUE_ID, "Profile League"],
    [OTHER_LEAGUE_ID, "Other League"],
  ]) {
    context.repositories.leagues.insert({
      id,
      name,
      name_normalized: name.toLowerCase(),
      status: "active",
      timezone: "America/Vancouver",
      commissioner_membership_id: null,
      current_season_id: null,
      created_at_ms: NOW_MS,
      updated_at_ms: NOW_MS,
      version: 1,
    });
  }
  context.repositories.teams.insert({
    id: TEAM_ID,
    league_id: LEAGUE_ID,
    name: "Alpha Team",
    name_normalized: "alpha team",
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.teams.insert({
    id: OTHER_TEAM_ID,
    league_id: LEAGUE_ID,
    name: "Beta Team",
    name_normalized: "beta team",
    status: "active",
    primary_colour: null,
    secondary_colour: null,
    logo_reference: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  const commissionerMembership = context.repositories.league_memberships.insert({
    id: uuid(50),
    league_id: LEAGUE_ID,
    user_id: COMMISSIONER_ID,
    permission_category: "commissioner",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  const managerMembership = context.repositories.league_memberships.insert({
    id: uuid(51),
    league_id: LEAGUE_ID,
    user_id: USER_ID,
    permission_category: "manager",
    status: "active",
    joined_at_ms: NOW_MS,
    ended_at_ms: null,
    created_at_ms: NOW_MS,
    updated_at_ms: NOW_MS,
    version: 1,
  });
  context.repositories.leagues.updateVersioned({
    key: LEAGUE_ID,
    expectedVersion: 1,
    changes: {
      commissioner_membership_id: commissionerMembership.id,
      updated_at_ms: NOW_MS,
    },
  });
  context.repositories.team_manager_assignments.insert({
    id: uuid(52),
    league_id: LEAGUE_ID,
    team_id: TEAM_ID,
    user_id: USER_ID,
    membership_id: managerMembership.id,
    assigned_by_user_id: COMMISSIONER_ID,
    status: "accepted",
    assigned_at_ms: NOW_MS,
    accepted_at_ms: NOW_MS,
    ended_at_ms: null,
    version: 1,
  });
  const userRepository = createSqliteUserRepository({
    database: connection.database,
  });
  const leagueAuthorization = createLeagueAuthorizationService({
    userRepository,
    leagueAccessRepository: createSqliteLeagueAccessRepository({
      database: connection.database,
    }),
  });
  const teamProfileRepository = createSqliteTeamProfileRepository({
    database: connection.database,
  });
  const teamReadRepository = createSqliteTeamReadRepository({
    database: connection.database,
  });
  const teamAuthorization = createTeamAuthorizationService({
    leagueAuthorization,
    teamAuthorityRepository: createSqliteTeamAuthorityRepository({
      database: connection.database,
    }),
  });
  const auditRepository = createSqliteSecurityAuditRepository({
    database: connection.database,
  });
  const clock = { nowMs: () => NOW_MS + 10 };
  let nextId = 100;
  const secureRandom = { id: () => uuid(nextId++) };
  const profileDependencies = {
    repositoryContext: context,
    leagueAuthorization,
    teamAuthorization,
    teamProfileRepository,
    teamReadRepository,
    auditRepository,
    clock,
    secureRandom,
  };
  return {
    ...profileDependencies,
    context,
    database: connection.database,
    repository: teamProfileRepository,
    profileDependencies,
    profileService: createTeamProfileService(profileDependencies),
  };
}

function profileCommand(input, overrides = {}) {
  return {
    leagueId: LEAGUE_ID,
    teamId: TEAM_ID,
    input,
    expectedVersion: 1,
    idempotencyKey: "m3-18-profile-update",
    authenticated: authenticated(USER_ID),
    auditContext: {
      requestCorrelationId: uuid(800),
      networkKeyVersion: 1,
      networkMetadataDigest: "a".repeat(64),
      clientMetadataJson: JSON.stringify({
        networkSourceCategory: "local",
      }),
    },
    ...overrides,
  };
}

function httpHeaders(sessionCookie, userId, {
  csrfToken = CSRF_TOKENS[userId],
  idempotencyKey = "http-profile-update",
  includeCookie = true,
  origin = PUBLIC_FRONTEND_ORIGIN,
  version = 1,
} = {}) {
  return {
    Origin: origin,
    "Content-Type": "application/json",
    "If-Match": `"${version}"`,
    "Idempotency-Key": idempotencyKey,
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Dest": "empty",
    "X-CSRF-Token": csrfToken,
    ...(includeCookie
      ? { Cookie: `${sessionCookie.name}=${SESSION_TOKENS[userId]}` }
      : {}),
  };
}

async function startProfileApi(t, runtime) {
  const sessionCookie = createSessionCookie({
    appEnv: "staging",
    publicFrontendOrigin: PUBLIC_FRONTEND_ORIGIN,
    sameSite: "none",
  });
  const userByToken = new Map(
    Object.entries(SESSION_TOKENS).map(([userId, token]) => [token, userId])
  );
  const requestSecurity = createTargetRequestSecurity({
    isAllowedOrigin(origin) {
      return origin === PUBLIC_FRONTEND_ORIGIN;
    },
    requestIdFactory() {
      return "m3-18-request";
    },
    sessionCookie,
    sessionService: {
      bootstrap(rawSessionToken) {
        const userId = userByToken.get(rawSessionToken);
        return userId
          ? authenticated(userId)
          : { valid: false, code: "SESSION_INVALID" };
      },
      resolveWithCsrf({ rawSessionToken, rawCsrfToken }) {
        const userId = userByToken.get(rawSessionToken);
        if (!userId) return { valid: false, code: "SESSION_INVALID" };
        if (rawCsrfToken !== CSRF_TOKENS[userId]) {
          return { valid: false, code: "CSRF_INVALID" };
        }
        return authenticated(userId);
      },
    },
  });
  const app = express();
  app.use(
    createTeamProfileRouter({
      requestSecurity,
      teamProfileService: runtime.profileService,
      auditPrivacyDigest: {
        digest() {
          return { digest: "e".repeat(64), keyVersion: 1 };
        },
      },
      networkSourceResolver() {
        return "198.51.100.0/24";
      },
    })
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  );
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    sessionCookie,
  };
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        value & 1
          ? 0xedb88320 ^ (value >>> 1)
          : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, data])),
    8 + data.length
  );
  return output;
}

function png(width = 1, height = 1, extraChunks = []) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    ...extraChunks,
    pngChunk("IDAT", zlib.deflateSync(Buffer.from([0, 0, 0, 0, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpeg(width = 3, height = 2) {
  const sof = Buffer.from([
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >>> 8) & 0xff, height & 0xff,
    (width >>> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ]);
  const scan = Buffer.from([
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01,
    0x00, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, scan]);
}

function webpChunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, "ascii");
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([
    header,
    data,
    ...(data.length % 2 ? [Buffer.alloc(1)] : []),
  ]);
}

function webpLossless(width = 4, height = 5, extraChunks = []) {
  const packed = (width - 1) | ((height - 1) << 14);
  const image = Buffer.alloc(5);
  image[0] = 0x2f;
  image.writeUInt32LE(packed >>> 0, 1);
  const chunks = [...extraChunks, webpChunk("VP8L", image)];
  const payload = Buffer.concat([Buffer.from("WEBP", "ascii"), ...chunks]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, 4, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function expectPolicyError(callback, reasonCode) {
  assert.throws(callback, (error) => {
    assert(error instanceof TeamProfilePolicyError);
    assert.equal(error.reasonCode, reasonCode);
    return true;
  });
}

describe("M3-18 team-profile policy", () => {
  test("accepts exact canonical partial profile input and inspects PNG bytes", () => {
    const bytes = png(32, 24);
    const result = validateTeamProfileInput({
      name: "  Harbour Owls  ",
      primaryColour: "#102030",
      secondaryColour: "#abcdef",
      logo: {
        mediaType: "image/png",
        contentBase64: bytes.toString("base64"),
      },
    });
    assert.deepEqual(result.name, {
      name: "Harbour Owls",
      nameNormalized: "harbour owls",
    });
    assert.deepEqual(result.colours, {
      primaryColour: "#102030",
      secondaryColour: "#abcdef",
      tertiaryColour: null,
    });
    assert.equal(result.logo.byteLength, bytes.length);
    assert.equal(result.logo.width, 32);
    assert.equal(result.logo.height, 24);
    assert.equal(result.logo.bytes.equals(bytes), true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.logo, "contentSha256"),
      false
    );
  });

  test("inspects static JPEG and WebP dimensions from matching content", () => {
    const jpegResult = inspectTeamLogo({
      mediaType: "image/jpeg",
      contentBase64: jpeg(9, 7).toString("base64"),
    });
    assert.equal(jpegResult.width, 9);
    assert.equal(jpegResult.height, 7);
    const webpResult = inspectTeamLogo({
      mediaType: "image/webp",
      contentBase64: webpLossless(11, 13).toString("base64"),
    });
    assert.equal(webpResult.width, 11);
    assert.equal(webpResult.height, 13);
  });

  test("requires exact fields, paired canonical colours, and canonical base64", () => {
    expectPolicyError(
      () => validateTeamProfileInput({}),
      "team_profile_input_invalid"
    );
    expectPolicyError(
      () => validateTeamProfileInput({ unknown: true }),
      "team_profile_input_invalid"
    );
    expectPolicyError(
      () => validateTeamProfileInput({ primaryColour: "#abcdef" }),
      "team_colours_incomplete"
    );
    expectPolicyError(
      () =>
        validateTeamProfileInput({
          primaryColour: "#ABCDEF",
          secondaryColour: "#123456",
        }),
      "team_colour_invalid"
    );
    expectPolicyError(
      () =>
        inspectTeamLogo({
          mediaType: "image/png",
          contentBase64: `${png().toString("base64")}\n`,
        }),
      "team_logo_base64_invalid"
    );
  });

  test("rejects mismatched, animated, malformed, oversized, or over-dimensioned logos", () => {
    expectPolicyError(
      () =>
        inspectTeamLogo({
          mediaType: "image/jpeg",
          contentBase64: png().toString("base64"),
        }),
      "team_logo_content_invalid"
    );
    expectPolicyError(
      () =>
        inspectTeamLogo({
          mediaType: "image/png",
          contentBase64: png(1, 1, [
            pngChunk("acTL", Buffer.alloc(8)),
          ]).toString("base64"),
        }),
      "team_logo_animation_not_allowed"
    );
    const animatedHeader = Buffer.alloc(10);
    animatedHeader[0] = 0x02;
    animatedHeader.writeUIntLE(3, 4, 3);
    animatedHeader.writeUIntLE(4, 7, 3);
    expectPolicyError(
      () =>
        inspectTeamLogo({
          mediaType: "image/webp",
          contentBase64: webpLossless(4, 5, [
            webpChunk("VP8X", animatedHeader),
          ]).toString("base64"),
        }),
      "team_logo_animation_not_allowed"
    );
    const corrupt = png();
    corrupt[corrupt.length - 1] ^= 0xff;
    expectPolicyError(
      () =>
        inspectTeamLogo({
          mediaType: "image/png",
          contentBase64: corrupt.toString("base64"),
        }),
      "team_logo_content_invalid"
    );
    expectPolicyError(
      () =>
        inspectTeamLogo({
          mediaType: "image/png",
          contentBase64: Buffer.alloc(MAXIMUM_LOGO_BYTES + 1).toString(
            "base64"
          ),
        }),
      "team_logo_bytes_too_large"
    );
    expectPolicyError(
      () =>
        inspectTeamLogo({
          mediaType: "image/png",
          contentBase64: png(2049, 1).toString("base64"),
        }),
      "team_logo_dimensions_invalid"
    );
  });
});

describe("M3-18 team-profile SQLite repository", () => {
  test("stores inspected BLOBs and applies a league-scoped versioned profile update", (t) => {
    const runtime = createRepositoryRuntime(t);
    const inspected = inspectTeamLogo({
      mediaType: "image/png",
      contentBase64: png(8, 6).toString("base64"),
    });
    const logoId = uuid(30);
    const idempotencyId = uuid(31);
    runtime.context.transaction(() => {
      runtime.repository.insertStartedIdempotency({
        id: idempotencyId,
        leagueId: LEAGUE_ID,
        actorUserId: USER_ID,
        operation: "league.team.profile.update.v1",
        clientKey: "repository-profile-update",
        requestHash: "a".repeat(64),
        createdAtMs: NOW_MS,
        expiresAtMs: NOW_MS + 60_000,
      });
      const stored = runtime.repository.insertLogo({
        id: logoId,
        leagueId: LEAGUE_ID,
        teamId: TEAM_ID,
        mediaType: inspected.mediaType,
        byteLength: inspected.byteLength,
        width: inspected.width,
        height: inspected.height,
        contentSha256: crypto
          .createHash("sha256")
          .update(inspected.bytes)
          .digest("hex"),
        contentBytes: inspected.bytes,
        createdAtMs: NOW_MS,
      });
      assert.equal(stored.content_bytes.equals(inspected.bytes), true);
      runtime.repository.updateTeam({
        leagueId: LEAGUE_ID,
        teamId: TEAM_ID,
        expectedVersion: 1,
        changes: {
          name: "Harbour Owls",
          name_normalized: "harbour owls",
          primary_colour: "#102030",
          secondary_colour: "#abcdef",
          logo_reference: logoId,
          updated_at_ms: NOW_MS + 1,
        },
      });
      runtime.repository.appendRenameActivity({
        id: uuid(32),
        leagueId: LEAGUE_ID,
        teamId: TEAM_ID,
        actorUserId: USER_ID,
        actorAuthority: "manager",
        displaySummary: "Alpha Team was renamed to Harbour Owls.",
        metadataJson: JSON.stringify({
          teamId: TEAM_ID,
          previousName: "Alpha Team",
          name: "Harbour Owls",
        }),
        nowMs: NOW_MS + 1,
      });
      runtime.repository.completeIdempotency({
        id: idempotencyId,
        leagueId: LEAGUE_ID,
        teamId: TEAM_ID,
        completedAtMs: NOW_MS + 1,
      });
    });

    const team = runtime.repository.findTeam({
      leagueId: LEAGUE_ID,
      teamId: TEAM_ID,
    });
    assert.equal(team.name, "Harbour Owls");
    assert.equal(team.logo_reference, logoId);
    assert.equal(team.version, 2);
    const current = runtime.repository.findCurrentLogo({
      leagueId: LEAGUE_ID,
      teamId: TEAM_ID,
    });
    assert.equal(current.id, logoId);
    assert.equal(current.content_bytes.equals(inspected.bytes), true);
    assert.equal(
      runtime.repository.findCurrentLogo({
        leagueId: OTHER_LEAGUE_ID,
        teamId: TEAM_ID,
      }),
      null
    );
    assert.equal(
      runtime.repository.findIdempotency({
        leagueId: LEAGUE_ID,
        actorUserId: USER_ID,
        operation: "league.team.profile.update.v1",
        clientKey: "repository-profile-update",
      }).status,
      "completed"
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT event_type FROM league_activity WHERE id = ?"
      ).get(uuid(32)).event_type,
      "team_renamed"
    );
  });

  test("replaces then deletes only the exact old logo object atomically", (t) => {
    const runtime = createRepositoryRuntime(t);
    const inspected = inspectTeamLogo({
      mediaType: "image/png",
      contentBase64: png(2, 2).toString("base64"),
    });
    const oldLogoId = uuid(40);
    const newLogoId = uuid(41);
    for (const id of [oldLogoId, newLogoId]) {
      runtime.repository.insertLogo({
        id,
        leagueId: LEAGUE_ID,
        teamId: TEAM_ID,
        mediaType: inspected.mediaType,
        byteLength: inspected.byteLength,
        width: inspected.width,
        height: inspected.height,
        contentSha256: crypto
          .createHash("sha256")
          .update(inspected.bytes)
          .digest("hex"),
        contentBytes: inspected.bytes,
        createdAtMs: NOW_MS,
      });
    }
    runtime.repository.updateTeam({
      leagueId: LEAGUE_ID,
      teamId: TEAM_ID,
      expectedVersion: 1,
      changes: { logo_reference: oldLogoId, updated_at_ms: NOW_MS + 1 },
    });
    runtime.context.transaction(() => {
      runtime.repository.updateTeam({
        leagueId: LEAGUE_ID,
        teamId: TEAM_ID,
        expectedVersion: 2,
        changes: { logo_reference: newLogoId, updated_at_ms: NOW_MS + 2 },
      });
      runtime.repository.deleteLogo({
        leagueId: LEAGUE_ID,
        teamId: TEAM_ID,
        logoId: oldLogoId,
      });
    });
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM team_logo_objects WHERE league_id = ? AND team_id = ?"
      ).get(LEAGUE_ID, TEAM_ID).count,
      1
    );
    assert.equal(
      runtime.repository.findCurrentLogo({
        leagueId: LEAGUE_ID,
        teamId: TEAM_ID,
      }).id,
      newLogoId
    );
  });
});

describe("M3-18 team-profile application service", () => {
  test("allows the exact manager to atomically rename, recolour, store a logo, audit, and replay", (t) => {
    const runtime = createRepositoryRuntime(t);
    const logoBytes = png(64, 48);
    const command = profileCommand({
      name: "Harbour Owls",
      primaryColour: "#102030",
      secondaryColour: "#abcdef",
      logo: {
        mediaType: "image/png",
        contentBase64: logoBytes.toString("base64"),
      },
    });
    const result = runtime.profileService.update(command);
    assert.equal(result.code, "TEAM_PROFILE_UPDATED");
    assert.equal(result.team.name, "Harbour Owls");
    assert.equal(result.team.primaryColour, "#102030");
    assert.equal(result.team.secondaryColour, "#abcdef");
    assert.equal(result.team.version, 2);
    assert.equal(
      result.team.logoReference,
      `/api/v1/leagues/${LEAGUE_ID}/teams/${TEAM_ID}/logo`
    );
    assert.equal(result.replayed, false);
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM league_activity WHERE event_type = 'team_renamed'"
      ).get().count,
      1
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM security_audit_events WHERE event_type = 'team.profile_updated'"
      ).get().count,
      1
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM idempotency_requests WHERE status = 'completed'"
      ).get().count,
      1
    );
    const logo = runtime.profileService.readLogo({
      leagueId: LEAGUE_ID,
      teamId: TEAM_ID,
      authenticated: authenticated(USER_ID),
    });
    assert.equal(logo.mediaType, "image/png");
    assert.equal(logo.byteLength, logoBytes.length);
    assert.equal(logo.bytes.equals(logoBytes), true);

    const beforeReplay = runtime.database.serialize();
    const replay = runtime.profileService.update(command);
    assert.equal(replay.replayed, true);
    assert.equal(replay.team.version, 2);
    assert.equal(beforeReplay.equals(runtime.database.serialize()), true);
  });

  test("allows the current commissioner and emits no activity for colour-only changes", (t) => {
    const runtime = createRepositoryRuntime(t);
    const result = runtime.profileService.update(
      profileCommand(
        {
          primaryColour: "#112233",
          secondaryColour: "#aabbcc",
        },
        {
          authenticated: authenticated(COMMISSIONER_ID),
          idempotencyKey: "commissioner-colours",
        }
      )
    );
    assert.equal(result.team.version, 2);
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM league_activity"
      ).get().count,
      0
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT actor_user_id FROM security_audit_events"
      ).get().actor_user_id,
      COMMISSIONER_ID
    );
  });

  test("replaces and removes logo objects without leaving stale bytes or activity", (t) => {
    const runtime = createRepositoryRuntime(t);
    runtime.profileService.update(
      profileCommand(
        {
          logo: {
            mediaType: "image/png",
            contentBase64: png(4, 4).toString("base64"),
          },
        },
        { idempotencyKey: "logo-first" }
      )
    );
    const firstId = runtime.database.prepare(
      "SELECT id FROM team_logo_objects WHERE league_id = ? AND team_id = ?"
    ).get(LEAGUE_ID, TEAM_ID).id;
    runtime.profileService.update(
      profileCommand(
        {
          logo: {
            mediaType: "image/jpeg",
            contentBase64: jpeg(5, 6).toString("base64"),
          },
        },
        {
          expectedVersion: 2,
          idempotencyKey: "logo-replace",
        }
      )
    );
    const afterReplacement = runtime.database.prepare(
      "SELECT id, media_type FROM team_logo_objects WHERE league_id = ? AND team_id = ?"
    ).all(LEAGUE_ID, TEAM_ID);
    assert.equal(afterReplacement.length, 1);
    assert.notEqual(afterReplacement[0].id, firstId);
    assert.equal(afterReplacement[0].media_type, "image/jpeg");
    runtime.profileService.update(
      profileCommand(
        { logo: null },
        { expectedVersion: 3, idempotencyKey: "logo-remove" }
      )
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM team_logo_objects WHERE league_id = ? AND team_id = ?"
      ).get(LEAGUE_ID, TEAM_ID).count,
      0
    );
    assert.equal(
      runtime.repository.findTeam({
        leagueId: LEAGUE_ID,
        teamId: TEAM_ID,
      }).logo_reference,
      null
    );
    assert.equal(
      runtime.database.prepare(
        "SELECT COUNT(*) AS count FROM league_activity"
      ).get().count,
      0
    );
  });

  test("rolls back the logo, team update, audit, and idempotency when a post-logo seam fails", (t) => {
    const runtime = createRepositoryRuntime(t);
    const failing = createTeamProfileService({
      ...runtime.profileDependencies,
      auditRepository: {
        append() {
          throw new Error("injected audit failure");
        },
      },
    });
    const before = runtime.database.serialize();
    assert.throws(
      () =>
        failing.update(
          profileCommand({
            name: "Rollback Owls",
            logo: {
              mediaType: "image/webp",
              contentBase64: webpLossless(3, 3).toString("base64"),
            },
          })
        ),
      (error) => {
        assert.equal(error.code, "REPOSITORY_OPERATION_FAILED");
        assert.equal(error.cause?.message, "injected audit failure");
        return true;
      }
    );
    assert.equal(before.equals(runtime.database.serialize()), true);
  });

  test("rejects stale, unchanged, unauthorized, and mismatched idempotency requests without writes", (t) => {
    const runtime = createRepositoryRuntime(t);
    const initial = runtime.database.serialize();
    assert.throws(
      () =>
        runtime.profileService.update(
          profileCommand(
            { name: "New Name" },
            { expectedVersion: 2, idempotencyKey: "stale" }
          )
        ),
      (error) => {
        assert.equal(error.code, "TEAM_PROFILE_PRECONDITION_FAILED");
        assert.deepEqual(error.details, {
          currentVersion: 1,
          refetch: true,
        });
        return true;
      }
    );
    assert(initial.equals(runtime.database.serialize()));
    assert.throws(
      () =>
        runtime.profileService.update(
          profileCommand(
            { name: "Cross League" },
            {
              leagueId: OTHER_LEAGUE_ID,
              idempotencyKey: "cross-league",
            }
          )
        ),
      { code: "LEAGUE_NOT_FOUND" }
    );
    assert(initial.equals(runtime.database.serialize()));
    assert.throws(
      () =>
        runtime.profileService.update(
          profileCommand(
            { name: "BETA TEAM" },
            { idempotencyKey: "duplicate-name" }
          )
        ),
      { code: "TEAM_NAME_UNAVAILABLE" }
    );
    assert(initial.equals(runtime.database.serialize()));
    assert.throws(
      () =>
        runtime.profileService.update(
          profileCommand(
            { name: "Alpha Team" },
            { idempotencyKey: "unchanged" }
          )
        ),
      { code: "TEAM_PROFILE_NO_CHANGES" }
    );
    assert(initial.equals(runtime.database.serialize()));
    assert.throws(
      () =>
        runtime.profileService.update(
          profileCommand(
            { name: "Hidden Change" },
            {
              authenticated: authenticated(OUTSIDER_ID),
              idempotencyKey: "outsider",
            }
          )
        ),
      { code: "LEAGUE_NOT_FOUND" }
    );
    assert(initial.equals(runtime.database.serialize()));
    assert.throws(
      () =>
        runtime.profileService.update(
          profileCommand(
            { name: "Wrong Team" },
            {
              teamId: OTHER_TEAM_ID,
              idempotencyKey: "wrong-team",
            }
          )
        ),
      { code: "TEAM_MANAGER_REQUIRED" }
    );
    assert(initial.equals(runtime.database.serialize()));

    const first = profileCommand(
      { name: "First Update" },
      { idempotencyKey: "same-key" }
    );
    runtime.profileService.update(first);
    const afterFirst = runtime.database.serialize();
    assert.throws(
      () =>
        runtime.profileService.update(
          profileCommand(
            { name: "Different Update" },
            { idempotencyKey: "same-key" }
          )
        ),
      { code: "IDEMPOTENCY_KEY_REUSED" }
    );
    assert(afterFirst.equals(runtime.database.serialize()));
  });

  test("keeps stored legacy logo references private in safe team reads", (t) => {
    const runtime = createRepositoryRuntime(t);
    runtime.context.repositories.teams.updateVersioned({
      key: TEAM_ID,
      leagueId: LEAGUE_ID,
      expectedVersion: 1,
      changes: {
        logo_reference: "legacy-file-or-url",
        updated_at_ms: NOW_MS + 1,
      },
    });
    const safe = require(
      "../../src/application/services/leagues/createTeamReadService"
    ).safeTeam(
      runtime.teamReadRepository.findTeam({
        leagueId: LEAGUE_ID,
        teamId: TEAM_ID,
      })
    );
    assert.equal(safe.logoReference, null);
  });
});

describe("M3-18 isolated team-profile HTTP contract", () => {
  test("updates a profile and serves its exact current logo as read-only binary", async (t) => {
    const runtime = createRepositoryRuntime(t);
    const api = await startProfileApi(t, runtime);
    const logoBytes = png(80, 60);
    const teamUrl = new URL(
      `/api/v1/leagues/${LEAGUE_ID}/teams/${TEAM_ID}`,
      api.baseUrl
    );
    const updated = await fetch(teamUrl, {
      method: "PATCH",
      headers: httpHeaders(api.sessionCookie, USER_ID),
      body: JSON.stringify({
        logo: {
          mediaType: "image/png",
          contentBase64: logoBytes.toString("base64"),
        },
      }),
    });
    const updatedBody = await updated.json();
    assert.equal(updated.status, 200);
    assert.equal(updatedBody.meta.requestId, "m3-18-request");
    assert.equal(updatedBody.data.team.version, 2);
    assert.equal(
      updatedBody.data.team.logoReference,
      `/api/v1/leagues/${LEAGUE_ID}/teams/${TEAM_ID}/logo`
    );

    const beforeRead = runtime.database.serialize();
    const logoResponse = await fetch(
      new URL(updatedBody.data.team.logoReference, api.baseUrl),
      { headers: httpHeaders(api.sessionCookie, USER_ID) }
    );
    const received = Buffer.from(await logoResponse.arrayBuffer());
    assert.equal(logoResponse.status, 200);
    assert.equal(logoResponse.headers.get("content-type"), "image/png");
    assert.equal(
      logoResponse.headers.get("content-length"),
      String(logoBytes.length)
    );
    assert.match(logoResponse.headers.get("etag"), /^"[0-9a-f]{64}"$/);
    assert.equal(
      logoResponse.headers.get("x-content-type-options"),
      "nosniff"
    );
    assert.equal(
      logoResponse.headers.get("cache-control"),
      "private, no-store"
    );
    assert.equal(received.equals(logoBytes), true);
    assert.equal(beforeRead.equals(runtime.database.serialize()), true);
  });

  test("maps stale, hidden, malformed, and over-limit requests to safe responses without writes", async (t) => {
    const runtime = createRepositoryRuntime(t);
    const api = await startProfileApi(t, runtime);
    const teamUrl = new URL(
      `/api/v1/leagues/${LEAGUE_ID}/teams/${TEAM_ID}`,
      api.baseUrl
    );
    const before = runtime.database.serialize();
    const missingLogo = await fetch(
      new URL(
        `/api/v1/leagues/${LEAGUE_ID}/teams/${TEAM_ID}/logo`,
        api.baseUrl
      ),
      { headers: httpHeaders(api.sessionCookie, USER_ID) }
    );
    assert.equal(missingLogo.status, 404);
    assert.equal(
      (await missingLogo.json()).error.code,
      "TEAM_LOGO_NOT_FOUND"
    );
    assert(before.equals(runtime.database.serialize()));

    const stale = await fetch(teamUrl, {
      method: "PATCH",
      headers: httpHeaders(api.sessionCookie, USER_ID, {
        idempotencyKey: "stale-http",
        version: 2,
      }),
      body: JSON.stringify({ name: "Stale Owls" }),
    });
    const staleBody = await stale.json();
    assert.equal(stale.status, 412);
    assert.equal(staleBody.error.code, "PRECONDITION_FAILED");
    assert.deepEqual(staleBody.error.details, {
      currentVersion: 1,
      refetch: true,
    });
    assert(before.equals(runtime.database.serialize()));

    const hidden = await fetch(
      new URL(
        `/api/v1/leagues/${LEAGUE_ID}/teams/${TEAM_ID}/logo`,
        api.baseUrl
      ),
      { headers: httpHeaders(api.sessionCookie, OUTSIDER_ID) }
    );
    assert.equal(hidden.status, 404);
    assert.equal((await hidden.json()).error.code, "LEAGUE_NOT_FOUND");
    assert(before.equals(runtime.database.serialize()));

    const malformed = await fetch(teamUrl, {
      method: "PATCH",
      headers: httpHeaders(api.sessionCookie, USER_ID, {
        idempotencyKey: "malformed-http",
      }),
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "TEAM_PROFILE_INVALID");
    assert(before.equals(runtime.database.serialize()));

    const missingSession = await fetch(teamUrl, {
      method: "PATCH",
      headers: httpHeaders(api.sessionCookie, USER_ID, {
        idempotencyKey: "missing-session-http",
        includeCookie: false,
      }),
      body: JSON.stringify({ name: "No Session" }),
    });
    assert.equal(missingSession.status, 401);
    assert.equal((await missingSession.json()).error.code, "SESSION_REQUIRED");
    assert(before.equals(runtime.database.serialize()));

    const invalidCsrf = await fetch(teamUrl, {
      method: "PATCH",
      headers: httpHeaders(api.sessionCookie, USER_ID, {
        csrfToken: "invalid",
        idempotencyKey: "invalid-csrf-http",
      }),
      body: JSON.stringify({ name: "No CSRF" }),
    });
    assert.equal(invalidCsrf.status, 403);
    assert.equal((await invalidCsrf.json()).error.code, "CSRF_INVALID");
    assert(before.equals(runtime.database.serialize()));

    const invalidOrigin = await fetch(teamUrl, {
      method: "PATCH",
      headers: httpHeaders(api.sessionCookie, USER_ID, {
        idempotencyKey: "invalid-origin-http",
        origin: "https://evil.example",
      }),
      body: JSON.stringify({ name: "No Origin" }),
    });
    assert.equal(invalidOrigin.status, 403);
    assert.equal((await invalidOrigin.json()).error.code, "ORIGIN_NOT_ALLOWED");
    assert(before.equals(runtime.database.serialize()));

    const overLimit = await fetch(teamUrl, {
      method: "PATCH",
      headers: httpHeaders(api.sessionCookie, USER_ID, {
        idempotencyKey: "large-http",
      }),
      body: JSON.stringify({ unknown: "x".repeat(769 * 1024) }),
    });
    assert.equal(overLimit.status, 413);
    assert.equal((await overLimit.json()).error.code, "TEAM_PROFILE_TOO_LARGE");
    assert(before.equals(runtime.database.serialize()));
  });
});
