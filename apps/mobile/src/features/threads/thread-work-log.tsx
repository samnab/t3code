import * as Haptics from "expo-haptics";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { ActivityIndicator, LayoutAnimation, Pressable, ScrollView, View } from "react-native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { AppText as Text } from "../../components/AppText";
import { scaledTypographyLineHeight } from "../../lib/appearancePreferences";
import { cn } from "../../lib/cn";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { useThemeColor } from "../../lib/useThemeColor";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import Animated, { FadeIn } from "react-native-reanimated";

const WORK_LOG_LAYOUT_ANIMATION = {
  duration: 180,
  create: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
} as const;

function triggerDisclosureFeedback() {
  LayoutAnimation.configureNext(WORK_LOG_LAYOUT_ANIMATION);
  void Haptics.selectionAsync();
}

function stripShellWrapper(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/bin\/zsh -lc ['"]?([\s\S]*?)['"]?$/);
  return (match?.[1] ?? trimmed).trim();
}

function compactActivityDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }

  const cleaned = stripShellWrapper(detail).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function workRowSymbolName(icon: ThreadFeedActivity["icon"]): AppSymbolName {
  switch (icon) {
    case "agent":
      return { ios: "sparkles", android: "auto_awesome" };
    case "alert":
      return { ios: "exclamationmark.triangle", android: "error" };
    case "check":
      return { ios: "checkmark", android: "check" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "eye":
      return { ios: "eye", android: "visibility" };
    case "globe":
      return { ios: "globe", android: "public" };
    case "hammer":
      return { ios: "hammer", android: "construction" };
    case "message":
      return { ios: "bubble.left", android: "chat_bubble" };
    case "warning":
      return { ios: "xmark", android: "close" };
    case "wrench":
      return { ios: "wrench", android: "build" };
    case "zap":
      return { ios: "bolt", android: "bolt" };
  }
}

// Entering fades only for rows created moments ago: rows remount whenever the
// list scrolls them back into view, and old rows must not replay an entrance.
const FRESH_ROW_WINDOW_MS = 3_000;
function isFreshRow(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ROW_WINDOW_MS;
}

// Tool-like activities with a neutral status carry no signal worth a row.
export function visibleWorkLogActivities(
  activities: ReadonlyArray<ThreadFeedActivity>,
): ReadonlyArray<ThreadFeedActivity> {
  return activities.filter((activity) => !(activity.toolLike && activity.status === "neutral"));
}

// Pre-measurement heights for the feed's getFixedItemSize. Collapsed work-log
// rows are single-line (numberOfLines={1}) inside a min-height that stays
// taller than the text at every supported base font size (text-xs reaches
// 23px at the 22pt maximum, under the 32px min-h-8), so row height is
// deterministic. The "work log" label has no such clamp — its height follows
// the scaled text-2xs line height. Values mirror the classNames below — keep
// them in sync; a mismatch only costs a one-time correction on measure.
const WORK_ROW_HEIGHT = 32; // min-h-8
const WORK_ROW_GAP = 1; // gap-px
const WORK_LOG_HEADER_PADDING = 2; // pb-0.5 under the "work log" label
const WORK_LOG_BOTTOM_MARGIN = 4; // mb-1

export const WORK_GROUP_TOGGLE_HEIGHT = 36; // min-h-8 (32) + mb-1 (4)

export function collapsedWorkLogHeight(
  activities: ReadonlyArray<ThreadFeedActivity>,
  baseFontSize: number,
): number {
  const rows = visibleWorkLogActivities(activities);
  if (rows.length === 0) {
    return 0;
  }
  const onlyToolRows = rows.every((row) => row.toolLike);
  const headerHeight =
    scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.caption, baseFontSize) + WORK_LOG_HEADER_PADDING;
  return (
    WORK_LOG_BOTTOM_MARGIN +
    (onlyToolRows ? 0 : headerHeight) +
    rows.length * WORK_ROW_HEIGHT +
    (rows.length - 1) * WORK_ROW_GAP
  );
}

// ── Phase 1.5 subagent transcript disclosure ─────────────────────────────
//
// Renders inside the existing collapsed subagent work-log row's expanded
// slot (see workEntryHasExpandedBody in threadActivity.ts). Only a row whose
// durable run identity/history metadata reports `historyAvailability:
// "durable"` gets a disclosure; every other row (capability absent, stock
// Pi, summary-only, no subagent identity) renders no transcript detail, per
// spec. Query state comes from the integrator-owned shared pull-only
// page/catch-up/poll glue (packages/client-runtime/src/state/orchestration.ts);
// this file never re-implements polling or multi-page catch-up locally.

/** True only for a collapsed subagent row whose durable history is proved
 * readable. Every other row (capability absent, summary-only, unavailable,
 * no subagent identity) gets no transcript disclosure. */
export function subagentTranscriptDisclosureAvailable(
  activity: Pick<ThreadFeedActivity, "subagentRun">,
): boolean {
  return activity.subagentRun?.historyAvailability === "durable";
}

export type SubagentTranscriptItemKind = "user" | "assistant" | "tool-result";

export interface SubagentTranscriptItemView {
  readonly id: string;
  readonly kind: SubagentTranscriptItemKind;
  readonly text: string;
  readonly truncated: boolean;
  readonly upstreamTruncated: boolean;
}

/** Distinct from a never-observed gap: an eviction range proves the item was
 * observed before its durable tombstone; a gap never was. */
export type SubagentTranscriptMarkerView =
  | { readonly kind: "eviction"; readonly id: string }
  | { readonly kind: "gap"; readonly id: string };

export type SubagentTranscriptRow =
  | { readonly type: "item"; readonly item: SubagentTranscriptItemView }
  | { readonly type: "marker"; readonly marker: SubagentTranscriptMarkerView };

/** Resolved shape of the anticipated shared query glue's success value. */
export interface SubagentTranscriptQueryData {
  readonly rows: ReadonlyArray<SubagentTranscriptRow>;
  readonly hasOlder: boolean;
  readonly loadOlder: () => void;
}

function transcriptItemKindLabel(kind: SubagentTranscriptItemKind): string {
  switch (kind) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "tool-result":
      return "Tool result";
  }
}

/** Pure and testable independent of the query hook: renders whatever state
 * (loading/error/empty/summary-only/items+markers/pagination) it is given. */
export function SubagentTranscriptList(props: {
  readonly data: SubagentTranscriptQueryData | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly summaryOnly: boolean;
}) {
  if (props.summaryOnly) {
    return (
      <Text className="px-0.5 text-2xs text-foreground-muted opacity-70">
        Transcript detail is unavailable for this run.
      </Text>
    );
  }
  if (props.error) {
    return <Text className="px-0.5 text-2xs text-rose-600 dark:text-rose-400">{props.error}</Text>;
  }
  if (props.data === null) {
    return props.loading ? (
      <View className="px-0.5 py-1">
        <ActivityIndicator size="small" />
      </View>
    ) : null;
  }
  if (props.data.rows.length === 0) {
    return (
      <Text className="px-0.5 text-2xs text-foreground-muted opacity-70">
        {props.loading ? "Loading transcript…" : "No transcript items."}
      </Text>
    );
  }

  return (
    <View className="gap-1.5 px-0.5">
      {props.data.rows.map((row) => {
        if (row.type === "marker") {
          return (
            <Text key={row.marker.id} className="text-2xs text-foreground-muted opacity-60">
              {row.marker.kind === "eviction" ? "· evicted history ·" : "· not observed ·"}
            </Text>
          );
        }
        const { item } = row;
        return (
          <View key={item.id} className="gap-0.5">
            <Text className="font-t3-medium text-2xs text-foreground-muted opacity-70">
              {transcriptItemKindLabel(item.kind)}
            </Text>
            <Text selectable className="text-xs leading-normal text-foreground">
              {item.text}
              {item.truncated || item.upstreamTruncated ? (
                <Text className="text-foreground-muted opacity-60"> (truncated)</Text>
              ) : null}
            </Text>
          </View>
        );
      })}
      {props.data.hasOlder ? (
        <Pressable accessibilityRole="button" onPress={props.data.loadOlder} hitSlop={4}>
          <Text className="font-t3-medium text-2xs text-foreground-muted opacity-80">
            Load older
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Mounted-only, non-continuous disclosure for one durable subagent run: fetch
 * only while this row is expanded, via the integrator-owned shared
 * pull-only page/catch-up/poll glue.
 *
 * ANTICIPATED SHARED ANCHOR: `orchestrationEnvironment.subagentTranscript`
 * (added to `createOrchestrationEnvironmentAtoms`'s return in
 * packages/client-runtime/src/state/orchestration.ts) must expose a query
 * atom keyed by `{ environmentId, threadId, runId }` whose resolved success
 * value is a `SubagentTranscriptQueryData` (rows already ordered/merged with
 * eviction/gap markers, `hasOlder`, bound `loadOlder`). The atom owns
 * negotiation-driven summary-only detection, >=1s polling while mounted and
 * nonterminal, the one bounded terminal catch-up, and stopping on unmount —
 * this component only renders whatever it returns.
 */
function SubagentTranscriptDisclosure(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: string;
}) {
  const transcriptAtom = orchestrationEnvironment.subagentTranscript({
    environmentId: props.environmentId,
    threadId: props.threadId,
    runId: props.runId,
  });
  const result = useEnvironmentQuery<SubagentTranscriptQueryData, unknown>(transcriptAtom);

  return (
    <SubagentTranscriptList
      data={result.data}
      loading={result.isPending}
      error={result.error}
      summaryOnly={false}
    />
  );
}

export function ThreadWorkLog(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly copiedRowId: string | null;
  readonly environmentId: EnvironmentId;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly threadId: ThreadId;
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleRow: (rowId: string) => void;
}) {
  const pressedBackground = useThemeColor("--color-subtle");
  const rows = visibleWorkLogActivities(props.activities).map((activity) => ({
    ...activity,
    detail: compactActivityDetail(activity.detail),
  }));

  if (rows.length === 0) {
    return null;
  }

  const onlyToolRows = rows.every((row) => row.toolLike);

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      {!onlyToolRows ? (
        <Text className="px-0.5 pb-0.5 font-t3-medium text-2xs text-foreground-muted opacity-60">
          work log
        </Text>
      ) : null}

      <View className="gap-px">
        {rows.map((row) => {
          const expanded = props.expandedRows[row.id] ?? false;
          const canExpand = row.canExpand;
          // A durable subagent row's expanded slot renders its transcript
          // disclosure, never the plain raw-text body (no transcript detail
          // on a summary-only row, and no mixing the two for a durable one).
          const transcriptRunId =
            expanded && subagentTranscriptDisclosureAvailable(row)
              ? (row.subagentRun?.runId ?? null)
              : null;
          const fullDetail = expanded && !transcriptRunId ? row.getFullDetail() : null;
          const displayText = row.detail ? `${row.summary} ${row.detail}` : row.summary;
          const iconIsDestructive = row.icon === "alert" || row.icon === "warning";

          return (
            <Animated.View
              key={row.id}
              {...(isFreshRow(row.createdAt) ? { entering: FadeIn.duration(200) } : {})}
            >
              <Pressable
                accessibilityRole={canExpand ? "button" : undefined}
                accessibilityLabel={displayText}
                accessibilityHint={
                  canExpand
                    ? "Double tap to show full details. Long press to copy."
                    : "Long press to copy."
                }
                accessibilityState={canExpand ? { expanded } : undefined}
                hitSlop={4}
                onPress={() => {
                  if (canExpand) {
                    triggerDisclosureFeedback();
                    props.onToggleRow(row.id);
                  }
                }}
                onLongPress={() => props.onCopyRow(row.id, row.getCopyText())}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? pressedBackground : "transparent",
                })}
                className="rounded-md px-0.5 py-0"
              >
                <View className="min-h-8 flex-row items-center gap-1.5">
                  <View className="h-[18px] w-5 shrink-0 items-center justify-center">
                    <SymbolView
                      name={workRowSymbolName(row.icon)}
                      size={13}
                      weight="medium"
                      tintColor={iconIsDestructive ? "#e11d48" : props.iconSubtleColor}
                      type="monochrome"
                    />
                  </View>

                  <Text className="min-w-0 flex-1 text-xs text-foreground" numberOfLines={1}>
                    <Text
                      className={cn(
                        "font-t3-medium text-foreground",
                        iconIsDestructive && "text-rose-600 dark:text-rose-400",
                      )}
                    >
                      {row.summary}
                    </Text>
                    {row.detail ? (
                      <Text className="text-foreground-muted opacity-60"> {row.detail}</Text>
                    ) : null}
                  </Text>

                  <View className="shrink-0 flex-row items-center gap-px">
                    {props.copiedRowId === row.id ? (
                      <Text className="pr-1 font-t3-medium text-3xs text-emerald-600 dark:text-emerald-400">
                        Copied
                      </Text>
                    ) : null}
                    <View className="h-4 w-4 items-center justify-center">
                      {canExpand ? (
                        <SymbolView
                          name={
                            expanded
                              ? { ios: "chevron.up", android: "keyboard_arrow_up" }
                              : { ios: "chevron.down", android: "keyboard_arrow_down" }
                          }
                          size={11}
                          tintColor={props.iconSubtleColor}
                          type="monochrome"
                        />
                      ) : null}
                    </View>
                    <View className="h-4 w-4 items-center justify-center">
                      {row.status ? (
                        <SymbolView
                          name={
                            row.status === "failure"
                              ? { ios: "xmark", android: "close" }
                              : row.status === "success"
                                ? { ios: "checkmark", android: "check" }
                                : { ios: "minus", android: "remove" }
                          }
                          size={11}
                          tintColor={row.status === "failure" ? "#e11d48" : props.iconSubtleColor}
                          type="monochrome"
                        />
                      ) : null}
                    </View>
                  </View>
                </View>
              </Pressable>

              {transcriptRunId ? (
                <View className="ml-7 border-l border-neutral-300/60 pb-1 pl-3 pt-0.5 dark:border-white/[0.12]">
                  <SubagentTranscriptDisclosure
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                    runId={transcriptRunId}
                  />
                </View>
              ) : fullDetail ? (
                <View className="ml-7 border-l border-neutral-300/60 pb-1 pl-3 pt-0.5 dark:border-white/[0.12]">
                  <ScrollView
                    nestedScrollEnabled
                    directionalLockEnabled
                    showsVerticalScrollIndicator
                    className="max-h-60"
                    contentContainerStyle={{ paddingRight: 8 }}
                  >
                    <Text
                      selectable
                      className="font-mono text-2xs leading-normal text-foreground-muted"
                    >
                      {fullDetail}
                    </Text>
                  </ScrollView>
                </View>
              ) : null}
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

export function ThreadWorkGroupToggle(props: {
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly onlyToolActivities: boolean;
  readonly onToggle: () => void;
}) {
  const pressedBackground = useThemeColor("--color-subtle");
  const noun = props.onlyToolActivities
    ? props.hiddenCount === 1
      ? "tool call"
      : "tool calls"
    : props.hiddenCount === 1
      ? "log entry"
      : "log entries";
  const collapsedLabel = `Show ${props.hiddenCount} previous ${noun}`;
  const expandedLabel = props.onlyToolActivities
    ? "Show fewer tool calls"
    : "Show fewer log entries";

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel={props.expanded ? expandedLabel : collapsedLabel}
        hitSlop={4}
        onPress={() => {
          void Haptics.selectionAsync();
          props.onToggle();
        }}
        style={({ pressed }) => ({
          backgroundColor: pressed ? pressedBackground : "transparent",
        })}
        className="min-h-8 flex-row items-center gap-1.5 rounded-md px-0.5 py-0"
      >
        <View className="h-[18px] w-5 items-center justify-center">
          <SymbolView
            name={
              props.expanded
                ? { ios: "chevron.up", android: "keyboard_arrow_up" }
                : { ios: "chevron.down", android: "keyboard_arrow_down" }
            }
            size={12}
            tintColor={props.iconSubtleColor}
            type="monochrome"
          />
        </View>
        <Text className="font-t3-medium text-xs text-foreground opacity-80">
          {props.expanded ? expandedLabel : `+${props.hiddenCount} previous ${noun}`}
        </Text>
      </Pressable>
    </View>
  );
}
