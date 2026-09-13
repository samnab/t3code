import { randomUUID } from "node:crypto";

import { CommandId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import { readMcpProviderSession } from "../mcp/McpProviderSession.ts";
import { sanitizeSubagentTranscriptField } from "../persistence/subagentTranscriptSanitization.ts";
import {
  ACTIVATION_COMMAND_PREFIX,
  PROGRESS_COMMAND_PREFIX,
} from "./ExperimentLifecycleReactor.ts";
import { ExperimentCoordinator } from "./ExperimentService.ts";
import { ExperimentError } from "./Model.ts";

function failure(message: string, cause?: unknown) {
  return new ExperimentError({
    code: "persistence_failed",
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

const ARGUMENT_DETAIL =
  /\b(?:argv|arguments?)\s*[:=]\s*(?:\[[^\]\r\n]*\]|"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n;]+)/giu;

export function translateExperimentCoordinatorFailure(message: string, cause: unknown) {
  const causeMessage = cause instanceof Error ? cause.message.trim() : "";
  const withoutArguments = causeMessage.replace(ARGUMENT_DETAIL, "argv=[REDACTED]");
  const detail = sanitizeSubagentTranscriptField(withoutArguments, 512).text.trim();
  const publicMessage = detail.length > 0 ? `${message} ${detail}` : message;
  return failure(sanitizeSubagentTranscriptField(publicMessage, 2_000).text, cause);
}

const translate = <A, E, R>(message: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => translateExperimentCoordinatorFailure(message, cause)));

function commandId(prefix: string, threadId: string) {
  return CommandId.make(`${prefix}${threadId}:${randomUUID()}`);
}

export function resolveExperimentGoalLoopMode(input: {
  readonly providerDriver: string | null | undefined;
  readonly providerInstanceId: string;
}) {
  return input.providerDriver === "codex" ||
    (input.providerDriver == null && input.providerInstanceId === "codex")
    ? ("native" as const)
    : ("t3" as const);
}

export const layer = Layer.effect(
  ExperimentCoordinator,
  Effect.gen(function* () {
    const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const providerSessions = yield* ProviderService.ExperimentProviderSessionService;

    const resolveShell = Effect.fn("ExperimentCoordinator.resolveShell")(function* (
      rawThreadId: string,
    ) {
      const threadId = ThreadId.make(rawThreadId);
      const thread = Option.getOrUndefined(
        yield* translate(
          "Could not read the experiment thread.",
          snapshots.getThreadShellById(threadId),
        ),
      );
      if (thread === undefined) return yield* failure("Experiment thread was not found.");
      const project = Option.getOrUndefined(
        yield* translate(
          "Could not read the experiment project.",
          snapshots.getProjectShellById(thread.projectId),
        ),
      );
      if (project === undefined) return yield* failure("Experiment project was not found.");
      return { thread, cwd: thread.worktreePath ?? project.workspaceRoot };
    });

    return ExperimentCoordinator.of({
      resolveThread: (rawThreadId) =>
        Effect.gen(function* () {
          const { thread, cwd } = yield* resolveShell(rawThreadId);
          const session = thread.session;
          const mcpSession = readMcpProviderSession(thread.id);
          const driver = session?.providerName ?? "unknown";
          const supported =
            driver === "claudeAgent" ||
            driver === "pi" ||
            (driver === "codex" && (process.platform === "darwin" || process.platform === "linux"));
          return {
            threadId: rawThreadId,
            cwd,
            providerInstanceId: String(
              session?.providerInstanceId ?? thread.modelSelection.instanceId,
            ),
            providerSessionId:
              mcpSession?.providerSessionId ??
              `${String(session?.providerInstanceId ?? thread.modelSelection.instanceId)}:${session?.updatedAt ?? thread.updatedAt}`,
            ...(mcpSession?.experiment === undefined
              ? {}
              : { providerGeneration: mcpSession.experiment.generation }),
            providerDriver: driver,
            providerSupported: supported,
            ...(supported
              ? {}
              : {
                  unsupportedReason:
                    driver === "codex"
                      ? `Codex experiment sandboxing is unavailable on ${process.platform}.`
                      : `Provider driver ${driver} does not expose restricted experiment tools.`,
                }),
            idle:
              session !== null &&
              session.status !== "running" &&
              session.status !== "starting" &&
              !thread.hasPendingApprovals &&
              !thread.hasPendingUserInput &&
              !thread.hasActionableProposedPlan,
            pendingChildRun: thread.backgroundLiveness === "working",
          };
        }),
      startProvider: (input) =>
        Effect.gen(function* () {
          const { thread } = yield* resolveShell(input.threadId);
          const started = yield* translate(
            "Could not start the restricted experiment provider session.",
            providerSessions.start({
              threadId: ThreadId.make(input.threadId),
              providerInstanceId: ProviderInstanceId.make(input.providerInstanceId),
              cwd: input.cwd,
              runId: input.runId,
              generation: input.generation,
              modelSelection: thread.modelSelection,
              voiceNotifications: thread.voiceNotifications,
            }),
          );
          return started.identity;
        }),
      stopProvider: (input) =>
        translate(
          "Could not stop the restricted experiment provider session.",
          providerSessions.stop({ threadId: ThreadId.make(input.threadId), runId: input.runId }),
        ),
      activateGoal: (input) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make(input.threadId);
          const { thread } = yield* resolveShell(input.threadId);
          const mode = resolveExperimentGoalLoopMode({
            providerDriver: thread.session?.providerName,
            providerInstanceId: thread.modelSelection.instanceId,
          });
          yield* translate(
            "Could not activate the experiment goal.",
            engine.dispatch({
              type: "thread.meta.update",
              commandId: commandId(ACTIVATION_COMMAND_PREFIX, input.threadId),
              threadId,
              goal: input.objective,
            }),
          );
          yield* translate(
            "Could not activate the experiment goal loop.",
            engine.dispatch({
              type: "thread.goal.loop",
              commandId: commandId("server:experiment-loop:", input.threadId),
              threadId,
              action: "sync",
              state: "idle",
              mode,
              kind: "experiment",
              experiment: input.summary,
            }),
          );
          yield* translate(
            "Could not start the experiment goal loop.",
            engine.dispatch({
              type: "thread.goal.loop",
              commandId: commandId("server:experiment-start:", input.threadId),
              threadId,
              action: "resume",
            }),
          );
        }),
      syncSummary: (input) =>
        translate(
          "Could not synchronize experiment progress.",
          engine.dispatch({
            type: "thread.goal.loop",
            commandId: commandId(PROGRESS_COMMAND_PREFIX, input.threadId),
            threadId: ThreadId.make(input.threadId),
            action: "sync",
            kind: "experiment",
            experiment: input.summary,
          }),
        ).pipe(Effect.asVoid),
      holdGoal: (input) =>
        translate(
          "Could not hold the experiment goal loop.",
          engine.dispatch({
            type: "thread.goal.loop",
            commandId: commandId(`server:experiment-${input.action}:`, input.threadId),
            threadId: ThreadId.make(input.threadId),
            action: input.action,
            reason: input.reason,
          }),
        ).pipe(Effect.asVoid),
    });
  }),
);
