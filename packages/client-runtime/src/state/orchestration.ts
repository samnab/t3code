import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  RuntimeTaskId,
  ThreadId,
  type OrchestrationGetSubagentTranscriptResult,
  type SubagentTranscriptPageEntry,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import { type EnvironmentRegistry } from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import {
  createEnvironmentRpcQueryAtomFamily,
  environmentRpcKey,
  followStreamInEnvironment,
} from "./runtime.ts";

const TRANSCRIPT_POLL_INTERVAL = Duration.seconds(1);
const TERMINAL_RETAINED_ITEM_LIMIT = 500;

const SubagentTranscriptTarget = Schema.Struct({
  environmentId: EnvironmentId,
  input: Schema.Struct({
    threadId: ThreadId,
    runId: RuntimeTaskId,
    terminal: Schema.Boolean,
  }),
});

type SubagentTranscriptTarget = typeof SubagentTranscriptTarget.Type;

export interface SubagentTranscriptView {
  readonly entries: ReadonlyArray<SubagentTranscriptPageEntry>;
  readonly watermark: number;
  readonly hasOlder: boolean;
  readonly isLoadingOlder: boolean;
  readonly terminalCatchUpComplete: boolean;
}

interface TranscriptAccumulator extends SubagentTranscriptView {
  readonly liveCursor: number;
}

type TranscriptLoopState =
  | { readonly phase: "initial" }
  | { readonly phase: "waiting"; readonly value: TranscriptAccumulator }
  | { readonly phase: "loadingOlder"; readonly value: TranscriptAccumulator }
  | { readonly phase: "done"; readonly value: TranscriptAccumulator };

const decodeTargetKey = Schema.decodeUnknownSync(Schema.fromJsonString(SubagentTranscriptTarget));

const entryBounds = (entry: SubagentTranscriptPageEntry) =>
  "transcriptSequence" in entry
    ? { start: entry.transcriptSequence, end: entry.transcriptSequence }
    : { start: entry.fromSequence, end: entry.toSequence };

const entryKey = (entry: SubagentTranscriptPageEntry) => {
  if ("transcriptSequence" in entry) return `item:${entry.transcriptSequence}`;
  return `${entry.kind}:${entry.fromSequence}:${entry.toSequence}`;
};

const sortAndDedupeEntries = (entries: ReadonlyArray<SubagentTranscriptPageEntry>) => {
  const unique = new Map<string, SubagentTranscriptPageEntry>();
  for (const entry of entries) unique.set(entryKey(entry), entry);
  return [...unique.values()].sort((left, right) => {
    const leftBounds = entryBounds(left);
    const rightBounds = entryBounds(right);
    return leftBounds.start - rightBounds.start || leftBounds.end - rightBounds.end;
  });
};

const subtractWindow = (
  entry: SubagentTranscriptPageEntry,
  fromSequence: number,
  toSequence: number,
): ReadonlyArray<SubagentTranscriptPageEntry> => {
  const bounds = entryBounds(entry);
  if (bounds.end < fromSequence || bounds.start > toSequence) return [entry];
  if ("transcriptSequence" in entry) return [];
  const fragments = new Array<SubagentTranscriptPageEntry>();
  if (entry.fromSequence < fromSequence) {
    fragments.push({
      ...entry,
      toSequence: fromSequence - 1,
    });
  }
  if (entry.toSequence > toSequence) {
    fragments.push({
      ...entry,
      fromSequence: toSequence + 1,
    });
  }
  return fragments;
};

const replaceEntryWindow = (
  existing: ReadonlyArray<SubagentTranscriptPageEntry>,
  incoming: ReadonlyArray<SubagentTranscriptPageEntry>,
  fromSequence: number,
  toSequence: number,
) =>
  sortAndDedupeEntries([
    ...existing.flatMap((entry) => subtractWindow(entry, fromSequence, toSequence)),
    ...incoming,
  ]);

const lowestSequence = (entries: ReadonlyArray<SubagentTranscriptPageEntry>) =>
  entries.length === 0 ? undefined : Math.min(...entries.map((entry) => entryBounds(entry).start));

const highestSequence = (entries: ReadonlyArray<SubagentTranscriptPageEntry>) =>
  entries.length === 0 ? undefined : Math.max(...entries.map((entry) => entryBounds(entry).end));

const retainedItemCount = (entries: ReadonlyArray<SubagentTranscriptPageEntry>) =>
  entries.filter((entry) => "transcriptSequence" in entry).length;

const initialAccumulator = (
  page: OrchestrationGetSubagentTranscriptResult,
): TranscriptAccumulator => ({
  entries: sortAndDedupeEntries(page.entries),
  watermark: page.watermark,
  hasOlder: page.hasMore,
  isLoadingOlder: false,
  terminalCatchUpComplete: false,
  liveCursor: highestSequence(page.entries) ?? 0,
});

const mergeForwardPage = (
  value: TranscriptAccumulator,
  page: OrchestrationGetSubagentTranscriptResult,
  afterSequence: number,
): TranscriptAccumulator => {
  const pageEnd = highestSequence(page.entries);
  return {
    ...value,
    entries:
      pageEnd === undefined
        ? value.entries
        : replaceEntryWindow(value.entries, page.entries, afterSequence + 1, pageEnd),
    watermark: Math.max(value.watermark, page.watermark),
    liveCursor: Math.max(value.liveCursor, pageEnd ?? value.liveCursor),
  };
};

const mergeOlderPage = (
  value: TranscriptAccumulator,
  page: OrchestrationGetSubagentTranscriptResult,
  beforeSequence: number,
): TranscriptAccumulator => {
  const pageStart = lowestSequence(page.entries);
  return {
    ...value,
    entries:
      pageStart === undefined
        ? value.entries
        : replaceEntryWindow(value.entries, page.entries, pageStart, beforeSequence - 1),
    watermark: Math.max(value.watermark, page.watermark),
    hasOlder: page.hasMore,
    liveCursor: Math.max(value.liveCursor, highestSequence(page.entries) ?? value.liveCursor),
  };
};

const publicView = (value: TranscriptAccumulator): SubagentTranscriptView => ({
  entries: value.entries,
  watermark: value.watermark,
  hasOlder: value.hasOlder,
  isLoadingOlder: value.isLoadingOlder,
  terminalCatchUpComplete: value.terminalCatchUpComplete,
});

const controllerKey = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly threadId: ThreadId; readonly runId: RuntimeTaskId };
}) =>
  environmentRpcKey({
    environmentId: target.environmentId,
    input: { threadId: target.input.threadId, runId: target.input.runId },
  });

export function createOrchestrationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const olderControllers = new Map<string, () => boolean>();
  const transcriptFamily = Atom.family((key: string) => {
    const target = decodeTargetKey(key);
    const baseControllerKey = controllerKey(target);
    const transcriptStream = Stream.unwrap(
      Effect.gen(function* () {
        const olderRequests = yield* Queue.sliding<void>(1);
        const context = yield* Effect.context<never>();
        const runFork = Effect.runForkWith(context);
        const requestOlder = () => {
          runFork(Queue.offer(olderRequests, undefined));
          return true;
        };
        olderControllers.set(baseControllerKey, requestOlder);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (olderControllers.get(baseControllerKey) === requestOlder) {
              olderControllers.delete(baseControllerKey);
            }
          }),
        );

        const fetchPage = (input: {
          readonly afterSequence?: number;
          readonly beforeSequence?: number;
        }) =>
          request(ORCHESTRATION_WS_METHODS.getSubagentTranscript, {
            threadId: target.input.threadId,
            runId: target.input.runId,
            ...input,
          });

        const reconcileAdvancedWatermark = Effect.fnUntraced(function* (
          value: TranscriptAccumulator,
          previousWatermark: number,
        ) {
          let next = value;
          let cursor = previousWatermark;
          for (let pageIndex = 0; pageIndex < 3 && cursor < next.watermark; pageIndex += 1) {
            const page = yield* fetchPage({ afterSequence: cursor });
            const pageEnd = highestSequence(page.entries);
            next = mergeForwardPage(next, page, cursor);
            if (pageEnd === undefined || pageEnd <= cursor) break;
            cursor = pageEnd;
            if (!page.hasMore && cursor >= next.watermark) break;
          }
          return next;
        });

        const pollTail = Effect.fnUntraced(function* (value: TranscriptAccumulator) {
          const page = yield* fetchPage({ afterSequence: value.liveCursor });
          let next = mergeForwardPage(value, page, value.liveCursor);
          if (next.liveCursor < next.watermark) {
            next = yield* reconcileAdvancedWatermark(next, next.liveCursor);
          }
          return next;
        });

        const terminalCatchUp = Effect.fnUntraced(function* (value: TranscriptAccumulator) {
          let next = yield* pollTail(value);
          for (
            let pageIndex = 0;
            pageIndex < TERMINAL_RETAINED_ITEM_LIMIT &&
            next.hasOlder &&
            retainedItemCount(next.entries) < TERMINAL_RETAINED_ITEM_LIMIT;
            pageIndex += 1
          ) {
            const beforeSequence = lowestSequence(next.entries);
            if (beforeSequence === undefined || beforeSequence <= 1) break;
            const page = yield* fetchPage({ beforeSequence });
            const pageStart = lowestSequence(page.entries);
            next = mergeOlderPage(next, page, beforeSequence);
            if (pageStart === undefined || pageStart >= beforeSequence) break;
          }
          return {
            ...next,
            isLoadingOlder: false,
            terminalCatchUpComplete: true,
          };
        });

        return Stream.unfold({ phase: "initial" } as TranscriptLoopState, (state) =>
          Effect.gen(function* () {
            switch (state.phase) {
              case "initial": {
                const page = yield* fetchPage({});
                let value = initialAccumulator(page);
                if (target.input.terminal) value = yield* terminalCatchUp(value);
                return [
                  publicView(value),
                  target.input.terminal
                    ? ({ phase: "done", value } as const)
                    : ({ phase: "waiting", value } as const),
                ] as const;
              }
              case "waiting": {
                const action = yield* Effect.raceFirst(
                  Queue.take(olderRequests).pipe(Effect.as("older" as const)),
                  Effect.sleep(TRANSCRIPT_POLL_INTERVAL).pipe(Effect.as("poll" as const)),
                );
                if (action === "older") {
                  const value = { ...state.value, isLoadingOlder: true };
                  return [publicView(value), { phase: "loadingOlder", value }] as const;
                }
                const value = yield* pollTail(state.value);
                return [publicView(value), { phase: "waiting", value }] as const;
              }
              case "loadingOlder": {
                const beforeSequence = lowestSequence(state.value.entries);
                if (!state.value.hasOlder || beforeSequence === undefined || beforeSequence <= 1) {
                  const value = { ...state.value, hasOlder: false, isLoadingOlder: false };
                  return [publicView(value), { phase: "waiting", value }] as const;
                }
                const page = yield* fetchPage({ beforeSequence });
                const value = {
                  ...mergeOlderPage(state.value, page, beforeSequence),
                  isLoadingOlder: false,
                };
                return [publicView(value), { phase: "waiting", value }] as const;
              }
              case "done":
                return undefined;
            }
          }),
        );
      }),
    );

    return runtime
      .atom(followStreamInEnvironment(target.environmentId, transcriptStream))
      .pipe(
        Atom.setIdleTTL(0),
        Atom.withLabel(`environment-data:orchestration:subagent-transcript:${key}`),
      );
  });

  const subagentTranscript = (target: SubagentTranscriptTarget) =>
    transcriptFamily(JSON.stringify(target));

  const requestOlderSubagentTranscript = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId; readonly runId: RuntimeTaskId };
  }) => olderControllers.get(controllerKey(target))?.() ?? false;

  return {
    turnDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:turn-diff",
      tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
    }),
    workflowScript: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:workflow-script",
      tag: ORCHESTRATION_WS_METHODS.getWorkflowScript,
      // Scripts are immutable per run: cache generously.
      staleTimeMs: 300_000,
      idleTtlMs: 300_000,
    }),
    fullThreadDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:full-thread-diff",
      tag: ORCHESTRATION_WS_METHODS.getFullThreadDiff,
    }),
    threadSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:thread-search",
      tag: ORCHESTRATION_WS_METHODS.searchThreads,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    archivedShellSnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:orchestration:archived-shell-snapshot",
      tag: ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
    }),
    subagentTranscript,
    requestOlderSubagentTranscript,
  };
}
