const express = require("express");

const {
  createLeagueWriteGate,
} = require("../application/services/operations/createLeagueWriteGate");

const {
  createAccountEmailDeliveryJob,
} = require("../application/services/accounts/createAccountEmailDeliveryJob");
const {
  createAccountEmailDeliveryService,
} = require("../application/services/accounts/createAccountEmailDeliveryService");
const {
  createLeagueActivityService,
} = require("../application/services/activity/createLeagueActivityService");
const {
  createLeagueOutboxPublicationService,
} = require("../application/services/activity/createLeagueOutboxPublicationService");
const {
  createNotificationService,
} = require("../application/services/activity/createNotificationService");
const {
  createAccountActionLinkRequestService,
} = require("../application/services/accounts/createAccountActionLinkRequestService");
const {
  createAccountActionTokenService,
} = require("../application/services/accounts/createAccountActionTokenService");
const {
  createAccountDeactivationService,
} = require("../application/services/accounts/createAccountDeactivationService");
const {
  createAccountReactivationService,
} = require("../application/services/accounts/createAccountReactivationService");
const {
  createAccountProfileService,
} = require("../application/services/accounts/createAccountProfileService");
const {
  createAdministratorCredentialSetupService,
} = require("../application/services/accounts/createAdministratorCredentialSetupService");
const {
  createAuthenticationRateLimiter,
} = require("../application/services/accounts/createAuthenticationRateLimiter");
const {
  createCredentialAuthenticationService,
} = require("../application/services/accounts/createCredentialAuthenticationService");
const {
  createEmailVerificationRequestService,
} = require("../application/services/accounts/createEmailVerificationRequestService");
const {
  createEmailVerificationService,
} = require("../application/services/accounts/createEmailVerificationService");
const {
  createPasswordChangeService,
} = require("../application/services/accounts/createPasswordChangeService");
const {
  createPasswordResetService,
} = require("../application/services/accounts/createPasswordResetService");
const {
  createSelfServiceAccountService,
} = require("../application/services/accounts/createSelfServiceAccountService");
const {
  createSessionService,
} = require("../application/services/accounts/createSessionService");
const {
  createSignInService,
} = require("../application/services/accounts/createSignInService");
const {
  createSignOutService,
} = require("../application/services/accounts/createSignOutService");
const {
  createAuctionService,
} = require("../application/services/auctions/createAuctionService");
const {
  createAuctionResolutionDecisionService,
} = require("../application/services/auctions/createAuctionResolutionDecisionService");
const {
  createAuctionResolutionService,
} = require("../application/services/auctions/createAuctionResolutionService");
const {
  createMatchupIntegrationService,
} = require("../application/services/matchups/createMatchupIntegrationService");
const {
  createMatchupLegalityService,
} = require("../application/services/matchups/createMatchupLegalityService");
const {
  createMatchupLockService,
} = require("../application/services/matchups/createMatchupLockService");
const {
  createMatchupOccurrenceHandlers,
} = require("../application/services/matchups/createMatchupOccurrenceHandlers");
const {
  createMatchupRecoveryService,
} = require("../application/services/matchups/createMatchupRecoveryService");
const {
  createMatchupResultService,
} = require("../application/services/matchups/createMatchupResultService");
const {
  createMatchupScheduleService,
} = require("../application/services/matchups/createMatchupScheduleService");
const {
  createMatchupScoringService,
} = require("../application/services/matchups/createMatchupScoringService");
const {
  createMatchupStandingsService,
} = require("../application/services/matchups/createMatchupStandingsService");
const {
  createMatchupWeekService,
} = require("../application/services/matchups/createMatchupWeekService");
const {
  createPlayerReadService,
} = require("../application/services/players/createPlayerReadService");
const {
  createLeaguePlayerReadService,
} = require("../application/services/players/createLeaguePlayerReadService");
const {
  createTargetStatisticsService,
} = require("../application/services/statistics/createTargetStatisticsService");
const {
  createTradeProposalFoundationService,
} = require("../application/services/trades/createTradeProposalFoundationService");
const {
  createTradeReadService,
} = require("../application/services/trades/createTradeReadService");
const {
  createTradeProposalService,
} = require("../application/services/trades/createTradeProposalService");
const {
  createRespondToTradeProposalService,
} = require("../application/services/trades/respondToTradeProposalService");
const {
  createPreviewTradeAcceptanceService,
} = require("../application/services/trades/previewTradeAcceptanceService");
const {
  createAcceptTradeProposalService,
} = require("../application/services/trades/acceptTradeProposalService");
const {
  createTradeReversalService,
} = require("../application/services/trades/createTradeReversalService");
const {
  createExpireTradeProposalsJob,
} = require("../jobs/definitions/expireTradeProposals");
const {
  createResolveTargetAuctionsJob,
} = require("../jobs/definitions/resolveTargetAuctions");
const {
  createPublishLeagueOutboxJob,
} = require("../jobs/definitions/publishLeagueOutbox");
const {
  createRunMatchupOccurrencesJob,
} = require("../jobs/definitions/runMatchupOccurrences");
const {
  createSocketAuthorizationService,
} = require("../application/services/authorization/createSocketAuthorizationService");
const {
  createLeagueAuthorizationService,
} = require("../application/services/authorization/requireLeagueAuthority");
const {
  createPlatformAuthorizationService,
} = require("../application/services/authorization/requirePlatformAdministrator");
const {
  createTeamAuthorizationService,
} = require("../application/services/authorization/requireTeamManagerAuthority");
const {
  createAdministrativeLeagueService,
} = require("../application/services/leagues/createAdministrativeLeagueService");
const {
  createCommissionerAssignmentService,
} = require("../application/services/leagues/createCommissionerAssignmentService");
const {
  createCommissionerCorrectionService,
} = require("../application/services/leagues/createCommissionerCorrectionService");
const {
  createLeagueInvitationService,
} = require("../application/services/leagues/createLeagueInvitationService");
const {
  createLeagueReadService,
} = require("../application/services/leagues/createLeagueReadService");
const {
  createLeagueMembershipService,
} = require("../application/services/leagues/createLeagueMembershipService");
const {
  createPublicRosterService,
} = require("../application/services/leagues/createPublicRosterService");
const {
  createTeamCreationService,
} = require("../application/services/leagues/createTeamCreationService");
const {
  createTeamManagerAssignmentService,
} = require("../application/services/leagues/createTeamManagerAssignmentService");
const {
  createTeamProfileService,
} = require("../application/services/leagues/createTeamProfileService");
const {
  createTeamReadService,
} = require("../application/services/leagues/createTeamReadService");
const {
  createTeamWorkspaceService,
} = require("../application/services/leagues/createTeamWorkspaceService");
const {
  createRosterActionService,
} = require("../application/services/leagues/createRosterActionService");
const {
  assertMigrationCompatibility,
  discoverMigrations,
} = require("../infrastructure/database/migrate");
const {
  openDatabase,
} = require("../infrastructure/database/connection");
const {
  createConfiguredAccountEmailAdapter,
} = require("../infrastructure/email/createConfiguredAccountEmailAdapter");
const {
  PROVIDER_NAME: SPORTSDATAIO_PROVIDER_NAME,
  MINIMUM_LAST_SEASON_STATISTICS_PLAYER_COUNT,
  createSportsDataIoLastSeasonStatisticsProvider,
  createSportsDataIoNhlAdapter,
} = require("../infrastructure/sportsdataio/SportsDataIoNhlAdapter");
const {
  createSqliteAccountActionTokenRepository,
} = require("../infrastructure/persistence/sqlite/SqliteAccountActionTokenRepository");
const {
  createSqliteAuctionBidRepository,
} = require("../infrastructure/persistence/sqlite/SqliteAuctionBidRepository");
const {
  createSqliteAuctionRepository,
} = require("../infrastructure/persistence/sqlite/SqliteAuctionRepository");
const {
  createSqliteAuctionResolutionRepository,
} = require("../infrastructure/persistence/sqlite/SqliteAuctionResolutionRepository");
const {
  createSqliteBuyoutRepository,
} = require("../infrastructure/persistence/sqlite/SqliteBuyoutRepository");
const {
  createSqliteAuthenticationRateLimitRepository,
} = require("../infrastructure/persistence/sqlite/SqliteAuthenticationRateLimitRepository");
const {
  createSqliteCommissionerAssignmentRepository,
} = require("../infrastructure/persistence/sqlite/SqliteCommissionerAssignmentRepository");
const {
  createSqliteCommissionerCorrectionRepository,
} = require("../infrastructure/persistence/sqlite/SqliteCommissionerCorrectionRepository");
const {
  createSqliteCredentialRepository,
} = require("../infrastructure/persistence/sqlite/SqliteCredentialRepository");
const {
  createSqliteLeagueAccessRepository,
} = require("../infrastructure/persistence/sqlite/SqliteLeagueAccessRepository");
const {
  createSqliteLeagueCreationRepository,
} = require("../infrastructure/persistence/sqlite/SqliteLeagueCreationRepository");
const {
  createSqliteLeagueInvitationRepository,
} = require("../infrastructure/persistence/sqlite/SqliteLeagueInvitationRepository");
const {
  createSqliteLeagueActivityRepository,
} = require("../infrastructure/persistence/sqlite/SqliteLeagueActivityRepository");
const {
  createSqliteLeagueOutboxRepository,
} = require("../infrastructure/persistence/sqlite/SqliteLeagueOutboxRepository");
const {
  createSqliteMatchupReadRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupReadRepository");
const {
  createSqliteMatchupJobRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupJobRepository");
const {
  createSqliteMatchupLockRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupLockRepository");
const {
  createSqliteMatchupRecoveryRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupRecoveryRepository");
const {
  createSqliteMatchupResultRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupResultRepository");
const {
  createSqliteMatchupScheduleRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupScheduleRepository");
const {
  createSqliteMatchupScoringRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupScoringRepository");
const {
  createSqliteMatchupStandingsRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupStandingsRepository");
const {
  createSqliteMatchupWeekRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupWeekRepository");
const {
  createSqliteNotificationRepository,
} = require("../infrastructure/persistence/sqlite/SqliteNotificationRepository");
const {
  createSqliteOutboxEventRepository,
} = require("../infrastructure/persistence/sqlite/SqliteOutboxEventRepository");
const {
  createSqlitePlatformRoleRepository,
} = require("../infrastructure/persistence/sqlite/SqlitePlatformRoleRepository");
const {
  createSqlitePlayerRepository,
} = require("../infrastructure/persistence/sqlite/SqlitePlayerRepository");
const {
  createSqliteLeaguePlayerReadRepository,
} = require("../infrastructure/persistence/sqlite/SqliteLeaguePlayerReadRepository");
const {
  createSqlitePublicRosterRepository,
} = require("../infrastructure/persistence/sqlite/SqlitePublicRosterRepository");
const {
  createSqliteRepositoryContext,
} = require("../infrastructure/persistence/sqlite/createSqliteRepositoryContext");
const {
  createSqliteSecurityAuditRepository,
} = require("../infrastructure/persistence/sqlite/SqliteSecurityAuditRepository");
const {
  createSqliteSessionRepository,
} = require("../infrastructure/persistence/sqlite/SqliteSessionRepository");
const {
  createSqliteStatisticsRepository,
} = require("../infrastructure/persistence/sqlite/SqliteStatisticsRepository");
const {
  createSqliteTeamAuthorityRepository,
} = require("../infrastructure/persistence/sqlite/SqliteTeamAuthorityRepository");
const {
  createSqliteTeamCreationRepository,
} = require("../infrastructure/persistence/sqlite/SqliteTeamCreationRepository");
const {
  createSqliteTeamManagerAssignmentRepository,
} = require("../infrastructure/persistence/sqlite/SqliteTeamManagerAssignmentRepository");
const {
  createSqliteTeamProfileRepository,
} = require("../infrastructure/persistence/sqlite/SqliteTeamProfileRepository");
const {
  createSqliteTeamReadRepository,
} = require("../infrastructure/persistence/sqlite/SqliteTeamReadRepository");
const {
  createSqliteTeamWorkspaceRepository,
} = require("../infrastructure/persistence/sqlite/SqliteTeamWorkspaceRepository");
const {
  createSqliteRosterMovementRepository,
} = require("../infrastructure/persistence/sqlite/SqliteRosterMovementRepository");
const {
  createSqliteTradeProposalRepository,
} = require("../infrastructure/persistence/sqlite/SqliteTradeProposalRepository");
const {
  createSqliteTradeExpiryRepository,
} = require("../infrastructure/persistence/sqlite/SqliteTradeExpiryRepository");
const {
  createSqliteTradeReversalRepository,
} = require("../infrastructure/persistence/sqlite/SqliteTradeReversalRepository");
const {
  createSqliteUserRepository,
} = require("../infrastructure/persistence/sqlite/SqliteUserRepository");
const {
  createSocketIoInvalidationPublisher,
} = require("../infrastructure/socket/createSocketIoInvalidationPublisher");
const {
  createActionTokenDeliveryEnvelope,
} = require("../infrastructure/security/createActionTokenDeliveryEnvelope");
const {
  createKeyedPrivacyDigest,
} = require("../infrastructure/security/createKeyedPrivacyDigest");
const {
  createOpaqueActionTokens,
} = require("../infrastructure/security/createOpaqueActionTokens");
const {
  createScryptPasswordHasher,
} = require("../infrastructure/security/createScryptPasswordHasher");
const {
  createSessionSecrets,
} = require("../infrastructure/security/createSessionSecrets");
const {
  createAccountRegistrationRouter,
} = require("../transport/http/createAccountRegistrationRouter");
const {
  createAccountProfileRouter,
} = require("../transport/http/createAccountProfileRouter");
const {
  createAccountSessionRouter,
} = require("../transport/http/createAccountSessionRouter");
const {
  createAuctionRouter,
} = require("../transport/http/createAuctionRouter");
const {
  createActivityNotificationRouter,
} = require("../transport/http/createActivityNotificationRouter");
const {
  createCommissionerAssignmentRouter,
} = require("../transport/http/createCommissionerAssignmentRouter");
const {
  createCommissionerCorrectionRouter,
} = require("../transport/http/createCommissionerCorrectionRouter");
const {
  createLeagueInvitationRouter,
} = require("../transport/http/createLeagueInvitationRouter");
const {
  createLeagueReadRouter,
} = require("../transport/http/createLeagueReadRouter");
const {
  createLeagueMembershipRouter,
} = require("../transport/http/createLeagueMembershipRouter");
const {
  createMatchupRouter,
} = require("../transport/http/createMatchupRouter");
const {
  createPlatformAdministrationRouter,
} = require("../transport/http/createPlatformAdministrationRouter");
const {
  createPlayerRouter,
} = require("../transport/http/createPlayerRouter");
const {
  createPublicRosterRouter,
} = require("../transport/http/createPublicRosterRouter");
const {
  createRosterActionRouter,
} = require("../transport/http/createRosterActionRouter");
const {
  createTargetRequestSecurity,
} = require("../transport/http/createTargetRequestSecurity");
const {
  createTeamManagerAssignmentRouter,
} = require("../transport/http/createTeamManagerAssignmentRouter");
const {
  createTeamProfileRouter,
} = require("../transport/http/createTeamProfileRouter");
const {
  createTeamRouter,
} = require("../transport/http/createTeamRouter");
const {
  createTradeRecoveryRouter,
} = require("../transport/http/createTradeRecoveryRouter");
const {
  createTradeRouter,
} = require("../transport/http/createTradeRouter");
const {
  createSessionCookie,
} = require("../transport/http/sessionCookie");
const {
  createAuthenticatedSocketRooms,
} = require("../transport/socket/createAuthenticatedSocketRooms");

const TARGET_ENDPOINTS = Object.freeze([
  ["POST", "/api/v1/accounts", "accountRegistration"],
  ["POST", "/api/v1/accounts/email-verifications", "accountRegistration"],
  ["POST", "/api/v1/accounts/email-verification-requests", "accountRegistration"],
  ["POST", "/api/v1/accounts/credential-setups", "accountRegistration"],
  ["POST", "/api/v1/session", "accountSession"],
  ["GET", "/api/v1/session", "accountSession"],
  ["DELETE", "/api/v1/session", "accountSession"],
  ["POST", "/api/v1/session/password", "accountSession"],
  ["GET", "/api/v1/account", "accountProfile"],
  ["PATCH", "/api/v1/account", "accountProfile"],
  ["POST", "/api/v1/password-reset-requests", "accountSession"],
  ["POST", "/api/v1/password-resets", "accountSession"],
  ["POST", "/api/v1/account/deactivation", "accountSession"],
  ["POST", "/api/v1/account/reactivation-requests", "accountSession"],
  ["POST", "/api/v1/account/reactivations", "accountSession"],
  ["GET", "/api/v1/players", "player"],
  ["GET", "/api/v1/players/:playerId", "player"],
  ["GET", "/api/v1/leagues/:leagueId/players", "player"],
  ["GET", "/api/v1/leagues/:leagueId/players/:playerId", "player"],
  ["POST", "/api/v1/admin/leagues", "platformAdministration"],
  ["GET", "/api/v1/admin/users", "platformAdministration"],
  [
    "POST",
    "/api/v1/admin/leagues/:leagueId/commissioner-assignments",
    "commissionerAssignment",
  ],
  [
    "GET",
    "/api/v1/commissioner-assignments/:assignmentId",
    "commissionerAssignment",
  ],
  [
    "POST",
    "/api/v1/commissioner-assignments/:assignmentId/accept",
    "commissionerAssignment",
  ],
  [
    "POST",
    "/api/v1/commissioner-assignments/:assignmentId/decline",
    "commissionerAssignment",
  ],
  ["GET", "/api/v1/leagues", "leagueRead"],
  ["GET", "/api/v1/leagues/:leagueId", "leagueRead"],
  ["GET", "/api/v1/leagues/:leagueId/settings", "leagueRead"],
  ["GET", "/api/v1/leagues/:leagueId/memberships", "leagueRead"],
  ["GET", "/api/v1/leagues/:leagueId/invitable-users", "leagueRead"],
  [
    "DELETE",
    "/api/v1/leagues/:leagueId/memberships/:membershipId",
    "leagueMembership",
  ],
  ["GET", "/api/v1/leagues/:leagueId/seasons", "leagueRead"],
  [
    "GET",
    "/api/v1/leagues/:leagueId/activity",
    "activityNotification",
  ],
  ["GET", "/api/v1/notifications", "activityNotification"],
  [
    "POST",
    "/api/v1/notifications/:notificationId/read",
    "activityNotification",
  ],
  ["POST", "/api/v1/notifications/read-all", "activityNotification"],
  ["GET", "/api/v1/leagues/:leagueId/auctions", "auction"],
  [
    "GET",
    "/api/v1/leagues/:leagueId/commissioner/roster-workspace",
    "commissionerCorrection",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/commissioner/roster-additions/previews",
    "commissionerCorrection",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/commissioner/roster-additions",
    "commissionerCorrection",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/commissioner/roster-removals/previews",
    "commissionerCorrection",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/commissioner/roster-removals",
    "commissionerCorrection",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/commissioner/roster-corrections/previews",
    "commissionerCorrection",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/commissioner/roster-corrections",
    "commissionerCorrection",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/commissioner/contract-corrections/previews",
    "commissionerCorrection",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/commissioner/contract-corrections",
    "commissionerCorrection",
  ],
  ["POST", "/api/v1/leagues/:leagueId/auctions", "auction"],
  ["GET", "/api/v1/leagues/:leagueId/auctions/:auctionId", "auction"],
  [
    "PUT",
    "/api/v1/leagues/:leagueId/auctions/:auctionId/bids/mine",
    "auction",
  ],
  [
    "PATCH",
    "/api/v1/leagues/:leagueId/auctions/:auctionId/bids/:bidId",
    "auction",
  ],
  ["GET", "/api/v1/leagues/:leagueId/trades", "trade"],
  ["POST", "/api/v1/leagues/:leagueId/trades", "trade"],
  ["GET", "/api/v1/leagues/:leagueId/trades/:tradeId", "trade"],
  [
    "GET",
    "/api/v1/leagues/:leagueId/trades/:tradeId/acceptance-preview",
    "trade",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/trades/:tradeId/accept",
    "trade",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/trades/:tradeId/decline",
    "trade",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/trades/:tradeId/cancel",
    "trade",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/trades/:tradeId/reversal-preview",
    "tradeRecovery",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/trades/:tradeId/reverse",
    "tradeRecovery",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/trades/:tradeId/correction-required",
    "tradeRecovery",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/seasons/:seasonId/matchup-weeks",
    "matchup",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/seasons/:seasonId/matchup-weeks/current",
    "matchup",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/seasons/:seasonId/matchup-weeks/:weekId",
    "matchup",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/seasons/:seasonId/matchup-weeks/:weekId/matchups/:matchupId",
    "matchup",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/seasons/:seasonId/standings",
    "matchup",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/seasons/:seasonId/matchup-schedules",
    "matchup",
  ],
  [
    "PATCH",
    "/api/v1/leagues/:leagueId/seasons/:seasonId/matchup-weeks/:weekId",
    "matchup",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/seasons/:seasonId/matchup-results/:resultId/corrections",
    "matchup",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/seasons/:seasonId/standings/rebuilds",
    "matchup",
  ],
  ["POST", "/api/v1/leagues/:leagueId/invitations", "leagueInvitation"],
  [
    "GET",
    "/api/v1/league-invitations/:invitationId",
    "leagueInvitation",
  ],
  [
    "POST",
    "/api/v1/league-invitations/:invitationId/accept",
    "leagueInvitation",
  ],
  [
    "POST",
    "/api/v1/league-invitations/:invitationId/decline",
    "leagueInvitation",
  ],
  ["GET", "/api/v1/leagues/:leagueId/teams", "team"],
  ["POST", "/api/v1/leagues/:leagueId/teams", "team"],
  ["GET", "/api/v1/leagues/:leagueId/teams/:teamId", "team"],
  ["GET", "/api/v1/leagues/:leagueId/teams/:teamId/roster", "team"],
  [
    "PUT",
    "/api/v1/leagues/:leagueId/teams/:teamId/roster-display-order",
    "team",
  ],
  [
    "PUT",
    "/api/v1/leagues/:leagueId/teams/:teamId/roster/:ownershipId/trade-block",
    "team",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/teams/:teamId/roster/:ownershipId/move",
    "rosterAction",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/teams/:teamId/roster/:ownershipId/move-to-ir",
    "rosterAction",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/teams/:teamId/contracts/:contractId/buyout",
    "rosterAction",
  ],
  [
    "GET",
    "/api/v1/public/leagues/:leagueId/teams/:teamId/roster",
    "publicRoster",
  ],
  ["PATCH", "/api/v1/leagues/:leagueId/teams/:teamId", "teamProfile"],
  [
    "GET",
    "/api/v1/leagues/:leagueId/teams/:teamId/logo",
    "teamProfile",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/teams/:teamId/manager-assignment",
    "teamManagerAssignment",
  ],
  [
    "DELETE",
    "/api/v1/leagues/:leagueId/teams/:teamId/manager-assignment",
    "teamManagerAssignment",
  ],
  [
    "GET",
    "/api/v1/team-manager-assignments/:assignmentId",
    "teamManagerAssignment",
  ],
  [
    "POST",
    "/api/v1/team-manager-assignments/:assignmentId/accept",
    "teamManagerAssignment",
  ],
  [
    "POST",
    "/api/v1/team-manager-assignments/:assignmentId/decline",
    "teamManagerAssignment",
  ],
].map(([method, path, routerKey]) =>
  Object.freeze({ method, path, routerKey })
));

const TARGET_ROUTER_KEYS = Object.freeze(
  [...new Set(TARGET_ENDPOINTS.map(({ routerKey }) => routerKey))].sort()
);

function compilePath(path) {
  const expression = path
    .split("/")
    .map((segment) =>
      segment.startsWith(":")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
    .join("/");
  return new RegExp(`^${expression}$`);
}

const COMPILED_TARGET_ENDPOINTS = TARGET_ENDPOINTS.map((endpoint) =>
  Object.freeze({ ...endpoint, matcher: compilePath(endpoint.path) })
);

function selectTargetRouterKey(method, requestPath, requestedMethod) {
  if (
    typeof method !== "string" ||
    typeof requestPath !== "string" ||
    !requestPath.startsWith("/")
  ) {
    return null;
  }
  const canonicalMethod = method.toUpperCase();
  const preflightMethod =
    canonicalMethod === "OPTIONS" && typeof requestedMethod === "string"
      ? requestedMethod.toUpperCase()
      : null;
  const effectiveMethod = preflightMethod || canonicalMethod;
  const exact = COMPILED_TARGET_ENDPOINTS.find(
    (endpoint) =>
      endpoint.method === effectiveMethod && endpoint.matcher.test(requestPath)
  );
  if (exact) return exact.routerKey;
  if (canonicalMethod !== "OPTIONS") return null;
  return (
    COMPILED_TARGET_ENDPOINTS.find((endpoint) =>
      endpoint.matcher.test(requestPath)
    )?.routerKey || null
  );
}

function createTargetApplication({
  routers,
  leagueWriteGate,
  expressModule = express,
} = {}) {
  if (
    !routers ||
    typeof routers !== "object" ||
    Array.isArray(routers) ||
    Object.keys(routers).length !== TARGET_ROUTER_KEYS.length ||
    Object.keys(routers).some((key) => !TARGET_ROUTER_KEYS.includes(key))
  ) {
    throw new TypeError("target runtime requires the exact target router set");
  }
  for (const routerKey of TARGET_ROUTER_KEYS) {
    if (typeof routers[routerKey] !== "function") {
      throw new TypeError(`target runtime requires the ${routerKey} router`);
    }
  }
  if (!expressModule || typeof expressModule !== "function") {
    throw new TypeError("target runtime requires Express");
  }

  const app = expressModule();
  app.disable("x-powered-by");
  if (leagueWriteGate !== undefined) {
    if (typeof leagueWriteGate !== "function") {
      throw new TypeError("target runtime requires a league write gate");
    }
    app.use((request, response, next) => {
      const routerKey = selectTargetRouterKey(
        request.method,
        request.path,
        request.get("access-control-request-method")
      );
      if (!routerKey) return next();
      return leagueWriteGate(request, response, next);
    });
  }
  app.use((request, response, next) => {
    const routerKey = selectTargetRouterKey(
      request.method,
      request.path,
      request.get("access-control-request-method")
    );
    if (!routerKey) return next();
    return routers[routerKey](request, response, next);
  });
  return app;
}

function requireConfiguredSecret(secretSlot, description) {
  if (
    !secretSlot ||
    secretSlot.configured !== true ||
    typeof secretSlot.value !== "string" ||
    !Number.isSafeInteger(secretSlot.keyVersion) ||
    secretSlot.keyVersion < 1
  ) {
    throw new TypeError(`target runtime requires ${description}`);
  }
  return secretSlot;
}

function createTargetRepositories({ database } = {}) {
  const context = createSqliteRepositoryContext({ database });
  return Object.freeze({
    context,
    actionTokens: createSqliteAccountActionTokenRepository({ database }),
    auctionBids: createSqliteAuctionBidRepository({ database }),
    auctionResolutions: createSqliteAuctionResolutionRepository({ database }),
    auctions: createSqliteAuctionRepository({ database }),
    audit: createSqliteSecurityAuditRepository({ database }),
    buyouts: createSqliteBuyoutRepository({ database }),
    commissionerAssignments: createSqliteCommissionerAssignmentRepository({
      database,
    }),
    commissionerCorrections: createSqliteCommissionerCorrectionRepository({
      database,
    }),
    credentials: createSqliteCredentialRepository({ database }),
    leagueActivity: createSqliteLeagueActivityRepository({ database }),
    leagueAccess: createSqliteLeagueAccessRepository({ database }),
    leagueCreation: createSqliteLeagueCreationRepository({ database }),
    leagueInvitations: createSqliteLeagueInvitationRepository({ database }),
    leagueOutbox: createSqliteLeagueOutboxRepository({ database }),
    matchupJobs: createSqliteMatchupJobRepository({ database }),
    matchupLocks: createSqliteMatchupLockRepository({ database }),
    matchupRead: createSqliteMatchupReadRepository({ database }),
    matchupRecovery: createSqliteMatchupRecoveryRepository({ database }),
    matchupResults: createSqliteMatchupResultRepository({ database }),
    matchupSchedule: createSqliteMatchupScheduleRepository({ database }),
    matchupScoring: createSqliteMatchupScoringRepository({ database }),
    matchupStandings: createSqliteMatchupStandingsRepository({ database }),
    matchupWeeks: createSqliteMatchupWeekRepository({ database }),
    notifications: createSqliteNotificationRepository({ database }),
    outbox: createSqliteOutboxEventRepository({ database }),
    leaguePlayers: createSqliteLeaguePlayerReadRepository({ database }),
    players: createSqlitePlayerRepository({ database }),
    platformRoles: createSqlitePlatformRoleRepository({ database }),
    publicRoster: createSqlitePublicRosterRepository({ database }),
    rateLimits: createSqliteAuthenticationRateLimitRepository({ database }),
    rosterMovements: createSqliteRosterMovementRepository({ database }),
    sessions: createSqliteSessionRepository({ database }),
    statistics: createSqliteStatisticsRepository({ database }),
    teamAuthority: createSqliteTeamAuthorityRepository({ database }),
    teamCreation: createSqliteTeamCreationRepository({ database }),
    teamManagerAssignments: createSqliteTeamManagerAssignmentRepository({
      database,
    }),
    teamProfiles: createSqliteTeamProfileRepository({ database }),
    teamRead: createSqliteTeamReadRepository({ database }),
    teamWorkspace: createSqliteTeamWorkspaceRepository({ database }),
    tradeProposals: createSqliteTradeProposalRepository({ database }),
    tradeExpiries: createSqliteTradeExpiryRepository({ database }),
    tradeRecovery: createSqliteTradeReversalRepository({ database }),
    users: createSqliteUserRepository({ database }),
  });
}

function createTargetServices({
  repositories,
  securityFoundations,
  currentSeason,
  passwordHasher: suppliedPasswordHasher,
  passwordInspector,
  leagueInvalidationPublisher,
  emailAdapter,
  emailFetchImplementation,
  emailJobOptions,
  sportsDataIoNhl = Object.freeze({ enabled: false }),
  sportsDataIoFetchImplementation,
} = {}) {
  const { config, clock, secureRandom, logger } = securityFoundations || {};
  if (!config || !clock || !secureRandom || !logger) {
    throw new TypeError("target runtime requires security foundations");
  }
  const rateLimitKey = requireConfiguredSecret(
    config.rateLimitKey,
    "a configured rate-limit key"
  );
  const auditMetadataKey = requireConfiguredSecret(
    config.auditMetadataKey,
    "a configured audit-metadata key"
  );
  const deliveryKey = requireConfiguredSecret(
    config.actionTokenDeliveryKey,
    "a configured action-token delivery key"
  );
  if (
    suppliedPasswordHasher !== undefined &&
    (
      typeof suppliedPasswordHasher?.hash !== "function" ||
      typeof suppliedPasswordHasher?.verify !== "function"
    )
  ) {
    throw new TypeError("target runtime requires a valid password hasher");
  }
  const passwordHasher = suppliedPasswordHasher ||
    createScryptPasswordHasher({ secureRandom });
  const sessionSecrets = createSessionSecrets({ secureRandom });
  const opaqueActionTokens = createOpaqueActionTokens({ secureRandom });
  const deliveryEnvelope = createActionTokenDeliveryEnvelope({
    encodedKey: deliveryKey.value,
    keyVersion: deliveryKey.keyVersion,
    secureRandom,
  });
  const resolvedEmailAdapter =
    emailAdapter === undefined
      ? createConfiguredAccountEmailAdapter({
          emailConfig: config.email,
          fetchImplementation: emailFetchImplementation,
        })
      : emailAdapter;
  const emailDeliveryService = resolvedEmailAdapter
    ? createAccountEmailDeliveryService({
        outboxRepository: repositories.outbox,
        userRepository: repositories.users,
        deliveryEnvelope,
        emailAdapter: resolvedEmailAdapter,
        clock,
        publicFrontendOrigin: config.publicFrontendOrigin,
      })
    : null;
  const accountEmail = Object.freeze({
    adapter: resolvedEmailAdapter,
    deliveryService: emailDeliveryService,
    job: emailDeliveryService
      ? createAccountEmailDeliveryJob({
          deliveryService: emailDeliveryService,
          logger,
          ...emailJobOptions,
        })
      : null,
  });
  const rateLimitPrivacyDigest = createKeyedPrivacyDigest({
    secretSlot: rateLimitKey,
    purpose: "rate_limit_bucket",
  });
  const auditPrivacyDigest = createKeyedPrivacyDigest({
    secretSlot: auditMetadataKey,
    purpose: "audit_metadata",
  });
  const sessionService = createSessionService({
    userRepository: repositories.users,
    sessionRepository: repositories.sessions,
    sessionSecrets,
    clock,
    secureRandom,
  });
  const actionTokenService = createAccountActionTokenService({
    repository: repositories.actionTokens,
    opaqueTokens: opaqueActionTokens,
    clock,
    secureRandom,
  });
  const credentialAuthenticationService =
    createCredentialAuthenticationService({
      userRepository: repositories.users,
      credentialRepository: repositories.credentials,
      passwordHasher,
      passwordInspector,
    });
  const rateLimiter = createAuthenticationRateLimiter({
    repository: repositories.rateLimits,
    privacyDigest: rateLimitPrivacyDigest,
    clock,
    secureRandom,
  });
  const platformAuthorization = createPlatformAuthorizationService({
    userRepository: repositories.users,
    platformRoleRepository: repositories.platformRoles,
  });
  const leagueAuthorization = createLeagueAuthorizationService({
    userRepository: repositories.users,
    leagueAccessRepository: repositories.leagueAccess,
    platformAuthorization,
  });
  const teamAuthorization = createTeamAuthorizationService({
    leagueAuthorization,
    teamAuthorityRepository: repositories.teamAuthority,
  });
  const leagueOutboxPublication = createLeagueOutboxPublicationService({
    repository: repositories.leagueOutbox,
    publisher: leagueInvalidationPublisher,
    clock,
  });
  const auctionResolutionDecision = createAuctionResolutionDecisionService({
    repository: repositories.auctionResolutions,
  });
  const auctionResolution = createAuctionResolutionService({
    repository: repositories.auctionResolutions,
    secureRandom,
  });
  const auctionResolutionJob = createResolveTargetAuctionsJob({
    repository: repositories.auctionResolutions,
    resolutionService: auctionResolution,
    clock,
    secureRandom,
    leaseOwner: secureRandom.id(),
    logger,
  });
  const tradeProposalExpiry = createExpireTradeProposalsJob({
    repository: repositories.tradeExpiries,
    clock,
    secureRandom,
    leaseOwner: secureRandom.id(),
    logger,
  });
  const outboxPublicationJob = createPublishLeagueOutboxJob({
    service: leagueOutboxPublication,
    logger,
  });
  const statisticsProvider = sportsDataIoNhl.enabled
    ? createSportsDataIoLastSeasonStatisticsProvider({
      adapter: createSportsDataIoNhlAdapter({
        apiKey: sportsDataIoNhl.apiKey,
        fetchImpl: sportsDataIoFetchImplementation,
        origin: sportsDataIoNhl.origin,
      }),
      seasonStart: sportsDataIoNhl.seasonStartYear,
    })
    : Object.freeze({
      async fetchRows() {
        const error = new Error(
          "SportsDataIO NHL import is disabled until staging configuration is complete."
        );
        error.code = "SPORTSDATAIO_NHL_IMPORT_DISABLED";
        throw error;
      },
    });
  const statistics = createTargetStatisticsService({
    repository: repositories.statistics,
    provider: statisticsProvider,
    nhlSeasonKey: sportsDataIoNhl.enabled
      ? sportsDataIoNhl.nhlSeasonKey
      : currentSeason.nhlSeasonKey,
    providerName: SPORTSDATAIO_PROVIDER_NAME,
    minimumPlayerCount: MINIMUM_LAST_SEASON_STATISTICS_PLAYER_COUNT,
    nowMs: () => clock.nowMs(),
    createId: () => secureRandom.id(),
  });
  const players = createPlayerReadService({
    activeUserAuthorization: leagueAuthorization,
    repository: repositories.players,
  });
  const leaguePlayers = createLeaguePlayerReadService({
    leagueAuthorization,
    playerRepository: repositories.players,
    leaguePlayerRepository: repositories.leaguePlayers,
  });
  const matchupSchedule = createMatchupScheduleService({
    repository: repositories.matchupSchedule,
    createId: () => secureRandom.id(),
  });
  const matchupWeeks = createMatchupWeekService({
    repository: repositories.matchupWeeks,
    createId: () => secureRandom.id(),
  });
  const matchupLock = createMatchupLockService({
    repository: repositories.matchupLocks,
    createId: () => secureRandom.id(),
  });
  const matchupLegality = createMatchupLegalityService({
    repository: repositories.matchupLocks,
    normalLockService: matchupLock,
    createId: () => secureRandom.id(),
  });
  const matchupScoring = createMatchupScoringService({
    repository: repositories.matchupScoring,
  });
  const matchupResults = createMatchupResultService({
    repository: repositories.matchupResults,
    scoringService: matchupScoring,
    createId: () => secureRandom.id(),
  });
  const matchupStandings = createMatchupStandingsService({
    repository: repositories.matchupStandings,
  });
  const matchupRecovery = createMatchupRecoveryService({
    repository: repositories.matchupRecovery,
    standingsService: matchupStandings,
    createId: () => secureRandom.id(),
  });
  const matchup = createMatchupIntegrationService({
    leagueAuthorization,
    readRepository: repositories.matchupRead,
    scheduleService: matchupSchedule,
    weekService: matchupWeeks,
    scoringService: matchupScoring,
    resultService: matchupResults,
    standingsService: matchupStandings,
    recoveryService: matchupRecovery,
    statisticsProviders: Object.freeze([
      SPORTSDATAIO_PROVIDER_NAME,
      "release_qa_fixture",
    ]),
    clock,
    createId: () => secureRandom.id(),
  });
  const matchupOccurrenceHandlers = createMatchupOccurrenceHandlers({
    statisticsService: statistics,
    readRepository: repositories.matchupRead,
    weekService: matchupWeeks,
    legalityService: matchupLegality,
    resultService: matchupResults,
  });
  const matchupOccurrenceJob = createRunMatchupOccurrencesJob({
    repository: repositories.matchupJobs,
    handlers: matchupOccurrenceHandlers,
    clock,
    secureRandom,
    leaseOwner: secureRandom.id(),
    logger,
  });

  const account = Object.freeze({
    profile: createAccountProfileService({
      activeUserAuthorization: leagueAuthorization,
      repositoryContext: repositories.context,
      userRepository: repositories.users,
      clock,
    }),
    registration: createSelfServiceAccountService({
      repositoryContext: repositories.context,
      userRepository: repositories.users,
      credentialRepository: repositories.credentials,
      actionTokenService,
      auditRepository: repositories.audit,
      outboxRepository: repositories.outbox,
      passwordHasher,
      deliveryEnvelope,
      clock,
      secureRandom,
      publicFrontendOrigin: config.publicFrontendOrigin,
    }),
    verification: createEmailVerificationService({
      actionTokenService,
      userRepository: repositories.users,
      sessionService,
      auditRepository: repositories.audit,
      outboxRepository: repositories.outbox,
      clock,
      secureRandom,
    }),
    verificationRequest: createEmailVerificationRequestService({
      userRepository: repositories.users,
      actionTokenService,
      auditRepository: repositories.audit,
      outboxRepository: repositories.outbox,
      deliveryEnvelope,
      clock,
      secureRandom,
      publicFrontendOrigin: config.publicFrontendOrigin,
    }),
    credentialSetup: createAdministratorCredentialSetupService({
      actionTokenService,
      userRepository: repositories.users,
      credentialRepository: repositories.credentials,
      passwordHasher,
      auditRepository: repositories.audit,
      outboxRepository: repositories.outbox,
      clock,
      secureRandom,
    }),
    signIn: createSignInService({
      credentialAuthenticationService,
      sessionService,
      auditRepository: repositories.audit,
      outboxRepository: repositories.outbox,
      rateLimiter,
      clock,
      secureRandom,
    }),
    signOut: createSignOutService({
      sessionService,
      auditRepository: repositories.audit,
      clock,
      secureRandom,
    }),
    passwordChange: createPasswordChangeService({
      repositoryContext: repositories.context,
      userRepository: repositories.users,
      credentialRepository: repositories.credentials,
      sessionService,
      passwordHasher,
      auditRepository: repositories.audit,
      outboxRepository: repositories.outbox,
      clock,
      secureRandom,
    }),
    passwordResetRequest: createAccountActionLinkRequestService({
      purpose: "password_reset",
      userRepository: repositories.users,
      actionTokenService,
      auditRepository: repositories.audit,
      outboxRepository: repositories.outbox,
      deliveryEnvelope,
      clock,
      secureRandom,
      publicFrontendOrigin: config.publicFrontendOrigin,
    }),
    passwordReset: createPasswordResetService({
      actionTokenService,
      userRepository: repositories.users,
      credentialRepository: repositories.credentials,
      sessionRepository: repositories.sessions,
      sessionService,
      passwordHasher,
      auditRepository: repositories.audit,
      outboxRepository: repositories.outbox,
      clock,
      secureRandom,
    }),
    deactivation: createAccountDeactivationService({
      repositoryContext: repositories.context,
      userRepository: repositories.users,
      credentialRepository: repositories.credentials,
      actionTokenService,
      sessionService,
      passwordHasher,
      auditRepository: repositories.audit,
      outboxRepository: repositories.outbox,
      clock,
      secureRandom,
    }),
    reactivationRequest: createAccountActionLinkRequestService({
      purpose: "self_reactivation",
      userRepository: repositories.users,
      actionTokenService,
      auditRepository: repositories.audit,
      outboxRepository: repositories.outbox,
      deliveryEnvelope,
      clock,
      secureRandom,
      publicFrontendOrigin: config.publicFrontendOrigin,
    }),
    reactivation: createAccountReactivationService({
      actionTokenService,
      userRepository: repositories.users,
      credentialRepository: repositories.credentials,
      passwordHasher,
      auditRepository: repositories.audit,
      outboxRepository: repositories.outbox,
      clock,
      secureRandom,
    }),
  });

  const league = Object.freeze({
    matchup,
    matchupLegality,
    matchupLock,
    matchupOccurrenceHandlers,
    matchupOccurrenceJob,
    matchupRecovery,
    matchupResults,
    matchupSchedule,
    matchupScoring,
    matchupStandings,
    matchupWeeks,
    activity: createLeagueActivityService({
      leagueAuthorization,
      repository: repositories.leagueActivity,
    }),
    auction: createAuctionService({
      leagueAuthorization,
      teamAuthorization,
      leagueAccessRepository: repositories.leagueAccess,
      auctionRepository: repositories.auctions,
      auctionBidRepository: repositories.auctionBids,
      clock,
      secureRandom,
    }),
    auctionResolutionDecision,
    auctionResolution,
    auctionResolutionJob,
    tradeProposalFoundation: createTradeProposalFoundationService({
      leagueAuthorization,
      teamAuthorization,
      repository: repositories.tradeProposals,
      clock,
      secureRandom,
    }),
    tradeRead: createTradeReadService({
      leagueAuthorization,
      repository: repositories.tradeProposals,
    }),
    tradeProposalCreation: createTradeProposalService({
      leagueAuthorization,
      teamAuthorization,
      repository: repositories.tradeProposals,
      clock,
      secureRandom,
    }),
    tradeProposalLifecycle: createRespondToTradeProposalService({
      leagueAuthorization,
      teamAuthorization,
      repository: repositories.tradeProposals,
      clock,
      secureRandom,
    }),
    tradeAcceptancePreview: createPreviewTradeAcceptanceService({
      leagueAuthorization,
      teamAuthorization,
      repository: repositories.tradeProposals,
      clock,
    }),
    tradeAcceptance: createAcceptTradeProposalService({
      leagueAuthorization,
      teamAuthorization,
      repository: repositories.tradeProposals,
      clock,
      secureRandom,
    }),
    tradeRecovery: createTradeReversalService({
      leagueAuthorization,
      repository: repositories.tradeRecovery,
      clock,
      secureRandom,
    }),
    tradeProposalExpiry,
    notifications: createNotificationService({
      leagueAuthorization,
      repository: repositories.notifications,
      clock,
    }),
    outboxPublication: leagueOutboxPublication,
    outboxPublicationJob,
    scheduledJobs: Object.freeze([
      Object.freeze({
        name: "auction_resolution",
        runner: auctionResolutionJob,
      }),
      Object.freeze({ name: "trade_expiry", runner: tradeProposalExpiry }),
      Object.freeze({
        name: "matchup_occurrences",
        runner: matchupOccurrenceJob,
      }),
      Object.freeze({ name: "league_outbox", runner: outboxPublicationJob }),
    ]),
    creation: createAdministrativeLeagueService({
      repositoryContext: repositories.context,
      platformAuthorization,
      leagueCreationRepository: repositories.leagueCreation,
      userRepository: repositories.users,
      auditRepository: repositories.audit,
      clock,
      secureRandom,
      currentSeason,
    }),
    commissionerAssignment: createCommissionerAssignmentService({
      repositoryContext: repositories.context,
      platformAuthorization,
      userRepository: repositories.users,
      assignmentRepository: repositories.commissionerAssignments,
      auditRepository: repositories.audit,
      clock,
      secureRandom,
    }),
    commissionerCorrection: createCommissionerCorrectionService({
      leagueAuthorization,
      repository: repositories.commissionerCorrections,
      clock,
      secureRandom,
      providerEnabled: sportsDataIoNhl.enabled === true,
    }),
    read: createLeagueReadService({
      leagueAuthorization,
      leagueAccessRepository: repositories.leagueAccess,
      platformAuthorization,
    }),
    membership: createLeagueMembershipService({
      leagueAuthorization,
      leagueAccessRepository: repositories.leagueAccess,
      clock,
      secureRandom,
    }),
    invitation: createLeagueInvitationService({
      repositoryContext: repositories.context,
      leagueAuthorization,
      userRepository: repositories.users,
      invitationRepository: repositories.leagueInvitations,
      auditRepository: repositories.audit,
      clock,
      secureRandom,
    }),
    teamRead: createTeamReadService({
      leagueAuthorization,
      teamReadRepository: repositories.teamRead,
    }),
    teamWorkspace: createTeamWorkspaceService({
      leagueAuthorization,
      teamAuthorization,
      repository: repositories.teamWorkspace,
      clock,
      secureRandom,
    }),
    rosterAction: createRosterActionService({
      leagueAuthorization,
      teamAuthorization,
      workspaceRepository: repositories.teamWorkspace,
      rosterMovementRepository: repositories.rosterMovements,
      buyoutRepository: repositories.buyouts,
      clock,
      secureRandom,
    }),
    teamCreation: createTeamCreationService({
      repositoryContext: repositories.context,
      leagueAuthorization,
      teamCreationRepository: repositories.teamCreation,
      teamReadRepository: repositories.teamRead,
      auditRepository: repositories.audit,
      clock,
      secureRandom,
    }),
    teamManagerAssignment: createTeamManagerAssignmentService({
      repositoryContext: repositories.context,
      leagueAuthorization,
      userRepository: repositories.users,
      assignmentRepository: repositories.teamManagerAssignments,
      auditRepository: repositories.audit,
      clock,
      secureRandom,
    }),
    teamProfile: createTeamProfileService({
      repositoryContext: repositories.context,
      leagueAuthorization,
      teamAuthorization,
      teamProfileRepository: repositories.teamProfiles,
      teamReadRepository: repositories.teamRead,
      auditRepository: repositories.audit,
      clock,
      secureRandom,
    }),
    publicRoster: createPublicRosterService({
      publicRosterRepository: repositories.publicRoster,
      clock,
    }),
    statistics,
  });

  return Object.freeze({
    account,
    accountEmail,
    actionTokenService,
    auditPrivacyDigest,
    league,
    leaguePlayers,
    players,
    rateLimiter,
    sessionService,
    authorizations: Object.freeze({
      league: leagueAuthorization,
      platform: platformAuthorization,
      team: teamAuthorization,
    }),
  });
}

function createTargetRouters({
  services,
  securityFoundations,
  networkSourceResolver,
} = {}) {
  const { config, secureRandom } = securityFoundations;
  if (typeof networkSourceResolver !== "function") {
    throw new TypeError("target runtime requires a network-source resolver");
  }
  const sessionCookie = createSessionCookie({
    appEnv: config.appEnv,
    publicFrontendOrigin: config.publicFrontendOrigin,
    sameSite: config.appEnv === "local" ? "lax" : "none",
  });
  const requestSecurity = createTargetRequestSecurity({
    isAllowedOrigin: config.isAllowedFrontendOrigin,
    sessionCookie,
    sessionService: services.sessionService,
    requestIdFactory: () => secureRandom.id(),
  });
  const sharedAudit = {
    requestSecurity,
    auditPrivacyDigest: services.auditPrivacyDigest,
    networkSourceResolver,
  };
  const routers = Object.freeze({
    activityNotification: createActivityNotificationRouter({
      requestSecurity,
      leagueActivityService: services.league.activity,
      notificationService: services.league.notifications,
    }),
    accountRegistration: createAccountRegistrationRouter({
      requestSecurity,
      registrationService: services.account.registration,
      verificationService: services.account.verification,
      verificationRequestService: services.account.verificationRequest,
      credentialSetupService: services.account.credentialSetup,
      rateLimiter: services.rateLimiter,
      sessionCookie,
      networkSourceResolver,
    }),
    accountProfile: createAccountProfileRouter({
      requestSecurity,
      accountProfileService: services.account.profile,
    }),
    accountSession: createAccountSessionRouter({
      ...sharedAudit,
      signInService: services.account.signIn,
      signOutService: services.account.signOut,
      passwordChangeService: services.account.passwordChange,
      passwordResetRequestService: services.account.passwordResetRequest,
      passwordResetService: services.account.passwordReset,
      accountDeactivationService: services.account.deactivation,
      reactivationRequestService: services.account.reactivationRequest,
      reactivationService: services.account.reactivation,
      rateLimiter: services.rateLimiter,
      sessionCookie,
    }),
    auction: createAuctionRouter({
      requestSecurity,
      auctionService: services.league.auction,
    }),
    commissionerAssignment: createCommissionerAssignmentRouter({
      ...sharedAudit,
      commissionerAssignmentService: services.league.commissionerAssignment,
    }),
    commissionerCorrection: createCommissionerCorrectionRouter({
      requestSecurity,
      commissionerCorrectionService: services.league.commissionerCorrection,
    }),
    leagueInvitation: createLeagueInvitationRouter({
      ...sharedAudit,
      leagueInvitationService: services.league.invitation,
    }),
    leagueRead: createLeagueReadRouter({
      requestSecurity,
      leagueReadService: services.league.read,
    }),
    leagueMembership: createLeagueMembershipRouter({
      requestSecurity,
      leagueMembershipService: services.league.membership,
    }),
    matchup: createMatchupRouter({
      requestSecurity,
      matchupService: services.league.matchup,
    }),
    player: createPlayerRouter({
      requestSecurity,
      playerReadService: services.players,
      leaguePlayerReadService: services.leaguePlayers,
    }),
    platformAdministration: createPlatformAdministrationRouter({
      ...sharedAudit,
      leagueCreationService: services.league.creation,
    }),
    publicRoster: createPublicRosterRouter({
      requestSecurity,
      publicRosterService: services.league.publicRoster,
    }),
    rosterAction: createRosterActionRouter({
      requestSecurity,
      rosterActionService: services.league.rosterAction,
    }),
    team: createTeamRouter({
      ...sharedAudit,
      teamReadService: services.league.teamRead,
      teamCreationService: services.league.teamCreation,
      teamWorkspaceService: services.league.teamWorkspace,
    }),
    teamManagerAssignment: createTeamManagerAssignmentRouter({
      ...sharedAudit,
      teamManagerAssignmentService: services.league.teamManagerAssignment,
    }),
    teamProfile: createTeamProfileRouter({
      ...sharedAudit,
      teamProfileService: services.league.teamProfile,
    }),
    trade: createTradeRouter({
      requestSecurity,
      tradeReadService: services.league.tradeRead,
      tradeProposalService: services.league.tradeProposalFoundation,
      tradeCreationService: services.league.tradeProposalCreation,
      tradeLifecycleService: services.league.tradeProposalLifecycle,
      tradeAcceptancePreviewService: services.league.tradeAcceptancePreview,
      tradeAcceptanceService: services.league.tradeAcceptance,
    }),
    tradeRecovery: createTradeRecoveryRouter({
      requestSecurity,
      tradeRecoveryService: services.league.tradeRecovery,
    }),
  });
  return Object.freeze({ requestSecurity, routers, sessionCookie });
}

function createTargetRuntime({
  database,
  migrationsDirectory,
  securityFoundations,
  currentSeason,
  passwordHasher,
  passwordInspector,
  networkSourceResolver,
  expressModule = express,
  emailAdapter,
  emailFetchImplementation,
  emailJobOptions,
  leagueInvalidationPublisher,
  leagueWriteMode = "open",
  sportsDataIoNhl,
  sportsDataIoFetchImplementation,
} = {}) {
  const migrations = discoverMigrations({ migrationsDirectory });
  const migrationState = assertMigrationCompatibility(database, migrations);
  const repositories = createTargetRepositories({ database });
  let targetApplication = null;
  const resolvedLeagueInvalidationPublisher =
    leagueInvalidationPublisher ||
    createSocketIoInvalidationPublisher({
      getIo: () => targetApplication?.get("io"),
    });
  const services = createTargetServices({
    repositories,
    securityFoundations,
    currentSeason,
    passwordHasher,
    passwordInspector,
    leagueInvalidationPublisher: resolvedLeagueInvalidationPublisher,
    emailAdapter,
    emailFetchImplementation,
    emailJobOptions,
    sportsDataIoNhl,
    sportsDataIoFetchImplementation,
  });
  const transport = createTargetRouters({
    services,
    securityFoundations,
    networkSourceResolver,
  });
  const app = createTargetApplication({
    routers: transport.routers,
    leagueWriteGate: createLeagueWriteGate({
      mode: leagueWriteMode,
      isAllowedOrigin:
        securityFoundations.config.isAllowedFrontendOrigin,
    }),
    expressModule,
  });
  targetApplication = app;
  const socketAuthorization = createSocketAuthorizationService({
    isAllowedOrigin:
      securityFoundations.config.isAllowedFrontendOrigin,
    sessionCookie: transport.sessionCookie,
    sessionService: services.sessionService,
    leagueAuthorization: services.authorizations.league,
    leagueAccessRepository: repositories.leagueAccess,
    teamAuthorityRepository: repositories.teamAuthority,
  });
  const socketRooms = createAuthenticatedSocketRooms({
    authorizationService: socketAuthorization,
  });
  return Object.freeze({
    app,
    migrationState,
    repositories,
    securityConfig: securityFoundations.config,
    services,
    socketAuthorization,
    socketRooms,
    transport,
  });
}

function openTargetRuntime({
  databasePath,
  environment,
  persistentRoot,
  workingDirectory,
  migrationsDirectory,
  securityFoundations,
  currentSeason,
  networkSourceResolver,
  expressModule = express,
  emailAdapter,
  emailFetchImplementation,
  emailJobOptions,
  leagueInvalidationPublisher,
  sportsDataIoNhl,
  sportsDataIoFetchImplementation,
  openDatabaseFunction = openDatabase,
} = {}) {
  if (environment !== "local" && environment !== "test") {
    throw new TypeError(
      "target runtime may open databases only in local or test environments"
    );
  }
  if (typeof openDatabaseFunction !== "function") {
    throw new TypeError("target runtime requires a database opener");
  }

  const connection = openDatabaseFunction({
    databasePath,
    environment,
    persistentRoot,
    workingDirectory,
  });
  try {
    const runtime = createTargetRuntime({
      database: connection.database,
      migrationsDirectory,
      securityFoundations,
      currentSeason,
      networkSourceResolver,
      expressModule,
      emailAdapter,
      emailFetchImplementation,
      emailJobOptions,
      sportsDataIoNhl,
      sportsDataIoFetchImplementation,
      leagueInvalidationPublisher,
    });
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (connection.database.open) connection.database.close();
    }
    return Object.freeze({
      ...runtime,
      close,
      database: connection.database,
      databasePath: connection.databasePath,
    });
  } catch (error) {
    if (connection.database?.open) connection.database.close();
    throw error;
  }
}

module.exports = {
  TARGET_ENDPOINTS,
  TARGET_ROUTER_KEYS,
  createTargetApplication,
  createTargetRepositories,
  createTargetRouters,
  createTargetRuntime,
  createTargetServices,
  openTargetRuntime,
  selectTargetRouterKey,
};
