const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { openDatabase, openReadonlyDatabase } = require("../../infrastructure/database/connection");
const { discoverMigrations, assertMigrationCompatibility } = require("../../infrastructure/database/migrate");
const { RECOVERY_HOLD_KEY } = require("../../infrastructure/database/recoveryHold");
const { readRecoveryEpoch } = require("../../infrastructure/database/recoveryEpoch");
const { canonicalize } = require("../../infrastructure/migration/sourceInventory");
const { createTargetRepositories, createTargetServices, createTargetRouters, createTargetApplication,
  TARGET_ENDPOINTS } = require("../../bootstrap/createTargetRuntime");
const { createTargetHttpServer } = require("../../bootstrap/createTargetHttpServer");
const { createLeagueWriteGate } = require("../../application/services/operations/createLeagueWriteGate");
const { createSocketAuthorizationService } = require("../../application/services/authorization/createSocketAuthorizationService");
const { createAuthenticatedSocketRooms } = require("../../transport/socket/createAuthenticatedSocketRooms");
const { createSessionSocketInvalidator } = require("../../infrastructure/socket/createSessionSocketInvalidator");
const { createOperationsHealthRouter } = require("../../transport/http/createOperationsHealthRouter");
const { buildRecoveryCompletionReview } = require("./buildRecoveryCompletionReview");
const { prepareRecoveryReopeningCopy } = require("./prepareRecoveryReopeningCopy");
const { hash, same, assertReader, readRows, snapshots } = require("./recoveryKnownBuyoutEvidence");

const ID = "[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const READ_ROUTERS = new Set(["accountSession", "leagueRead", "team", "auction", "trade", "matchup"]);
const OPERATIONS_READ_PATHS = new Set(["/api/v1/operations/health", "/api/v1/operations/recovery/review"]);
const CORRECTIONS_PATH = "/api/v1/operations/recovery/corrections";
const REOPENING_PATH = "/api/v1/operations/recovery/reopening-copy";
const REVIEW_LIFETIME_MS = 5 * 60 * 1000;
const DIGEST = /^[a-f0-9]{64}$/;
const READ_PATHS = TARGET_ENDPOINTS.filter(({ method, routerKey }) => method === "GET" && READ_ROUTERS.has(routerKey))
  .map(({ path: route }) => new RegExp("^" + route.replace(/:[A-Za-z]+/g, ID) + "$"));
const AUTH_TABLES = new Set(["sessions", "security_audit_events", "authentication_rate_limits", "outbox_events"]);
const inside = (root, file) => { const relative = path.relative(root, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
function exists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
class RecoveryMaintenanceError extends Error {
  constructor(code) { super("Recovery maintenance requires a verified held copy and restricted local access.");
    this.name = "RecoveryMaintenanceError"; this.code = code; }
}
function fail(code) { throw new RecoveryMaintenanceError(code); }

function verifyAuthenticationChanges(before, after) {
  const beforeSnapshots = snapshots(before), afterSnapshots = snapshots(after);
  for (const table of Object.keys(before)) {
    if (!AUTH_TABLES.has(table) && !same(beforeSnapshots[table], afterSnapshots[table])) fail("RECOVERY_MAINTENANCE_DOMAIN_CHANGED");
  }
  for (const table of ["sessions", "security_audit_events", "outbox_events"]) {
    const ids = new Set(before[table].map(row => row.id));
    if (!same(snapshots({ rows: before[table] }), snapshots({ rows: after[table].filter(row => ids.has(row.id)) }))) fail("RECOVERY_MAINTENANCE_HISTORY_CHANGED");
  }
  const newAudits = after.security_audit_events.filter(row => !before.security_audit_events.some(old => old.id === row.id));
  if (newAudits.some(row => !["account.sign_in", "account.sign_out"].includes(row.event_type))) fail("RECOVERY_MAINTENANCE_AUDIT_UNEXPECTED");
  const newSessions = after.sessions.filter(row => !before.sessions.some(old => old.id === row.id));
  if (newSessions.some(row => row.status !== "revoked" || !newAudits.some(audit => audit.event_type === "account.sign_in" &&
      audit.outcome === "success" && audit.actor_user_id === row.user_id && audit.session_id === row.id))) fail("RECOVERY_MAINTENANCE_SESSION_UNEXPECTED");
  const newMessages = after.outbox_events.filter(row => !before.outbox_events.some(old => old.id === row.id));
  for (const row of newMessages) {
    const payload = JSON.parse(row.payload_json);
    if (row.league_id !== null || row.event_type !== "account.session_replaced_notification" || row.status !== "pending" || row.attempt_count !== 0 ||
        row.published_at_ms !== null || row.aggregate_type !== "user" || payload.notificationKind !== "session_replaced" ||
        payload.recipientUserId !== row.aggregate_id || !newAudits.some(audit => audit.event_type === "account.sign_in" && audit.outcome === "success" &&
          audit.actor_user_id === row.aggregate_id && audit.occurred_at_ms === row.created_at_ms)) fail("RECOVERY_MAINTENANCE_MESSAGE_UNEXPECTED");
  }
  return { createdSessions: newSessions.length, createdAuditEvents: newAudits.length, heldNewSecurityMessages: newMessages.length };
}

// An isolated maintenance verification copy, never a normal-runtime bypass.
// Only session authentication can change database rows. Feature GETs
// and socket authorization use a separate read-only SQLite connection. Every
// input remains immutable, and the candidate's durable hold is never removed.
async function startRecoveryMaintenanceSession({ reviewOptions: suppliedReview, temporaryRoot, outputDirectory,
  migrationsDirectory, securityFoundations, currentSeason, backendBuildId, reopeningBackup = null } = {}) {
  if (![temporaryRoot, outputDirectory, migrationsDirectory].every(value => typeof value === "string" && path.isAbsolute(value)) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(backendBuildId || "") ||
      !securityFoundations?.config || !securityFoundations?.clock || !securityFoundations?.secureRandom || !securityFoundations?.logger) fail("RECOVERY_MAINTENANCE_INPUT_INVALID");
  const backupEnvironment = securityFoundations.config.appEnv === "production" ? "production" : "staging";
  if (reopeningBackup && reopeningBackup.config?.appEnv !== backupEnvironment) fail("RECOVERY_MAINTENANCE_BACKUP_ENVIRONMENT_INVALID");
  let writer, reader, server, output = null, physicalRoot, started = false;
  try {
    const reviewOptions = { ...suppliedReview, plan: JSON.parse(JSON.stringify(suppliedReview?.plan)),
      credentialPreparation: JSON.parse(JSON.stringify(suppliedReview?.credentialPreparation)),
      lineage: suppliedReview?.lineage == null ? null : JSON.parse(JSON.stringify(suppliedReview.lineage)) };
    const reviewed = buildRecoveryCompletionReview(reviewOptions);
    const sources = [reviewOptions.candidateDatabase, reviewOptions.restoredDatabase, reviewOptions.preservedDatabase];
    const digests = [reviewed.candidatePlaintextSha256, reviewed.restoredPlaintextSha256, reviewed.preservedPlaintextSha256];
    const sourceChanges = sources.map(database => database.prepare("SELECT total_changes() n").get().n);
    const assertSources = () => sources.forEach((database, index) => { assertReader(database, digests[index]);
      if (database.prepare("SELECT total_changes() n").get().n !== sourceChanges[index]) fail("RECOVERY_MAINTENANCE_SOURCE_CHANGED"); });
    physicalRoot = fs.realpathSync(temporaryRoot);
    const resolvedOutput = path.join(fs.realpathSync(path.dirname(outputDirectory)), path.basename(outputDirectory));
    if (!inside(fs.realpathSync(os.tmpdir()), physicalRoot) || !inside(physicalRoot, resolvedOutput) || exists(resolvedOutput) ||
        !sources.every(database => inside(physicalRoot, fs.realpathSync(database.name)))) fail("RECOVERY_MAINTENANCE_PATH_UNSAFE");
    const migrations = discoverMigrations({ migrationsDirectory });
    assertMigrationCompatibility(sources[0], migrations);
    assertSources(); fs.mkdirSync(resolvedOutput, { mode: 0o700 }); output = resolvedOutput;
    const databasePath = path.join(output, "maintenance-verification.sqlite3");
    fs.copyFileSync(sources[0].name, databasePath, fs.constants.COPYFILE_EXCL); fs.chmodSync(databasePath, 0o600);
    writer = openDatabase({ databasePath, environment: "staging", persistentRoot: physicalRoot, requirePersistentRoot: true }).database;
    reader = openReadonlyDatabase({ databasePath });
    const before = readRows(reader), hold = before.application_metadata.find(row => row.metadata_key === RECOVERY_HOLD_KEY);
    if (!hold || !same(snapshots(before), reviewOptions.plan.tableSnapshots)) fail("RECOVERY_MAINTENANCE_COPY_MISMATCH");
    const heldEpoch = readRecoveryEpoch(reader), observed = { providerCalls: 0, emailCalls: 0, publications: 0, requests: 0 };
    const held = () => {
      if (!same(reader.prepare("SELECT * FROM application_metadata WHERE metadata_key=?").get(RECOVERY_HOLD_KEY), hold) ||
          !same(readRecoveryEpoch(reader), heldEpoch)) fail("RECOVERY_MAINTENANCE_HOLD_CHANGED");
      return heldEpoch;
    };
    const denyExternal = kind => async () => { observed[kind] += 1; fail("RECOVERY_MAINTENANCE_EXTERNAL_BLOCKED"); };
    let app, socketRooms;
    const onSessionChanged = createSessionSocketInvalidator({ getIo: () => app?.get("io"), getSocketRooms: () => socketRooms });
    function compose(database, writable) {
      const repositories = createTargetRepositories({ database, secureRandom: securityFoundations.secureRandom,
        ...(writable ? { onSessionChanged } : {}) });
      const services = createTargetServices({ repositories, securityFoundations, currentSeason,
        leagueInvalidationPublisher: { publish() { observed.publications += 1; fail("RECOVERY_MAINTENANCE_EXTERNAL_BLOCKED"); } },
        nhlFetchImplementation: denyExternal("providerCalls"), sportsDataIoFetchImplementation: denyExternal("providerCalls"),
        emailFetchImplementation: denyExternal("emailCalls"), emailAdapter: { sendEmailVerification: denyExternal("emailCalls"),
          sendAccountActionLink: denyExternal("emailCalls"), sendSecurityNotification: denyExternal("emailCalls") } });
      const transport = createTargetRouters({ services, securityFoundations, networkSourceResolver: () => "127.0.0.1", getRecoveryEpoch: held });
      const application = createTargetApplication({ routers: transport.routers, leagueWriteGate: createLeagueWriteGate({ mode: "closed",
        isAllowedOrigin: securityFoundations.config.isAllowedFrontendOrigin }) });
      return { repositories, services, transport, application };
    }
    const writeRuntime = compose(writer, true), readRuntime = compose(reader, false);
    const issuedReviews = new Map(), correctionRecords = new Map();
    let reopeningResult = null, reopeningBusy = false;
    const assertReopeningRecord = () => {
      if (!reopeningResult) return;
      for (const [file, digest] of [[reopeningResult.databasePath, reopeningResult.receipt.reopeningPlaintextSha256],
        [reopeningResult.receiptPath, reopeningResult.receiptFileSha256]]) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || hash(fs.readFileSync(file)) !== digest) fail("RECOVERY_REOPENING_COPY_CHANGED");
      }
    };
    const assertCorrectionRecords = () => {
      if (fs.lstatSync(output).isSymbolicLink() || fs.realpathSync(output) !== output) fail("RECOVERY_MAINTENANCE_PATH_UNSAFE");
      for (const [file, record] of correctionRecords) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || hash(fs.readFileSync(file)) !== record.fileSha256) {
          fail("RECOVERY_MAINTENANCE_CORRECTIONS_CHANGED");
        }
      }
    };
    socketRooms = createAuthenticatedSocketRooms({ authorizationService: createSocketAuthorizationService({
      isAllowedOrigin: securityFoundations.config.isAllowedFrontendOrigin, sessionCookie: readRuntime.transport.sessionCookie,
      sessionService: readRuntime.services.sessionService, leagueAuthorization: readRuntime.services.authorizations.league,
      leagueAccessRepository: readRuntime.repositories.leagueAccess, teamAuthorityRepository: readRuntime.repositories.teamAuthority }) });
    const authenticatedRooms = socketRooms;
    const health = () => { held(); return { mode: "isolated-recovery-maintenance", status: "held", databaseIdentity: reviewed.databaseIdentity,
      schemaVersion: reviewed.schemaVersion, backendBuildId, backendBuildEvidence: "operator-supplied-label", sourceBackupId: reviewed.sourceBackupId,
      recoveryId: reviewed.recoveryId, recoveryEpoch: heldEpoch, candidatePlaintextSha256: reviewed.candidatePlaintextSha256,
      jobs: "not-started", email: "held", leagueWrites: "blocked", featureReads: "readonly-sqlite-connection", activationReady: false }; };
    const operations = createOperationsHealthRouter({ requestSecurity: readRuntime.transport.requestSecurity,
      platformAuthorization: readRuntime.services.authorizations.platform, healthService: { readOperations: health } });
    const send = (response, status, code) => response.status(status).json({ error: { code,
      message: code === "SESSION_REQUIRED" ? "A valid session is required." : "Recovery maintenance does not permit this request." } });
    operations.get("/api/v1/operations/recovery/review", readRuntime.transport.requestSecurity.authenticateBootstrap, (request, response) => {
      try {
        const authenticated = readRuntime.transport.requestSecurity.getSessionBootstrap(request);
        readRuntime.services.authorizations.platform.requireAdministrator(authenticated);
        held(); assertSources();
        const currentReview = buildRecoveryCompletionReview({ ...reviewOptions, observedAtMs: securityFoundations.clock.nowMs() });
        assertSources();
        const reviewToken = securityFoundations.secureRandom.id(), expiresAtMs = currentReview.observedAtMs + REVIEW_LIFETIME_MS;
        for (const [sessionId, issued] of issuedReviews) if (issued.expiresAtMs <= currentReview.observedAtMs) issuedReviews.delete(sessionId);
        issuedReviews.set(authenticated.session.id, { reviewToken, expiresAtMs, review: currentReview, receipt: null });
        return response.status(200).json({ data: currentReview,
          meta: { requestId: readRuntime.transport.requestSecurity.getRequestId(request),
            scope: "source-candidate-review", maintenanceCopyIsActivationCandidate: false,
            correctionReview: { reviewToken, expiresAtMs, findings: currentReview.financialConsistency.candidate.findings.map(finding => ({
              findingSha256: hash(canonicalize(finding)), ...finding })) } } });
      } catch (error) {
        const forbidden = error?.code === "PLATFORM_ADMINISTRATOR_REQUIRED";
        return send(response, forbidden ? 403 : 503, forbidden ? error.code : "RECOVERY_MAINTENANCE_REQUEST_FAILED");
      }
    });
    // Record explicit follow-up references for every current candidate finding.
    // This is an authenticated local incident artifact, not a correction, proof
    // of complete history, administrator closeout, or permission to remove a hold.
    operations.post(CORRECTIONS_PATH, writeRuntime.transport.requestSecurity.requireJson, express.json({ limit: "32kb", strict: true }),
      writeRuntime.transport.requestSecurity.authenticateUnsafe, (request, response) => {
        try {
          const authenticated = writeRuntime.transport.requestSecurity.getAuthenticatedSession(request);
          const authority = readRuntime.services.authorizations.platform.requireAdministrator(authenticated);
          const nowMs = securityFoundations.clock.nowMs(), input = request.body;
          const issued = issuedReviews.get(authenticated.session.id);
          if (!input || !same(Object.keys(input).sort(), ["corrections", "reportChecksum", "reviewToken"]) ||
              !DIGEST.test(input.reportChecksum || "") || typeof input.reviewToken !== "string" || !Array.isArray(input.corrections)) {
            return send(response, 400, "RECOVERY_CORRECTIONS_INVALID");
          }
          if (!issued || issued.reviewToken !== input.reviewToken || issued.review.reportChecksum !== input.reportChecksum ||
              nowMs < issued.review.observedAtMs || nowMs >= issued.expiresAtMs) return send(response, 409, "RECOVERY_REVIEW_STALE");
          held(); assertSources(); assertCorrectionRecords();
          const rebuilt = buildRecoveryCompletionReview({ ...reviewOptions, observedAtMs: issued.review.observedAtMs });
          if (rebuilt.reportChecksum !== issued.review.reportChecksum) return send(response, 409, "RECOVERY_REVIEW_STALE");
          const findings = new Map(rebuilt.financialConsistency.candidate.findings.map(finding => [hash(canonicalize(finding)), finding]));
          const seen = new Set(), corrections = [];
          if (findings.size === 0 || input.corrections.length !== findings.size) return send(response, 400, "RECOVERY_CORRECTIONS_INVALID");
          for (const entry of input.corrections) {
            if (!entry || !same(Object.keys(entry).sort(), ["disposition", "findingSha256", "trackingReference"]) ||
                !DIGEST.test(entry.findingSha256 || "") || !findings.has(entry.findingSha256) || seen.has(entry.findingSha256) ||
                entry.disposition !== "tracked-for-correction" || typeof entry.trackingReference !== "string" ||
                !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/.test(entry.trackingReference)) return send(response, 400, "RECOVERY_CORRECTIONS_INVALID");
            seen.add(entry.findingSha256);
            corrections.push({ findingSha256: entry.findingSha256, finding: findings.get(entry.findingSha256),
              disposition: entry.disposition, trackingReference: entry.trackingReference });
          }
          corrections.sort((left, right) => left.findingSha256.localeCompare(right.findingSha256));
          const decisionChecksum = hash(canonicalize(corrections));
          if (issued.receipt !== null) {
            if (issued.receipt.decisionChecksum !== decisionChecksum) return send(response, 409, "RECOVERY_CORRECTIONS_ALREADY_RECORDED");
            return response.status(200).json({ data: issued.receipt, meta: { replayed: true } });
          }
          const report = { reportVersion: 1, status: "candidate-financial-corrections-tracked", scope: "isolated-maintenance-incident-artifact",
            recoveryId: rebuilt.recoveryId, recoveryEpoch: rebuilt.recoveryEpoch, sourceBackupId: rebuilt.sourceBackupId,
            databaseIdentity: rebuilt.databaseIdentity, planChecksum: rebuilt.planChecksum, candidateReviewChecksum: rebuilt.reportChecksum,
            candidatePlaintextSha256: rebuilt.candidatePlaintextSha256, restoredPlaintextSha256: rebuilt.restoredPlaintextSha256,
            preservedPlaintextSha256: rebuilt.preservedPlaintextSha256, observedAtMs: rebuilt.observedAtMs, recordedAtMs: nowMs,
            authenticatedActor: { userId: authority.actorUserId, sessionId: authenticated.session.id,
              sessionCreatedAtMs: authenticated.session.createdAtMs, roleId: authority.roleId, roleVersion: authority.roleVersion },
            corrections, decisionChecksum, trackedFindingCount: corrections.length, allCurrentCandidateFindingsTracked: true,
            referencedCorrectionsIndependentlyVerified: false, completeFinancialReconciliation: false, currentOperatorApproval: false,
            completeLossWindowEvidence: false, activationReady: false, executable: false };
          const receipt = { ...report, reportChecksum: hash(canonicalize(report)) }, bytes = canonicalize(receipt) + "\n";
          const file = path.join(output, `correction-review-${receipt.reportChecksum}.json`);
          // A new GET can issue another token within the same clock tick. The
          // exact already-verified receipt still wins over a second file write.
          if (correctionRecords.has(file)) {
            issued.receipt = correctionRecords.get(file).receipt;
            return response.status(200).json({ data: issued.receipt, meta: { replayed: true } });
          }
          const descriptor = fs.openSync(file, "wx", 0o600);
          try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
          correctionRecords.set(file, { fileSha256: hash(bytes), receipt });
          held(); assertSources(); assertCorrectionRecords(); issued.receipt = receipt;
          return response.status(201).json({ data: receipt, meta: { replayed: false } });
        } catch (error) {
          const forbidden = error?.code === "PLATFORM_ADMINISTRATOR_REQUIRED";
          return send(response, forbidden ? 403 : 503, forbidden ? error.code : "RECOVERY_CORRECTIONS_FAILED");
        }
      });
    operations.post(REOPENING_PATH, writeRuntime.transport.requestSecurity.requireJson, express.json({ limit: "32kb", strict: true }),
      writeRuntime.transport.requestSecurity.authenticateUnsafe, async (request, response) => {
        try {
          const input = request.body;
          if (!input || !same(Object.keys(input).sort(), ["correctionReviewChecksum", "lossWindowReference", "mode", "reportChecksum", "reviewToken"]) ||
              input.mode !== "prepare-isolated-copy" || !DIGEST.test(input.reportChecksum || "") || typeof input.reviewToken !== "string" ||
              (input.correctionReviewChecksum !== null && !DIGEST.test(input.correctionReviewChecksum || "")) ||
              typeof input.lossWindowReference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,159}$/.test(input.lossWindowReference)) {
            return send(response, 400, "RECOVERY_REOPENING_INPUT_INVALID");
          }
          if (!reopeningBackup) return send(response, 503, "RECOVERY_REOPENING_BACKUP_REQUIRED");
          const authenticated = writeRuntime.transport.requestSecurity.getAuthenticatedSession(request);
          const issued = issuedReviews.get(authenticated.session.id);
          const rawToken = readRuntime.transport.sessionCookie.read(request.get("cookie"));
          const authorize = () => {
            const resolution = readRuntime.services.sessionService.resolveWithoutActivity(rawToken), nowMs = securityFoundations.clock.nowMs();
            if (!resolution.valid || resolution.session.id !== authenticated.session.id || !Number.isSafeInteger(nowMs) ||
                nowMs < resolution.session.createdAtMs || nowMs - resolution.session.createdAtMs >= REVIEW_LIFETIME_MS) fail("RECOVERY_FRESH_SIGN_IN_REQUIRED");
            const authority = readRuntime.services.authorizations.platform.requireAdministrator(resolution);
            if (!issued || issuedReviews.get(authenticated.session.id) !== issued || issued.reviewToken !== input.reviewToken ||
                issued.review.reportChecksum !== input.reportChecksum || nowMs < issued.review.observedAtMs || nowMs >= issued.expiresAtMs) fail("RECOVERY_REVIEW_STALE");
            held(); assertSources(); assertCorrectionRecords(); assertReopeningRecord();
            const review = buildRecoveryCompletionReview({ ...reviewOptions, observedAtMs: issued.review.observedAtMs });
            if (review.reportChecksum !== input.reportChecksum || review.dispositions.unresolvedJobs !== 0 || review.dispositions.unresolvedMessages !== 0) fail("RECOVERY_REOPENING_WORK_UNRESOLVED");
            const findingCount = review.financialConsistency.candidate.findings.length;
            if ((findingCount === 0 && input.correctionReviewChecksum !== null) || (findingCount > 0 &&
                (!issued.receipt || issued.receipt.reportChecksum !== input.correctionReviewChecksum || issued.receipt.trackedFindingCount !== findingCount))) fail("RECOVERY_REOPENING_CORRECTIONS_REQUIRED");
            return { review, plan: reviewOptions.plan, nowMs, corrections: issued.receipt?.corrections || [], actor: { userId: authority.actorUserId, sessionId: resolution.session.id,
              sessionCreatedAtMs: resolution.session.createdAtMs, roleId: authority.roleId, roleVersion: authority.roleVersion } };
          };
          authorize();
          const decision = { mode: input.mode, reportChecksum: input.reportChecksum, lossWindowReference: input.lossWindowReference,
            correctionReviewChecksum: input.correctionReviewChecksum }, checksum = hash(canonicalize(decision));
          if (reopeningResult) {
            if (reopeningResult.receipt.decisionChecksum !== checksum) return send(response, 409, "RECOVERY_REOPENING_ALREADY_PREPARED");
            return response.status(200).json({ data: { ...reopeningResult.receipt, databasePath: reopeningResult.databasePath }, meta: { replayed: true } });
          }
          if (reopeningBusy) return send(response, 409, "RECOVERY_REOPENING_IN_PROGRESS");
          reopeningBusy = true;
          try {
            reopeningResult = await prepareRecoveryReopeningCopy({ sourceDatabase: sources[0], outputRoot: output, temporaryRoot: physicalRoot,
              backupConfig: reopeningBackup.config, backupEnvironment, objectStorage: reopeningBackup.objectStorage, backendBuildId,
              reopeningId: securityFoundations.secureRandom.id(), decision, authorize, nowMs: () => securityFoundations.clock.nowMs() });
          } finally { reopeningBusy = false; }
          return response.status(201).json({ data: { ...reopeningResult.receipt, databasePath: reopeningResult.databasePath }, meta: { replayed: false } });
        } catch (error) {
          const forbidden = ["PLATFORM_ADMINISTRATOR_REQUIRED", "RECOVERY_FRESH_SIGN_IN_REQUIRED"].includes(error?.code);
          return send(response, forbidden ? 403 : 409, forbidden ? error.code : "RECOVERY_REOPENING_FAILED");
        }
      });
    operations.use((error, request, response, next) => {
      if ([CORRECTIONS_PATH, REOPENING_PATH].includes(request.path) && ["entity.parse.failed", "entity.too.large"].includes(error?.type)) {
        return send(response, 400, "RECOVERY_CORRECTIONS_INVALID");
      }
      return next(error);
    });
    app = express(); app.disable("x-powered-by");
    app.use((request, response, next) => {
      response.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" });
      try { held(); } catch { return send(response, 503, "RECOVERY_MAINTENANCE_HOLD_CHANGED"); }
      observed.requests += 1;
      if (request.method === "GET" && request.path === "/health") return response.status(200).json({ status: "ok", mode: "recovery-maintenance" });
      const method = request.method === "OPTIONS" ? request.get("access-control-request-method") : request.method;
      const authentication = ["POST", "DELETE"].includes(method) && request.path === "/api/v1/session";
      const correctionWrite = method === "POST" && request.path === CORRECTIONS_PATH;
      const reopeningWrite = method === "POST" && request.path === REOPENING_PATH;
      const featureRead = method === "GET" && (OPERATIONS_READ_PATHS.has(request.path) || READ_PATHS.some(pattern => pattern.test(request.path)));
      if (!authentication && !featureRead && !correctionWrite && !reopeningWrite) return send(response, 503, "RECOVERY_MAINTENANCE_WRITES_BLOCKED");
      if ((featureRead || correctionWrite || reopeningWrite) && request.method !== "OPTIONS") {
        // Expired sessions must not cause the ordinary bootstrap service to
        // persist expiry while serving a GET. Validation here is read-only.
        let token;
        try { token = readRuntime.transport.sessionCookie.read(request.get("cookie")); }
        catch { return send(response, 401, "SESSION_REQUIRED"); }
        const resolution = readRuntime.services.sessionService.resolveWithoutActivity(token);
        if (!resolution.valid) return send(response, 401, "SESSION_REQUIRED");
        const nowMs = securityFoundations.clock.nowMs();
        if ((correctionWrite || reopeningWrite) && (!Number.isSafeInteger(nowMs) || nowMs < resolution.session.createdAtMs ||
            nowMs - resolution.session.createdAtMs >= REVIEW_LIFETIME_MS)) return send(response, 403, "RECOVERY_FRESH_SIGN_IN_REQUIRED");
      }
      if (OPERATIONS_READ_PATHS.has(request.path) || correctionWrite || reopeningWrite) return operations(request, response, next);
      return (authentication ? writeRuntime.application : readRuntime.application)(request, response, next);
    });
    app.use((error, request, response, next) => { if (response.headersSent) return next(error);
      return send(response, 503, "RECOVERY_MAINTENANCE_REQUEST_FAILED"); });
    server = createTargetHttpServer({ runtime: { app, securityConfig: securityFoundations.config, services: writeRuntime.services,
      socketRooms: { ...authenticatedRooms, middleware(socket, next) { try { held(); } catch { return next(new Error("Recovery maintenance is unavailable.")); }
        return authenticatedRooms.middleware(socket, next); } } } });
    const address = await server.listen({ host: "127.0.0.1", port: 0 }); started = true;
    assertSources();
    let closing;
    async function finish() {
      let result;
      try {
        await server.close();
        held(); assertSources(); assertCorrectionRecords(); assertReopeningRecord();
        for (const session of writer.prepare("SELECT * FROM sessions WHERE status='active' ORDER BY id").all()) {
          const user = writer.prepare("SELECT * FROM users WHERE id=?").get(session.user_id);
          writeRuntime.services.account.signOut.signOut({ session, user });
        }
        const after = readRows(reader), authenticationChanges = verifyAuthenticationChanges(before, after);
        if (observed.providerCalls !== 0 || observed.emailCalls !== 0 || observed.publications !== 0 ||
            reader.prepare("SELECT total_changes() n").get().n !== 0 || reader.pragma("foreign_key_check").length !== 0 ||
            !same(reader.pragma("integrity_check"), [{ integrity_check: "ok" }] )) fail("RECOVERY_MAINTENANCE_POSTCHECK_FAILED");
        held(); assertSources();
        result = { reportVersion: 1, status: "isolated-maintenance-session-closed-held", recoveryId: reviewed.recoveryId,
          recoveryEpoch: heldEpoch, candidateReviewChecksum: reviewed.reportChecksum, sourcePlaintextSha256: digests[0],
          beforeSnapshots: snapshots(before), afterSnapshots: snapshots(after), authenticationChanges, observed,
          sourcesUnchanged: true, featureReaderWrites: 0, activeSessions: 0, originalHistory: "unchanged", jobsAndPreviousMessages: "unchanged-and-held",
          correctionReviews: [...correctionRecords.values()].map(({ fileSha256, receipt }) => ({ fileSha256,
            reportChecksum: receipt.reportChecksum, decisionChecksum: receipt.decisionChecksum, trackedFindingCount: receipt.trackedFindingCount })),
          reopeningCopies: reopeningResult ? [{ reportChecksum: reopeningResult.receipt.reportChecksum,
            reopeningPlaintextSha256: reopeningResult.receipt.reopeningPlaintextSha256 }] : [],
          currentOperatorApproval: false, completeLossWindowEvidence: false, activationReady: false, executable: false };
      } finally {
        if (reader?.open) reader.close(); if (writer?.open) writer.close();
      }
      const report = { ...result, verificationCopyPlaintextSha256: hash(fs.readFileSync(databasePath)) };
      const receipt = { ...report, reportChecksum: hash(canonicalize(report)) };
      fs.writeFileSync(path.join(output, "maintenance-session.json"), canonicalize(receipt) + "\n", { flag: "wx", mode: 0o600 });
      return Object.freeze(receipt);
    }
    return Object.freeze({ baseUrl: `http://127.0.0.1:${address.port}`, databasePath, initialReviewChecksum: reviewed.reportChecksum,
      inspectConnections() { return [...server.io.sockets.sockets.values()].map(socket => ({ id: socket.id, rooms: [...socket.rooms].sort() })); },
      close() { if (!closing) closing = finish(); return closing; } });
  } catch (error) {
    try {
      if (server) await server.close();
      if (reader?.open) reader.close(); if (writer?.open) writer.close();
      if (output !== null && !started) {
        if (!inside(physicalRoot, fs.realpathSync(output)) || fs.lstatSync(output).isSymbolicLink()) fail("RECOVERY_MAINTENANCE_CLEANUP_FAILED");
        fs.rmSync(output, { recursive: true, force: false });
      }
    } catch { fail("RECOVERY_MAINTENANCE_CLEANUP_FAILED"); }
    if (error instanceof RecoveryMaintenanceError) throw error;
    fail("RECOVERY_MAINTENANCE_START_FAILED");
  }
}
module.exports = { RecoveryMaintenanceError, startRecoveryMaintenanceSession };
