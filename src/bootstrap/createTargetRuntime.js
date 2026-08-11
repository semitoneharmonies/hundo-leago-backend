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
  createAuctionAdministrationService,
} = require("../application/services/auctions/createAuctionAdministrationService");
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
  createEntryDraftScheduleService,
} = require("../application/services/drafts/createEntryDraftScheduleService");
const {
  createCandidateCardService,
} = require("../application/services/freeAgentDraft/createCandidateCardService");
const {
  createCandidateAllocationService,
} = require("../application/services/freeAgentDraft/createCandidateAllocationService");
const {
  createFreeAgentDraftAllocationLifecycleService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftAllocationLifecycleService");
const {
  createFreeAgentDraftAllocationCorrectionService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftAllocationCorrectionService");
const {
  createFreeAgentDraftCompletionService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftCompletionService");
const {
  createCandidateEligibilityRevalidationService,
} = require("../application/services/freeAgentDraft/createCandidateEligibilityRevalidationService");
const {
  createFreeAgentDraftReadinessService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftReadinessService");
const {
  createFreeAgentDraftReadService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftReadService");
const {
  createFreeAgentDraftReadinessRetryService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftReadinessRetryService");
const {
  createFreeAgentDraftRecoveryReadService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftRecoveryReadService");
const {
  createFreeAgentDraftRecoveryActionService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftRecoveryActionService");
const {
  createFreeAgentDraftCorrectionPreviewService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftCorrectionPreviewService");
const {
  createFreeAgentDraftDeadlineReminderService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftDeadlineReminderService");
const {
  createFreeAgentDraftDeadlineService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftDeadlineService");
const {
  createFreeAgentDraftScheduleRecoveryService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftScheduleRecoveryService");
const {
  createFreeAgentDraftAuctionResolutionService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftAuctionResolutionService");
const {
  createFreeAgentDraftRestrictedActivationService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftRestrictedActivationService");
const {
  createFreeAgentDraftFallbackActivationService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftFallbackActivationService");
const {
  createFreeAgentDraftQueuedNominationActivationService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftQueuedNominationActivationService");
const {
  createFreeAgentDraftRolloverService,
} = require("../application/services/freeAgentDraft/createFreeAgentDraftRolloverService");
const {
  createLateLockCoordinator,
} = require("../application/services/matchups/createLateLockCoordinator");
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
  createMatchupResultCorrectionService,
} = require("../application/services/matchups/createMatchupResultCorrectionService");
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
  createStandingsFinalizationService,
} = require("../application/services/matchups/createStandingsFinalizationService");
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
  createLiveStatisticsService,
} = require("../application/services/statistics/createLiveStatisticsService");
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
  createExecuteScheduledEntryDraftRolloversJob,
} = require("../jobs/definitions/executeScheduledEntryDraftRollovers");
const {
  createOpenReadyFreeAgentDraftCandidateCardsJob,
} = require("../jobs/definitions/openReadyFreeAgentDraftCandidateCards");
const {
  createRevalidateFreeAgentDraftCandidateEligibilityJob,
} = require("../jobs/definitions/revalidateFreeAgentDraftCandidateEligibility");
const {
  createSendFreeAgentDraftDeadlineRemindersJob,
} = require("../jobs/definitions/sendFreeAgentDraftDeadlineReminders");
const {
  createProcessFreeAgentDraftDeadlinesJob,
} = require("../jobs/definitions/processFreeAgentDraftDeadlines");
const {
  createProcessFreeAgentDraftAllocationsJob,
} = require("../jobs/definitions/processFreeAgentDraftAllocations");
const {
  createProcessFreeAgentDraftAllocationCycleJob,
} = require("../jobs/definitions/processFreeAgentDraftAllocationCycle");
const {
  createCoordinateFreeAgentDraftAllocationsJob,
} = require("../jobs/definitions/coordinateFreeAgentDraftAllocations");
const {
  createCompleteFreeAgentDraftsJob,
} = require("../jobs/definitions/completeFreeAgentDrafts");
const {
  createResolveFreeAgentDraftAuctionsJob,
} = require("../jobs/definitions/resolveFreeAgentDraftAuctions");
const {
  createActivateFreeAgentDraftRestrictedAuctionsJob,
} = require("../jobs/definitions/activateFreeAgentDraftRestrictedAuctions");
const {
  createActivateFreeAgentDraftFallbackAuctionsJob,
} = require("../jobs/definitions/activateFreeAgentDraftFallbackAuctions");
const {
  createActivateFreeAgentDraftQueuedNominationsJob,
} = require("../jobs/definitions/activateFreeAgentDraftQueuedNominations");
const {
  createFinalizeFreeAgentDraftRolloversJob,
} = require("../jobs/definitions/finalizeFreeAgentDraftRollovers");
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
  createLeagueLifecycleTransitionService,
} = require("../application/services/leagues/createLeagueLifecycleTransitionService");
const {
  createLeagueStartService,
} = require("../application/services/leagues/createLeagueStartService");
const {
  createLeagueTradeDeadlineService,
} = require("../application/services/leagues/createLeagueTradeDeadlineService");
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
  MINIMUM_CURRENT_SEASON_PLAYER_COUNT,
  PROVIDER_NAME: SPORTSDATAIO_LIVE_PROVIDER_NAME,
  createSportsDataIoLiveNhlAdapter,
} = require("../infrastructure/sportsdataio/SportsDataIoLiveNhlAdapter");
const {
  PROVIDER_NAME: SPORTSDATAIO_PLAYER_IDENTITY_PROVIDER_NAME,
} = require("../infrastructure/sportsdataio/SportsDataIoNhlAdapter");
const {
  createSqliteAccountActionTokenRepository,
} = require("../infrastructure/persistence/sqlite/SqliteAccountActionTokenRepository");
const {
  createSqliteAuctionAdministrationRepository,
} = require("../infrastructure/persistence/sqlite/SqliteAuctionAdministrationRepository");
const {
  createSqliteAuctionBidRepository,
} = require("../infrastructure/persistence/sqlite/SqliteAuctionBidRepository");
const {
  createSqliteAuctionReadRepository,
} = require("../infrastructure/persistence/sqlite/SqliteAuctionReadRepository");
const {
  createSqliteAuctionRepository,
} = require("../infrastructure/persistence/sqlite/SqliteAuctionRepository");
const {
  createSqliteAuctionResolutionRepository,
} = require("../infrastructure/persistence/sqlite/SqliteAuctionResolutionRepository");
const {
  createSqliteFreeAgentDraftAuctionStartWriter,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftAuctionStartWriter");
const {
  createSqliteBuyoutRepository,
} = require("../infrastructure/persistence/sqlite/SqliteBuyoutRepository");
const {
  createSqliteContractRepository,
} = require("../infrastructure/persistence/sqlite/SqliteContractRepository");
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
  createSqliteEntryDraftScheduleRepository,
} = require("../infrastructure/persistence/sqlite/SqliteEntryDraftScheduleRepository");
const {
  createSqliteCandidateCardRepository,
} = require("../infrastructure/persistence/sqlite/SqliteCandidateCardRepository");
const {
  createSqliteCandidateAllocationRepository,
} = require("../infrastructure/persistence/sqlite/SqliteCandidateAllocationRepository");
const {
  createSqliteCandidateCardOpeningWriter,
} = require("../infrastructure/persistence/sqlite/SqliteCandidateCardOpeningWriter");
const {
  createSqliteCandidateCardMutationSideEffectWriter,
} = require("../infrastructure/persistence/sqlite/SqliteCandidateCardMutationSideEffectWriter");
const {
  createSqliteCandidateCardHelpSideEffectWriter,
} = require("../infrastructure/persistence/sqlite/SqliteCandidateCardHelpSideEffectWriter");
const {
  createSqliteCandidateCardSummerSynchronizer,
} = require("../infrastructure/persistence/sqlite/SqliteCandidateCardSummerSynchronizer");
const {
  createSqliteCandidateEligibilityRevalidationWriter,
} = require("../infrastructure/persistence/sqlite/SqliteCandidateEligibilityRevalidationWriter");
const {
  createSqliteFreeAgentDraftEligibilityDeadlineReconciler,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftEligibilityDeadlineReconciler");
const {
  createSqliteFreeAgentDraftDeadlineReminderWriter,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftDeadlineReminderWriter");
const {
  createSqliteFreeAgentDraftDeadlineWriter,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftDeadlineWriter");
const {
  createSqliteFreeAgentDraftAllocationLifecycleWriter,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftAllocationLifecycleWriter");
const {
  createSqliteFreeAgentDraftAllocationCorrectionRepository,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftAllocationCorrectionRepository");
const {
  createSqliteFreeAgentDraftCompletionWriter,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftCompletionWriter");
const {
  createSqliteFreeAgentDraftAuctionResolutionWriter,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftAuctionResolutionWriter");
const {
  createSqliteFreeAgentDraftRestrictedActivationWriter,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftRestrictedActivationWriter");
const {
  createSqliteFreeAgentDraftFallbackActivationWriter,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftFallbackActivationWriter");
const {
  createSqliteFreeAgentDraftQueuedNominationActivationWriter,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftQueuedNominationActivationWriter");
const {
  createSqliteFreeAgentDraftRolloverWriter,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftRolloverWriter");
const {
  createSqliteRestrictedNoImprovementFallbackWriter,
} = require("../infrastructure/persistence/sqlite/SqliteRestrictedNoImprovementFallbackWriter");
const {
  createFreeAgentDraftTransitionWriterDispatcher,
} = require("../infrastructure/persistence/sqlite/createFreeAgentDraftTransitionWriterDispatcher");
const {
  createSqliteFreeAgentDraftJobRepository,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftJobRepository");
const {
  createSqliteFreeAgentDraftReadRepository,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftReadRepository");
const {
  createSqliteFreeAgentDraftRecoveryReadRepository,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftRecoveryReadRepository");
const {
  createSqliteFreeAgentDraftRecoveryActionRepository,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftRecoveryActionRepository");
const {
  createSqliteFreeAgentDraftCorrectionPreviewRepository,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftCorrectionPreviewRepository");
const {
  createSqliteFreeAgentDraftReadinessHandoffWriter,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftReadinessHandoffWriter");
const {
  createSqliteFreeAgentDraftRepository,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftRepository");
const {
  createSqliteFreeAgentDraftScheduleRecoveryWriter,
} = require("../infrastructure/persistence/sqlite/SqliteFreeAgentDraftScheduleRecoveryWriter");
const {
  createSqliteLeagueLifecycleTransitionRepository,
} = require("../infrastructure/persistence/sqlite/SqliteLeagueLifecycleTransitionRepository");
const {
  createSqliteLeagueStartRepository,
} = require("../infrastructure/persistence/sqlite/SqliteLeagueStartRepository");
const {
  createSqliteLeagueTradeDeadlineRepository,
} = require("../infrastructure/persistence/sqlite/SqliteLeagueTradeDeadlineRepository");
const {
  createSqliteLeagueActivityRepository,
} = require("../infrastructure/persistence/sqlite/SqliteLeagueActivityRepository");
const {
  createSqliteLeagueOutboxRepository,
} = require("../infrastructure/persistence/sqlite/SqliteLeagueOutboxRepository");
const {
  createSqliteLeagueOutboxWriter,
} = require("../infrastructure/persistence/sqlite/SqliteLeagueOutboxWriter");
const {
  createSqliteMatchupReadRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupReadRepository");
const {
  createSqliteMatchupJobRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupJobRepository");
const {
  createSqliteLateLockCoordinatorRepository,
} = require("../infrastructure/persistence/sqlite/SqliteLateLockCoordinatorRepository");
const {
  createSqliteMatchupLockRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupLockRepository");
const {
  createSqliteMatchupOccurrenceExecutionGuard,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupOccurrenceExecutionGuard");
const {
  createSqliteMatchupRecoveryRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupRecoveryRepository");
const {
  createSqliteMatchupResultRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupResultRepository");
const {
  createSqliteMatchupResultCorrectionRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupResultCorrectionRepository");
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
  createSqliteMatchupStandingsFinalizationRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupStandingsFinalizationRepository");
const {
  createSqliteMatchupWeekRepository,
} = require("../infrastructure/persistence/sqlite/SqliteMatchupWeekRepository");
const {
  createSqliteNotificationRepository,
} = require("../infrastructure/persistence/sqlite/SqliteNotificationRepository");
const {
  createSqliteNotificationWriter,
} = require("../infrastructure/persistence/sqlite/SqliteNotificationWriter");
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
  createSqliteLeaguePlayerOwnershipRepository,
} = require("../infrastructure/persistence/sqlite/SqliteLeaguePlayerOwnershipRepository");
const {
  createSqliteProspectDecisionRepository,
} = require("../infrastructure/persistence/sqlite/SqliteProspectDecisionRepository");
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
  createSqliteSeasonRolloverJobRepository,
} = require("../infrastructure/persistence/sqlite/SqliteSeasonRolloverJobRepository");
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
  createSqliteRetentionRepository,
} = require("../infrastructure/persistence/sqlite/SqliteRetentionRepository");
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
  createCandidateCardRouter,
} = require("../transport/http/createCandidateCardRouter");
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
  createEntryDraftRouter,
} = require("../transport/http/createEntryDraftRouter");
const {
  createFreeAgentDraftRouter,
} = require("../transport/http/createFreeAgentDraftRouter");
const {
  createLeagueInvitationRouter,
} = require("../transport/http/createLeagueInvitationRouter");
const {
  createLeagueLifecycleRouter,
} = require("../transport/http/createLeagueLifecycleRouter");
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
  createStandingsFinalizationRouter,
} = require("../transport/http/createStandingsFinalizationRouter");
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

const SPORTSDATAIO_LIVE_VERIFICATION_KEYS = Object.freeze([
  "status",
  "evidenceId",
  "evidenceSha256",
  "issuedAtMs",
  "expiresAtMs",
  "verifiedAtMs",
]);
const SPORTSDATAIO_LIVE_UUID_V4_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SPORTSDATAIO_LIVE_SHA256_PATTERN = /^[a-f0-9]{64}$/u;

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
    "POST",
    "/api/v1/leagues/:leagueId/entry-drafts/:draftId/schedule",
    "entryDraft",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/free-agent-drafts/navigation",
    "freeAgentDraft",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/free-agent-drafts/readiness",
    "freeAgentDraft",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/free-agent-drafts/readiness/retries",
    "freeAgentDraft",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId",
    "freeAgentDraft",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards",
    "freeAgentDraft",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/history",
    "freeAgentDraft",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/results",
    "freeAgentDraft",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/recovery",
    "freeAgentDraft",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/recovery/actions",
    "freeAgentDraft",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/allocations/:allocationId/correction-previews",
    "freeAgentDraft",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/allocations/:allocationId/corrections",
    "freeAgentDraft",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/private",
    "candidateCard",
  ],
  [
    "GET",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/eligible-players",
    "candidateCard",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/revision-previews",
    "candidateCard",
  ],
  [
    "PUT",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/slots/:slotKey/candidate",
    "candidateCard",
  ],
  [
    "PATCH",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/entries/:entryId",
    "candidateCard",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/entries/:entryId/move",
    "candidateCard",
  ],
  [
    "DELETE",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/entries/:entryId",
    "candidateCard",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/free-agent-drafts/:fadId/candidate-cards/:teamId/help-requests",
    "candidateCard",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/lifecycle-transitions",
    "leagueLifecycle",
  ],
  [
    "PUT",
    "/api/v1/leagues/:leagueId/setup/trade-deadline",
    "leagueLifecycle",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/start",
    "leagueLifecycle",
  ],
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
  [
    "DELETE",
    "/api/v1/leagues/:leagueId/auctions/:auctionId/bids/:bidId",
    "auction",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/auctions/:auctionId/cancel",
    "auction",
  ],
  [
    "POST",
    "/api/v1/leagues/:leagueId/auctions/:auctionId/resolve",
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
  [
    "POST",
    "/api/v1/leagues/:leagueId/seasons/:seasonId/standings/finalizations",
    "standingsFinalization",
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
const FREE_AGENT_DRAFT_ROUTER_KEYS = Object.freeze([
  "candidateCard",
  "freeAgentDraft",
]);

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
  freeAgentDraftRoutesEnabled = true,
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
  if (typeof freeAgentDraftRoutesEnabled !== "boolean") {
    throw new TypeError(
      "target runtime requires an exact Free Agent Draft route exposure boolean"
    );
  }

  function selectRequestTargetRouterKey(request) {
    return selectTargetRouterKey(
      request.method,
      request.path,
      request.get("access-control-request-method")
    );
  }

  const app = expressModule();
  app.disable("x-powered-by");
  if (!freeAgentDraftRoutesEnabled) {
    app.use((request, response, next) => {
      const routerKey = selectRequestTargetRouterKey(request);
      if (!FREE_AGENT_DRAFT_ROUTER_KEYS.includes(routerKey)) return next();
      return response.status(404).end();
    });
  }
  if (leagueWriteGate !== undefined) {
    if (typeof leagueWriteGate !== "function") {
      throw new TypeError("target runtime requires a league write gate");
    }
    app.use((request, response, next) => {
      const routerKey = selectRequestTargetRouterKey(request);
      if (!routerKey) return next();
      return leagueWriteGate(request, response, next);
    });
  }
  app.use((request, response, next) => {
    const routerKey = selectRequestTargetRouterKey(request);
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

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isExactFrozenLiveVerification(value) {
  if (
    !isPlainObject(value) ||
    !Object.isFrozen(value) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    return false;
  }
  const actualKeys = Object.getOwnPropertyNames(value).sort();
  const expectedKeys = [...SPORTSDATAIO_LIVE_VERIFICATION_KEYS].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  for (const key of actualKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      return false;
    }
  }
  return (
    value.status === "verified" &&
    SPORTSDATAIO_LIVE_UUID_V4_PATTERN.test(value.evidenceId) &&
    SPORTSDATAIO_LIVE_SHA256_PATTERN.test(value.evidenceSha256) &&
    Number.isSafeInteger(value.issuedAtMs) &&
    value.issuedAtMs >= 0 &&
    Number.isSafeInteger(value.expiresAtMs) &&
    value.expiresAtMs > value.issuedAtMs &&
    Number.isSafeInteger(value.verifiedAtMs) &&
    value.verifiedAtMs >= value.issuedAtMs &&
    value.verifiedAtMs < value.expiresAtMs
  );
}

function requireVerifiedSportsDataIoLiveDescriptor(value) {
  if (!isPlainObject(value) || typeof value.enabled !== "boolean") {
    throw new TypeError(
      "target runtime requires a verified SportsDataIO live capability descriptor"
    );
  }
  if (value.enabled === false) return null;

  const apiKeyDescriptor = Object.getOwnPropertyDescriptor(value, "apiKey");
  if (
    value.mode !== "required" ||
    value.verified !== true ||
    !Object.isFrozen(value) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    !isExactFrozenLiveVerification(value.verification) ||
    !apiKeyDescriptor ||
    apiKeyDescriptor.enumerable !== false ||
    apiKeyDescriptor.configurable !== false ||
    apiKeyDescriptor.writable !== false ||
    typeof apiKeyDescriptor.value !== "string" ||
    apiKeyDescriptor.value.length < 1 ||
    typeof value.origin !== "string" ||
    value.origin.length < 1
  ) {
    throw new TypeError(
      "target runtime requires a verified SportsDataIO live capability descriptor"
    );
  }
  return value;
}

function createTargetRepositories({
  database,
  secureRandom,
} = {}) {
  const context = createSqliteRepositoryContext({ database });
  const matchupOccurrenceExecutionGuard =
    createSqliteMatchupOccurrenceExecutionGuard({
      database,
    });
  const matchupOccurrenceRunnerGuardTransaction =
    database.transaction((occurrenceExecution) =>
      matchupOccurrenceExecutionGuard.assertCurrent(
        occurrenceExecution
      )
    );
  const matchupOccurrenceRunnerExecutionGuard =
    Object.freeze({
      assertCurrent(occurrenceExecution) {
        return matchupOccurrenceRunnerGuardTransaction.immediate(
          occurrenceExecution
        );
      },
    });
  const leagueOutboxWriter = createSqliteLeagueOutboxWriter({
    database,
  });
  const notificationWriter = createSqliteNotificationWriter({
    database,
  });
  const freeAgentDraftDeadlineReminderWriter =
    createSqliteFreeAgentDraftDeadlineReminderWriter({
      database,
      notificationWriter,
      leagueOutboxWriter,
    });
  const auditRepository =
    createSqliteSecurityAuditRepository({ database });
  const freeAgentDraftReadinessHandoffWriter =
    createSqliteFreeAgentDraftReadinessHandoffWriter({
      database,
    });
  const freeAgentDraftRead =
    createSqliteFreeAgentDraftReadRepository({
      database,
    });
  const freeAgentDraftRecoveryRead =
    createSqliteFreeAgentDraftRecoveryReadRepository({
      database,
    });
  const freeAgentDraftRecoveryActions =
    createSqliteFreeAgentDraftRecoveryActionRepository({
      database,
    });
  const freeAgentDraftCorrectionPreview =
    createSqliteFreeAgentDraftCorrectionPreviewRepository({
      database,
    });
  const freeAgentDraftAllocationCorrections =
    createSqliteFreeAgentDraftAllocationCorrectionRepository({
      database,
    });
  const candidateCardOpeningWriter =
    createSqliteCandidateCardOpeningWriter({
      database,
      openingContextReader: freeAgentDraftRead,
    });
  const candidateCardMutationSideEffectWriter =
    createSqliteCandidateCardMutationSideEffectWriter({
      database,
      leagueOutboxWriter,
    });
  const candidateCardHelpSideEffectWriter =
    createSqliteCandidateCardHelpSideEffectWriter({
      database,
      auditRepository,
      notificationWriter,
      leagueOutboxWriter,
    });
  const candidateCards =
    createSqliteCandidateCardRepository({
      database,
      writeMutationSideEffects:
        candidateCardMutationSideEffectWriter,
      writeHelpGrantSideEffects:
        candidateCardHelpSideEffectWriter,
    });
  const candidateCardSummerSynchronizer =
    createSqliteCandidateCardSummerSynchronizer({
      database,
      candidateCardRepository: candidateCards,
    });
  const candidateEligibilityRevalidationWriter =
    createSqliteCandidateEligibilityRevalidationWriter({
      database,
      candidateCardSummerSynchronizer,
    });
  const freeAgentDraftEligibilityDeadlineReconciler =
    createSqliteFreeAgentDraftEligibilityDeadlineReconciler({
      database,
      candidateCardSummerSynchronizer,
    });
  const freeAgentDraftDeadlineWriter =
    createSqliteFreeAgentDraftDeadlineWriter({
      database,
      eligibilityDeadlineReconciler:
        freeAgentDraftEligibilityDeadlineReconciler,
      notificationWriter,
      leagueOutboxWriter,
    });
  const freeAgentDraftAllocationLifecycleWriter =
    createSqliteFreeAgentDraftAllocationLifecycleWriter({
      database,
      notificationWriter,
      leagueOutboxWriter,
    });
  const freeAgentDraftScheduleRecoveryService =
    createFreeAgentDraftScheduleRecoveryService({
      secureRandom,
    });
  const freeAgentDraftCompletionWriter =
    createSqliteFreeAgentDraftCompletionWriter({
      database,
      scheduleRecoveryService:
        freeAgentDraftScheduleRecoveryService,
      notificationWriter,
      leagueOutboxWriter,
    });
  const freeAgentDraftTransitionWriter =
    createFreeAgentDraftTransitionWriterDispatcher([
      {
        fromStatus: "cards_open",
        toStatus: "deadline_locked",
        writer: freeAgentDraftDeadlineWriter,
      },
      {
        fromStatus: "deadline_locked",
        toStatus: "allocating",
        writer: freeAgentDraftAllocationLifecycleWriter,
      },
      {
        fromStatus: "deadline_locked",
        toStatus: "rapid",
        writer: freeAgentDraftAllocationLifecycleWriter,
      },
      {
        fromStatus: "allocating",
        toStatus: "rapid",
        writer: freeAgentDraftAllocationLifecycleWriter,
      },
      {
        fromStatus: "rapid",
        toStatus: "completed",
        writer: freeAgentDraftCompletionWriter,
      },
    ]);
  const freeAgentDraftScheduleRecoveryWriter =
    createSqliteFreeAgentDraftScheduleRecoveryWriter({
      database,
    });
  const freeAgentDraftLifecycle =
    createSqliteFreeAgentDraftRepository({
      database,
      candidateCardWriter:
        candidateCardOpeningWriter,
      scheduleRecoveryWriter:
        freeAgentDraftScheduleRecoveryWriter,
      transitionWriter:
        freeAgentDraftTransitionWriter,
      notificationWriter,
    });
  const restrictedNoImprovementFallbackWriter =
    createSqliteRestrictedNoImprovementFallbackWriter({
      database,
      createDrawNonce: () => secureRandom.bytes(32),
      leagueOutboxWriter,
      notificationWriter,
    });
  const freeAgentDraftAuctionResolutionWriter =
    createSqliteFreeAgentDraftAuctionResolutionWriter({
      database,
      createId: () => secureRandom.id(),
      candidateCardSummerSynchronizer,
      leagueOutboxWriter,
      restrictedFallbackWriter:
        restrictedNoImprovementFallbackWriter,
    });
  const freeAgentDraftAuctionStartWriter =
    createSqliteFreeAgentDraftAuctionStartWriter({
      database,
      createId: () => secureRandom.id(),
      createDrawNonce: () => secureRandom.bytes(32),
      leagueOutboxWriter,
    });
  const freeAgentDraftRestrictedActivationWriter =
    createSqliteFreeAgentDraftRestrictedActivationWriter({
      database,
      createId: () => secureRandom.id(),
      leagueOutboxWriter,
      notificationWriter,
    });
  const freeAgentDraftFallbackActivationWriter =
    createSqliteFreeAgentDraftFallbackActivationWriter({
      database,
      createId: () => secureRandom.id(),
      leagueOutboxWriter,
      notificationWriter,
    });
  const freeAgentDraftQueuedNominationActivationWriter =
    createSqliteFreeAgentDraftQueuedNominationActivationWriter({
      database,
      createId: () => secureRandom.id(),
      createDrawNonce: () => secureRandom.bytes(32),
      leagueOutboxWriter,
    });
  const freeAgentDraftRolloverWriter =
    createSqliteFreeAgentDraftRolloverWriter({
      database,
      createId: () => secureRandom.id(),
    });
  const candidateAllocations =
    createSqliteCandidateAllocationRepository({
      database,
      leagueOutboxWriter,
      notificationWriter,
      createId: () => secureRandom.id(),
      createDrawNonce: () => secureRandom.bytes(32),
      allowImmediateRestrictedActivation: true,
    });
  return Object.freeze({
    context,
    actionTokens: createSqliteAccountActionTokenRepository({ database }),
    auctionAdministration:
      createSqliteAuctionAdministrationRepository({
        database,
        leagueOutboxWriter,
        notificationWriter,
      }),
    auctionBids: createSqliteAuctionBidRepository({ database }),
    auctionReads: createSqliteAuctionReadRepository({ database }),
    auctionResolutions: createSqliteAuctionResolutionRepository({
      database,
      leagueOutboxWriter,
      candidateCardSummerSynchronizer,
    }),
    auctions: createSqliteAuctionRepository({ database }),
    audit: auditRepository,
    buyouts: createSqliteBuyoutRepository({
      database,
      candidateCardSummerSynchronizer,
    }),
    candidateAllocations,
    candidateCards,
    candidateCardSummerSynchronizer,
    candidateEligibilityRevalidationWriter,
    commissionerAssignments: createSqliteCommissionerAssignmentRepository({
      database,
      leagueOutboxWriter,
      notificationWriter,
    }),
    commissionerCorrections: createSqliteCommissionerCorrectionRepository({
      database,
      candidateCardSummerSynchronizer,
    }),
    contracts: createSqliteContractRepository({
      database,
      candidateCardSummerSynchronizer,
    }),
    credentials: createSqliteCredentialRepository({ database }),
    entryDraftSchedule:
      createSqliteEntryDraftScheduleRepository({
        database,
        auditRepository,
        notificationWriter,
        leagueOutboxWriter,
      }),
    freeAgentDraftJobs:
      createSqliteFreeAgentDraftJobRepository({
        database,
      }),
    freeAgentDraftDeadlineReminderWriter,
    freeAgentDraftDeadlineWriter,
    freeAgentDraftAllocationLifecycleWriter,
    freeAgentDraftAuctionStartWriter,
    freeAgentDraftAuctionResolutionWriter,
    freeAgentDraftRestrictedActivationWriter,
    freeAgentDraftFallbackActivationWriter,
    freeAgentDraftQueuedNominationActivationWriter,
    freeAgentDraftRolloverWriter,
    freeAgentDraftCompletionWriter,
    freeAgentDraftEligibilityDeadlineReconciler,
    freeAgentDraftLifecycle,
    freeAgentDraftRead,
    freeAgentDraftRecoveryRead,
    freeAgentDraftRecoveryActions,
    freeAgentDraftCorrectionPreview,
    freeAgentDraftAllocationCorrections,
    freeAgentDraftReadinessHandoffWriter,
    freeAgentDraftTransitionWriter,
    restrictedNoImprovementFallbackWriter,
    leagueActivity: createSqliteLeagueActivityRepository({ database }),
    leagueAccess: createSqliteLeagueAccessRepository({
      database,
      leagueOutboxWriter,
    }),
    leagueCreation: createSqliteLeagueCreationRepository({ database }),
    leagueInvitations: createSqliteLeagueInvitationRepository({
      database,
      leagueOutboxWriter,
      notificationWriter,
    }),
    leagueLifecycleTransition:
      createSqliteLeagueLifecycleTransitionRepository({
        database,
        leagueOutboxWriter,
        notificationWriter,
      }),
    leagueStart: createSqliteLeagueStartRepository({
      database,
      leagueOutboxWriter,
    }),
    leagueTradeDeadline:
      createSqliteLeagueTradeDeadlineRepository({
        database,
        leagueOutboxWriter,
      }),
    leagueOutbox: createSqliteLeagueOutboxRepository({ database }),
    leagueOutboxWriter,
    lateLockCoordinator:
      createSqliteLateLockCoordinatorRepository({ database }),
    matchupJobs: createSqliteMatchupJobRepository({ database }),
    matchupLocks: createSqliteMatchupLockRepository({
      database,
      occurrenceExecutionGuard:
        matchupOccurrenceExecutionGuard,
    }),
    matchupOccurrenceRunnerExecutionGuard,
    matchupRead: createSqliteMatchupReadRepository({ database }),
    matchupRecovery: createSqliteMatchupRecoveryRepository({ database }),
    matchupResultCorrections:
      createSqliteMatchupResultCorrectionRepository({
        database,
        leagueOutboxWriter,
        notificationWriter,
        auditRepository,
      }),
    matchupResults: createSqliteMatchupResultRepository({
      database,
      occurrenceExecutionGuard:
        matchupOccurrenceExecutionGuard,
    }),
    matchupSchedule: createSqliteMatchupScheduleRepository({ database }),
    matchupScoring: createSqliteMatchupScoringRepository({ database }),
    matchupStandings: createSqliteMatchupStandingsRepository({ database }),
    standingsFinalization:
      createSqliteMatchupStandingsFinalizationRepository({
        database,
        leagueOutboxWriter,
        notificationWriter,
      }),
    matchupWeeks: createSqliteMatchupWeekRepository({
      database,
      occurrenceExecutionGuard:
        matchupOccurrenceExecutionGuard,
    }),
    notifications: createSqliteNotificationRepository({ database }),
    notificationWriter,
    outbox: createSqliteOutboxEventRepository({ database }),
    leaguePlayers: createSqliteLeaguePlayerReadRepository({ database }),
    leaguePlayerOwnership: createSqliteLeaguePlayerOwnershipRepository({
      database,
      candidateCardSummerSynchronizer,
    }),
    players: createSqlitePlayerRepository({ database }),
    platformRoles: createSqlitePlatformRoleRepository({ database }),
    publicRoster: createSqlitePublicRosterRepository({ database }),
    prospectDecisions: createSqliteProspectDecisionRepository({
      database,
      candidateCardSummerSynchronizer,
    }),
    rateLimits: createSqliteAuthenticationRateLimitRepository({ database }),
    rosterMovements: createSqliteRosterMovementRepository({
      database,
      candidateCardSummerSynchronizer,
    }),
    retentions: createSqliteRetentionRepository({
      database,
      candidateCardSummerSynchronizer,
    }),
    seasonRolloverJobs:
      createSqliteSeasonRolloverJobRepository({
        database,
      }),
    sessions: createSqliteSessionRepository({ database }),
    statistics: createSqliteStatisticsRepository({
      database,
      occurrenceExecutionGuard:
        matchupOccurrenceExecutionGuard,
    }),
    teamAuthority: createSqliteTeamAuthorityRepository({ database }),
    teamCreation: createSqliteTeamCreationRepository({ database }),
    teamManagerAssignments: createSqliteTeamManagerAssignmentRepository({
      database,
      leagueOutboxWriter,
      notificationWriter,
    }),
    teamProfiles: createSqliteTeamProfileRepository({ database }),
    teamRead: createSqliteTeamReadRepository({ database }),
    teamWorkspace: createSqliteTeamWorkspaceRepository({ database }),
    tradeProposals: createSqliteTradeProposalRepository({
      database,
      leagueOutboxWriter,
      notificationWriter,
      candidateCardSummerSynchronizer,
    }),
    tradeExpiries: createSqliteTradeExpiryRepository({
      database,
      leagueOutboxWriter,
    }),
    tradeRecovery: createSqliteTradeReversalRepository({
      database,
      leagueOutboxWriter,
      candidateCardSummerSynchronizer,
    }),
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
  sportsDataIoLiveNhl = Object.freeze({ enabled: false }),
  sportsDataIoFetchImplementation,
  createSportsDataIoLiveNhlAdapterFunction =
    createSportsDataIoLiveNhlAdapter,
} = {}) {
  const { config, clock, secureRandom, logger } = securityFoundations || {};
  if (!config || !clock || !secureRandom || !logger) {
    throw new TypeError("target runtime requires security foundations");
  }
  const verifiedSportsDataIoLiveNhl =
    requireVerifiedSportsDataIoLiveDescriptor(sportsDataIoLiveNhl);
  if (
    verifiedSportsDataIoLiveNhl &&
    typeof createSportsDataIoLiveNhlAdapterFunction !== "function"
  ) {
    throw new TypeError(
      "target runtime requires a SportsDataIO live adapter factory"
    );
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
  const entryDraftSchedule =
    createEntryDraftScheduleService({
      repositoryContext: repositories.context,
      leagueAuthorization,
      entryDraftScheduleRepository:
        repositories.entryDraftSchedule,
      clock,
      secureRandom,
    });
  const leagueOutboxPublication = createLeagueOutboxPublicationService({
    repository: repositories.leagueOutbox,
    publisher: leagueInvalidationPublisher,
    clock,
  });
  const auctionResolutionDecision = createAuctionResolutionDecisionService({
    repository: repositories.auctionResolutions,
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
  const liveSportsDataIoAdapter =
    verifiedSportsDataIoLiveNhl
      ? createSportsDataIoLiveNhlAdapterFunction({
        apiKey: verifiedSportsDataIoLiveNhl.apiKey,
        fetchImpl: sportsDataIoFetchImplementation,
        origin: verifiedSportsDataIoLiveNhl.origin,
        nowMs: () => clock.nowMs(),
      })
      : null;
  const statisticsProvider =
    liveSportsDataIoAdapter ||
    Object.freeze({
      async fetchLiveSnapshot() {
        const error = new Error(
          "SportsDataIO current-season NHL data is disabled until live provider configuration is complete."
        );
        error.code =
          "SPORTSDATAIO_LIVE_NHL_DISABLED";
        throw error;
      },
    });
  const statistics = createLiveStatisticsService({
    repository: repositories.statistics,
    provider: statisticsProvider,
    nhlSeasonKey: currentSeason.nhlSeasonKey,
    providerName: SPORTSDATAIO_LIVE_PROVIDER_NAME,
    playerIdentityProvider:
      SPORTSDATAIO_PLAYER_IDENTITY_PROVIDER_NAME,
    minimumPlayerCount:
      MINIMUM_CURRENT_SEASON_PLAYER_COUNT,
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
    repositoryContext: repositories.context,
    leagueAuthorization,
    repository: repositories.matchupSchedule,
    clock,
    secureRandom,
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
    gameStateProvider: liveSportsDataIoAdapter,
    createId: () => secureRandom.id(),
    nowMs: () => clock.nowMs(),
  });
  const lateLockCoordinator = createLateLockCoordinator({
    targetRepository: repositories.lateLockCoordinator,
    legalityService: matchupLegality,
    statisticsService: statistics,
    provider: SPORTSDATAIO_LIVE_PROVIDER_NAME,
    clock,
    logger,
  });
  const lifecycleTransition =
    createLeagueLifecycleTransitionService({
      repositoryContext: repositories.context,
      leagueAuthorization,
      platformAuthorization,
      leagueLifecycleTransitionRepository:
        repositories.leagueLifecycleTransition,
      freeAgentDraftReadinessHandoffWriter:
        repositories.freeAgentDraftReadinessHandoffWriter,
      lateLockCoordinator,
      clock,
      secureRandom,
    });
  const seasonRolloverJob =
    createExecuteScheduledEntryDraftRolloversJob({
      repository: repositories.seasonRolloverJobs,
      leagueLifecycleTransitionService:
        lifecycleTransition,
      clock,
      secureRandom,
      leaseOwner: secureRandom.id(),
      logger,
    });
  const freeAgentDraftReadiness =
    createFreeAgentDraftReadinessService({
      clock,
      readRepository:
        repositories.freeAgentDraftRead,
      repository:
        repositories.freeAgentDraftLifecycle,
      scheduleRepository:
        repositories.matchupSchedule,
      secureRandom,
    });
  const freeAgentDraftRead =
    createFreeAgentDraftReadService({
      leagueAuthorization,
      repository: repositories.freeAgentDraftRead,
      clock,
    });
  const freeAgentDraftRecoveryRead =
    createFreeAgentDraftRecoveryReadService({
      leagueAuthorization,
      repository:
        repositories.freeAgentDraftRecoveryRead,
      clock,
    });
  const freeAgentDraftRecoveryAction =
    createFreeAgentDraftRecoveryActionService({
      leagueAuthorization,
      repository:
        repositories.freeAgentDraftRecoveryActions,
      clock,
      secureRandom,
    });
  const freeAgentDraftCorrectionPreview =
    createFreeAgentDraftCorrectionPreviewService({
      leagueAuthorization,
      repository:
        repositories.freeAgentDraftCorrectionPreview,
    });
  const freeAgentDraftAllocationCorrection =
    createFreeAgentDraftAllocationCorrectionService({
      leagueAuthorization,
      repository:
        repositories.freeAgentDraftAllocationCorrections,
      clock,
      secureRandom,
      lateLockCoordinator,
    });
  const candidateCards =
    createCandidateCardService({
      leagueAuthorization,
      repository: repositories.candidateCards,
      clock,
      secureRandom,
    });
  const candidateAllocation =
    createCandidateAllocationService({
      repository: repositories.candidateAllocations,
      clock,
    });
  const candidateEligibilityRevalidation =
    createCandidateEligibilityRevalidationService({
      writer:
        repositories.candidateEligibilityRevalidationWriter,
      clock,
    });
  const freeAgentDraftDeadlineReminder =
    createFreeAgentDraftDeadlineReminderService({
      writer:
        repositories.freeAgentDraftDeadlineReminderWriter,
      clock,
    });
  const freeAgentDraftDeadline =
    createFreeAgentDraftDeadlineService({
      writer: repositories.freeAgentDraftDeadlineWriter,
      lifecycleRepository:
        repositories.freeAgentDraftLifecycle,
      clock,
    });
  const freeAgentDraftAllocationLifecycle =
    createFreeAgentDraftAllocationLifecycleService({
      lifecycleRepository:
        repositories.freeAgentDraftLifecycle,
      clock,
    });
  const freeAgentDraftCompletion =
    createFreeAgentDraftCompletionService({
      writer:
        repositories.freeAgentDraftCompletionWriter,
      lifecycleRepository:
        repositories.freeAgentDraftLifecycle,
      clock,
    });
  const freeAgentDraftAuctionResolution =
    createFreeAgentDraftAuctionResolutionService({
      repository:
        repositories.freeAgentDraftAuctionResolutionWriter,
      clock,
      lateLockCoordinator,
    });
  const freeAgentDraftRestrictedActivation =
    createFreeAgentDraftRestrictedActivationService({
      repository:
        repositories.freeAgentDraftRestrictedActivationWriter,
      clock,
    });
  const freeAgentDraftFallbackActivation =
    createFreeAgentDraftFallbackActivationService({
      repository:
        repositories.freeAgentDraftFallbackActivationWriter,
      clock,
    });
  const freeAgentDraftQueuedNominationActivation =
    createFreeAgentDraftQueuedNominationActivationService({
      repository:
        repositories.freeAgentDraftQueuedNominationActivationWriter,
      clock,
    });
  const freeAgentDraftRollover =
    createFreeAgentDraftRolloverService({
      writer: repositories.freeAgentDraftRolloverWriter,
      clock,
    });
  const freeAgentDraftReadinessRetry =
    createFreeAgentDraftReadinessRetryService({
      leagueAuthorization,
      repository: repositories.freeAgentDraftJobs,
      clock,
      secureRandom,
    });
  const freeAgentDraftReadinessJob =
    createOpenReadyFreeAgentDraftCandidateCardsJob({
      repository: repositories.freeAgentDraftJobs,
      readinessService: freeAgentDraftReadiness,
      clock,
      secureRandom,
      leaseOwner: secureRandom.id(),
      logger,
    });
  const candidateEligibilityRevalidationJob =
    createRevalidateFreeAgentDraftCandidateEligibilityJob({
      repository: repositories.freeAgentDraftJobs,
      eligibilityService:
        candidateEligibilityRevalidation,
      clock,
      secureRandom,
      leaseOwner: secureRandom.id(),
      logger,
    });
  const freeAgentDraftDeadlineReminderJob =
    createSendFreeAgentDraftDeadlineRemindersJob({
      repository: repositories.freeAgentDraftJobs,
      reminderService:
        freeAgentDraftDeadlineReminder,
      clock,
      secureRandom,
      leaseOwner: secureRandom.id(),
      logger,
    });
  const freeAgentDraftDeadlineJob =
    createProcessFreeAgentDraftDeadlinesJob({
      repository: repositories.freeAgentDraftJobs,
      deadlineService: freeAgentDraftDeadline,
      clock,
      secureRandom,
      leaseOwner: secureRandom.id(),
      logger,
    });
  const candidateAllocationJob =
    createProcessFreeAgentDraftAllocationsJob({
      repository: repositories.freeAgentDraftJobs,
      allocationService: candidateAllocation,
      clock,
      secureRandom,
      leaseOwner: secureRandom.id(),
      logger,
    });
  const freeAgentDraftAllocationLifecycleJob =
    createCoordinateFreeAgentDraftAllocationsJob({
      writer:
        repositories.freeAgentDraftAllocationLifecycleWriter,
      allocationLifecycleService:
        freeAgentDraftAllocationLifecycle,
      clock,
      logger,
    });
  const freeAgentDraftAllocationCycleJob =
    createProcessFreeAgentDraftAllocationCycleJob({
      allocationLifecycleJob:
        freeAgentDraftAllocationLifecycleJob,
      candidateAllocationJob,
      logger,
    });
  const freeAgentDraftAuctionResolutionJob =
    createResolveFreeAgentDraftAuctionsJob({
      repository:
        repositories.freeAgentDraftAuctionResolutionWriter,
      resolutionService:
        freeAgentDraftAuctionResolution,
      clock,
      secureRandom,
      leaseOwner: secureRandom.id(),
      logger,
    });
  const freeAgentDraftRestrictedActivationJob =
    createActivateFreeAgentDraftRestrictedAuctionsJob({
      repository: repositories.freeAgentDraftJobs,
      activationService:
        freeAgentDraftRestrictedActivation,
      clock,
      secureRandom,
      leaseOwner: secureRandom.id(),
      logger,
    });
  const freeAgentDraftFallbackActivationJob =
    createActivateFreeAgentDraftFallbackAuctionsJob({
      repository: repositories.freeAgentDraftJobs,
      activationService:
        freeAgentDraftFallbackActivation,
      clock,
      secureRandom,
      leaseOwner: secureRandom.id(),
      logger,
    });
  const freeAgentDraftQueuedNominationActivationJob =
    createActivateFreeAgentDraftQueuedNominationsJob({
      repository: repositories.freeAgentDraftJobs,
      activationService:
        freeAgentDraftQueuedNominationActivation,
      clock,
      secureRandom,
      leaseOwner: secureRandom.id(),
      logger,
    });
  const freeAgentDraftRolloverJob =
    createFinalizeFreeAgentDraftRolloversJob({
      writer: repositories.freeAgentDraftRolloverWriter,
      repository: repositories.freeAgentDraftJobs,
      rolloverService: freeAgentDraftRollover,
      clock,
      secureRandom,
      leaseOwner: secureRandom.id(),
      logger,
    });
  const freeAgentDraftCompletionJob =
    createCompleteFreeAgentDraftsJob({
      writer:
        repositories.freeAgentDraftCompletionWriter,
      repository: repositories.freeAgentDraftJobs,
      completionService: freeAgentDraftCompletion,
      clock,
      secureRandom,
      leaseOwner: secureRandom.id(),
      logger,
    });
  const auctionResolution = createAuctionResolutionService({
    repository: repositories.auctionResolutions,
    lateLockCoordinator,
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
  const matchupScoring = createMatchupScoringService({
    repository: repositories.matchupScoring,
  });
  const matchupResults = createMatchupResultService({
    repository: repositories.matchupResults,
    scoringService: matchupScoring,
    createId: () => secureRandom.id(),
  });
  const matchupResultCorrection =
    createMatchupResultCorrectionService({
      repositoryContext: repositories.context,
      leagueAuthorization,
      repository:
        repositories.matchupResultCorrections,
      clock,
      secureRandom,
    });
  const matchupStandings = createMatchupStandingsService({
    repository: repositories.matchupStandings,
  });
  const standingsFinalization =
    createStandingsFinalizationService({
      repositoryContext: repositories.context,
      leagueAuthorization,
      standingsFinalizationRepository:
        repositories.standingsFinalization,
      auditRepository: repositories.audit,
      clock,
      secureRandom,
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
    resultCorrectionService:
      matchupResultCorrection,
    standingsService: matchupStandings,
    recoveryService: matchupRecovery,
    statisticsProviders: Object.freeze([
      SPORTSDATAIO_LIVE_PROVIDER_NAME,
      "release_qa_fixture",
    ]),
    clock,
    createId: () => secureRandom.id(),
  });
  const matchupOccurrenceHandlers = createMatchupOccurrenceHandlers({
    statisticsService: statistics,
    lateLockCoordinator,
    readRepository: repositories.matchupRead,
    weekService: matchupWeeks,
    legalityService: matchupLegality,
    resultService: matchupResults,
    provider: SPORTSDATAIO_LIVE_PROVIDER_NAME,
  });
  const matchupOccurrenceJob = createRunMatchupOccurrencesJob({
    repository: repositories.matchupJobs,
    executionGuard:
      repositories.matchupOccurrenceRunnerExecutionGuard,
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
    candidateAllocation,
    candidateAllocationJob,
    candidateCards,
    candidateEligibilityRevalidation,
    candidateEligibilityRevalidationJob,
    freeAgentDraftAllocationLifecycle,
    freeAgentDraftAllocationCycleJob,
    freeAgentDraftAllocationLifecycleJob,
    freeAgentDraftAuctionResolution,
    freeAgentDraftAuctionResolutionJob,
    freeAgentDraftRestrictedActivation,
    freeAgentDraftRestrictedActivationJob,
    freeAgentDraftFallbackActivation,
    freeAgentDraftFallbackActivationJob,
    freeAgentDraftQueuedNominationActivation,
    freeAgentDraftQueuedNominationActivationJob,
    freeAgentDraftRollover,
    freeAgentDraftRolloverJob,
    freeAgentDraftCompletion,
    freeAgentDraftCompletionJob,
    freeAgentDraftDeadline,
    freeAgentDraftDeadlineJob,
    freeAgentDraftDeadlineReminder,
    freeAgentDraftDeadlineReminderJob,
    entryDraftSchedule,
    lifecycleTransition,
    matchup,
    lateLockCoordinator,
    matchupLegality,
    matchupLock,
    matchupOccurrenceHandlers,
    matchupOccurrenceJob,
    matchupRecovery,
    matchupResultCorrection,
    matchupResults,
    matchupSchedule,
    matchupScoring,
    matchupStandings,
    standingsFinalization,
    matchupWeeks,
    seasonRolloverJob,
    freeAgentDraftReadiness,
    freeAgentDraftReadinessJob,
    freeAgentDraftRead,
    freeAgentDraftRecoveryRead,
    freeAgentDraftRecoveryAction,
    freeAgentDraftCorrectionPreview,
    freeAgentDraftAllocationCorrection,
    freeAgentDraftReadinessRetry,
    activity: createLeagueActivityService({
      leagueAuthorization,
      repository: repositories.leagueActivity,
    }),
    auction: createAuctionService({
      leagueAuthorization,
      teamAuthorization,
      leagueAccessRepository: repositories.leagueAccess,
      freeAgentDraftAuctionStartWriter:
        repositories.freeAgentDraftAuctionStartWriter,
      auctionRepository: repositories.auctions,
      auctionBidRepository: repositories.auctionBids,
      auctionReadRepository: repositories.auctionReads,
      clock,
      secureRandom,
    }),
    auctionAdministration:
      createAuctionAdministrationService({
        leagueAuthorization,
        repository:
          repositories.auctionAdministration,
        clock,
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
      lateLockCoordinator,
      clock,
      secureRandom,
    }),
    tradeRecovery: createTradeReversalService({
      leagueAuthorization,
      repository: repositories.tradeRecovery,
      lateLockCoordinator,
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
        name: "entry_draft_rollover",
        runner: seasonRolloverJob,
      }),
      Object.freeze({
        name: "free_agent_draft_readiness",
        runner: freeAgentDraftReadinessJob,
      }),
      Object.freeze({
        name: "free_agent_draft_eligibility_revalidation",
        runner: candidateEligibilityRevalidationJob,
      }),
      Object.freeze({
        name: "free_agent_draft_deadline_reminder",
        runner: freeAgentDraftDeadlineReminderJob,
      }),
      Object.freeze({
        name: "free_agent_draft_deadline",
        runner: freeAgentDraftDeadlineJob,
      }),
      Object.freeze({
        name: "free_agent_draft_allocation_cycle",
        runner: freeAgentDraftAllocationCycleJob,
      }),
      Object.freeze({
        name: "free_agent_draft_auction_resolution",
        runner: freeAgentDraftAuctionResolutionJob,
      }),
      Object.freeze({
        name: "free_agent_draft_restricted_activation",
        runner: freeAgentDraftRestrictedActivationJob,
      }),
      Object.freeze({
        name: "free_agent_draft_fallback_activation",
        runner: freeAgentDraftFallbackActivationJob,
      }),
      Object.freeze({
        name: "free_agent_draft_queued_nomination_activation",
        runner: freeAgentDraftQueuedNominationActivationJob,
      }),
      Object.freeze({
        name: "free_agent_draft_rollover_finalization",
        runner: freeAgentDraftRolloverJob,
      }),
      Object.freeze({
        name: "auction_resolution",
        runner: auctionResolutionJob,
      }),
      Object.freeze({
        name: "free_agent_draft_completion",
        runner: freeAgentDraftCompletionJob,
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
      lateLockCoordinator,
      clock,
      secureRandom,
      providerEnabled: liveSportsDataIoAdapter !== null,
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
    start: createLeagueStartService({
      repositoryContext: repositories.context,
      leagueAuthorization,
      leagueStartRepository:
        repositories.leagueStart,
      freeAgentDraftReadinessHandoffWriter:
        repositories.freeAgentDraftReadinessHandoffWriter,
      auditRepository: repositories.audit,
      clock,
      secureRandom,
    }),
    tradeDeadline:
      createLeagueTradeDeadlineService({
        repositoryContext: repositories.context,
        leagueAuthorization,
        leagueTradeDeadlineRepository:
          repositories.leagueTradeDeadline,
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
      lateLockCoordinator,
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
    sameSite: config.sessionCookieSameSite,
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
      auctionAdministrationService:
        services.league
          .auctionAdministration,
    }),
    candidateCard: createCandidateCardRouter({
      requestSecurity,
      candidateCardService:
        services.league.candidateCards,
      rateLimiter: services.rateLimiter,
    }),
    commissionerAssignment: createCommissionerAssignmentRouter({
      ...sharedAudit,
      commissionerAssignmentService: services.league.commissionerAssignment,
    }),
    commissionerCorrection: createCommissionerCorrectionRouter({
      requestSecurity,
      commissionerCorrectionService: services.league.commissionerCorrection,
    }),
    entryDraft: createEntryDraftRouter({
      ...sharedAudit,
      entryDraftScheduleService:
        services.league.entryDraftSchedule,
    }),
    freeAgentDraft: createFreeAgentDraftRouter({
      requestSecurity,
      freeAgentDraftReadService:
        services.league.freeAgentDraftRead,
      freeAgentDraftReadinessRetryService:
        services.league.freeAgentDraftReadinessRetry,
      freeAgentDraftRecoveryReadService:
        services.league.freeAgentDraftRecoveryRead,
      freeAgentDraftRecoveryActionService:
        services.league.freeAgentDraftRecoveryAction,
      freeAgentDraftCorrectionPreviewService:
        services.league.freeAgentDraftCorrectionPreview,
      freeAgentDraftAllocationCorrectionService:
        services.league
          .freeAgentDraftAllocationCorrection,
      rateLimiter: services.rateLimiter,
    }),
    leagueInvitation: createLeagueInvitationRouter({
      ...sharedAudit,
      leagueInvitationService: services.league.invitation,
    }),
    leagueLifecycle: createLeagueLifecycleRouter({
      ...sharedAudit,
      leagueLifecycleTransitionService:
        services.league.lifecycleTransition,
      leagueTradeDeadlineService:
        services.league.tradeDeadline,
      leagueStartService: services.league.start,
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
      ...sharedAudit,
      matchupService: services.league.matchup,
    }),
    standingsFinalization:
      createStandingsFinalizationRouter({
        ...sharedAudit,
        standingsFinalizationService:
          services.league.standingsFinalization,
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
  freeAgentDraftRoutesEnabled = true,
  sportsDataIoNhl,
  sportsDataIoLiveNhl,
  sportsDataIoFetchImplementation,
  createSportsDataIoLiveNhlAdapterFunction,
} = {}) {
  const migrations = discoverMigrations({ migrationsDirectory });
  const migrationState = assertMigrationCompatibility(database, migrations);
  const repositories = createTargetRepositories({
    database,
    secureRandom: securityFoundations?.secureRandom,
  });
  let targetApplication = null;
  let socketRooms = null;
  const resolvedLeagueInvalidationPublisher =
    leagueInvalidationPublisher ||
    createSocketIoInvalidationPublisher({
      getIo: () => targetApplication?.get("io"),
      getSocketReauthorizer: () => socketRooms?.reauthorize,
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
    sportsDataIoLiveNhl,
    sportsDataIoFetchImplementation,
    createSportsDataIoLiveNhlAdapterFunction,
  });
  const transport = createTargetRouters({
    services,
    securityFoundations,
    networkSourceResolver,
  });
  const app = createTargetApplication({
    routers: transport.routers,
    freeAgentDraftRoutesEnabled,
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
  socketRooms = createAuthenticatedSocketRooms({
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
  sportsDataIoLiveNhl,
  sportsDataIoFetchImplementation,
  createSportsDataIoLiveNhlAdapterFunction,
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
      sportsDataIoLiveNhl,
      sportsDataIoFetchImplementation,
      createSportsDataIoLiveNhlAdapterFunction,
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
