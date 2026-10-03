import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface MigrationRow {
  readonly migration_id: number;
  readonly name: string;
}

const upstreamHistory = [
  [1, "OrchestrationEvents"],
  [2, "OrchestrationCommandReceipts"],
  [3, "CheckpointDiffBlobs"],
  [4, "ProviderSessionRuntime"],
  [5, "Projections"],
  [6, "ProjectionThreadSessionRuntimeModeColumns"],
  [7, "ProjectionThreadMessageAttachments"],
  [8, "ProjectionThreadActivitySequence"],
  [9, "ProviderSessionRuntimeMode"],
  [10, "ProjectionThreadsRuntimeMode"],
  [11, "OrchestrationThreadCreatedRuntimeMode"],
  [12, "ProjectionThreadsInteractionMode"],
  [13, "ProjectionThreadProposedPlans"],
  [14, "ProjectionThreadProposedPlanImplementation"],
  [15, "ProjectionTurnsSourceProposedPlan"],
  [16, "CanonicalizeModelSelections"],
  [17, "ProjectionThreadsArchivedAt"],
  [18, "ProjectionThreadsArchivedAtIndex"],
  [19, "ProjectionSnapshotLookupIndexes"],
  [20, "AuthAccessManagement"],
  [21, "AuthSessionClientMetadata"],
  [22, "AuthSessionLastConnectedAt"],
  [23, "ProjectionThreadShellSummary"],
  [24, "BackfillProjectionThreadShellSummary"],
  [25, "CleanupInvalidProjectionPendingApprovals"],
  [26, "CanonicalizeModelSelectionOptions"],
  [27, "ProviderSessionRuntimeInstanceId"],
  [28, "ProjectionThreadSessionInstanceId"],
  [29, "ProjectionThreadDetailOrderingIndexes"],
  [30, "ProjectionThreadShellArchiveIndexes"],
  [31, "AuthAuthorizationScopes"],
  [32, "AuthPairingProofKeyThumbprint"],
  [33, "ProjectionThreadsSettled"],
  [34, "ProjectionThreadsSnoozed"],
  [35, "ProjectionThreadTitleRegeneration"],
  [36, "ProjectionThreadsPinned"],
  [37, "ProjectionTurnsKeysetIndex"],
  [38, "ProjectionThreadsPinOrderKey"],
  [39, "ProjectionProjectsDefaultThreadEnvMode"],
  [40, "ProjectionProjectFaviconPath"],
  [41, "AuthSessionClientConnection"],
  [42, "ProjectionThreadLinkedPullRequest"],
  [43, "ProjectionThreadsUnsettledAt"],
  [44, "ClearAutomaticProjectModelDefaults"],
  [45, "ProjectionProjectsAutoPull"],
  [46, "RepairAutomaticSettlementTimestamps"],
  [47, "ProjectionProjectIcon"],
  [48, "ProjectionThreadBranchPullRequest"],
  [49, "ProjectionThreadsActiveOrderKey"],
  [50, "ProjectionThreadPullRequests"],
  [51, "ProjectionThreadMessageContext"],
  [52, "ProjectionThreadTitleState"],
  [53, "PullRequestFilesViewed"],
  [54, "ProjectionThreadsAutoSettleDisabledAt"],
  [55, "OrchestrationV2"],
  [56, "RemoveRedundantProjectionIndexes"],
] as const;

const forkHistory = [
  [46, "ProjectionSubagentRuns"],
  [47, "ProjectionThreadGoal"],
  [48, "ProjectionSubagentTranscripts"],
  [49, "ProjectionThreadsVoiceNotifications"],
  [50, "ProjectionThreadGoalLoop"],
  [51, "NativeChildRuns"],
  [52, "ProjectionThreadMessagesOrigin"],
  [53, "RepairAutomaticSettlementTimestamps"],
  [54, "ProjectionProjectIcon"],
  [55, "ProjectionThreadBranchPullRequest"],
  [56, "ProjectionThreadsActiveOrderKey"],
  [57, "ThreadExperiments"],
  [58, "NativeChildRunOptions"],
  [59, "NativeChildMessaging"],
  [60, "NativeChildDeliveryBatches"],
  [61, "ProjectionThreadPullRequests"],
  [62, "ProjectionThreadMessageContext"],
  [63, "ProjectionThreadTitleState"],
  [64, "ProjectionProjectsSchedules"],
  [65, "PullRequestFilesViewed"],
  [66, "ProjectionSubagentRunsFastMode"],
  [67, "ProjectionThreadsAutoSettleDisabledAt"],
] as const;

const rewrites = [
  [53, 46, "RepairAutomaticSettlementTimestamps"],
  [54, 47, "ProjectionProjectIcon"],
  [55, 48, "ProjectionThreadBranchPullRequest"],
  [56, 49, "ProjectionThreadsActiveOrderKey"],
  [61, 50, "ProjectionThreadPullRequests"],
  [62, 51, "ProjectionThreadMessageContext"],
  [63, 52, "ProjectionThreadTitleState"],
  [65, 53, "PullRequestFilesViewed"],
  [67, 54, "ProjectionThreadsAutoSettleDisabledAt"],
] as const;

const noMigrations: ReadonlyArray<readonly [number, string]> = [];

const matches = (
  rows: ReadonlyArray<MigrationRow>,
  expected: ReadonlyArray<readonly [number, string]>,
) =>
  rows.length === expected.length &&
  rows.every(
    (row, index) => row.migration_id === expected[index]?.[0] && row.name === expected[index]?.[1],
  );

const isUpstreamHistory = (rows: ReadonlyArray<MigrationRow>) =>
  rows.length <= upstreamHistory.length &&
  rows.every(
    (row, index) =>
      row.migration_id === upstreamHistory[index]?.[0] && row.name === upstreamHistory[index]?.[1],
  );

const isExactForkHistory = (rows: ReadonlyArray<MigrationRow>) =>
  rows.length === 67 &&
  rows.slice(0, 45).every((row, index) => row.migration_id === index + 1) &&
  matches(rows.slice(45), forkHistory);

const badState = (message: string) =>
  new Migrator.MigrationError({
    kind: "BadState",
    message,
  });

/**
 * Repairs the released fork's colliding migration ids before orchestration v2 runs.
 */
export const reconcileForkMigrationLedger = Effect.fn("reconcileForkMigrationLedger")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reconciled = yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
      if (tables.length === 0) return false;

      const history = yield* sql<MigrationRow>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      if (history.some((row) => row.migration_id > 67)) {
        return yield* badState(
          "Cannot reconcile fork migration ledger with migrations newer than the supported fork signature.",
        );
      }
      if (isUpstreamHistory(history)) return false;

      const v2Tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'orchestration_v2_events'
      `;
      const hasForkRows = history.some((row) =>
        forkHistory.some(
          ([migrationId, name]) => row.migration_id === migrationId && row.name === name,
        ),
      );
      if (hasForkRows && v2Tables.length > 0) {
        return yield* badState(
          "Cannot reconcile fork migration ledger after orchestration v2 tables exist.",
        );
      }
      if (!isExactForkHistory(history)) {
        return yield* badState(
          "Cannot reconcile migration ledger because it does not match the exact supported fork signature.",
        );
      }

      yield* sql`
        DELETE FROM effect_sql_migrations
        WHERE migration_id IN (46, 47, 48, 49, 50, 51, 52, 57, 58, 59, 60, 64, 66)
      `;
      for (const [sourceId, targetId, name] of rewrites) {
        yield* sql`
          UPDATE effect_sql_migrations
          SET migration_id = ${targetId}
          WHERE migration_id = ${sourceId} AND name = ${name}
        `;
      }

      yield* sql`DROP TABLE IF EXISTS native_child_delivery_batch_runs`;
      yield* sql`DROP TABLE IF EXISTS native_child_delivery_batches`;
      yield* sql`DROP TABLE IF EXISTS native_child_messages`;
      yield* sql`DROP TABLE IF EXISTS native_child_runs`;
      yield* sql`DROP TABLE IF EXISTS subagent_transcript_items`;
      yield* sql`DROP TABLE IF EXISTS subagent_transcript_evictions`;
      yield* sql`DROP TABLE IF EXISTS projection_subagent_runs`;
      yield* sql`DROP TABLE IF EXISTS subagent_run_number_reservations`;
      yield* sql`DROP TABLE IF EXISTS thread_experiments`;

      const reconciledHistory = yield* sql<MigrationRow>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
      `;
      if (!matches(reconciledHistory, upstreamHistory.slice(0, 54))) {
        return yield* badState(
          "Fork migration ledger reconciliation did not produce the expected upstream history through migration 54.",
        );
      }
      return true;
    }),
  );

  if (reconciled) {
    yield* Effect.log("Fork migration ledger reconciled").pipe(
      Effect.annotateLogs({
        deletedMigrationCount: 13,
        renamedMigrationCount: 9,
        droppedTableCount: 9,
      }),
    );
  }
  return noMigrations;
});
