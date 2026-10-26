import { describeRealtimeVoiceCapture } from "@t3tools/shared/orchestrationV2Timeline";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { View, type ColorValue, type DimensionValue } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { CopyTextButton } from "./CopyTextButton";
import { ThreadContextDivider } from "./thread-context-divider";

/**
 * Spoken lines look like messages but stay history: plain selectable text, copy only, no edit,
 * fork, or markdown actions. The entry that opens a call also carries the call divider. A request
 * promoted into a coding message shows as that message, so its entry keeps only the divider.
 */
export function ThreadVoiceTranscriptRow({
  entry,
  timestampLabel,
  callStartedLabel,
  iconColor,
  userBubbleColor,
  bubbleMaxWidth,
}: {
  readonly entry: Extract<ThreadFeedEntry, { type: "realtime-voice" }>;
  readonly timestampLabel: string;
  readonly callStartedLabel: string | null;
  readonly iconColor: ColorValue;
  readonly userBubbleColor: ColorValue;
  readonly bubbleMaxWidth: DimensionValue;
}) {
  const { item } = entry.projectedItem;
  if (item.type !== "realtime_voice") return null;
  const call = entry.call;
  const divider =
    call === undefined ? null : (
      <View>
        <ThreadContextDivider
          label={[
            "Voice call",
            callStartedLabel,
            call.durationMs === null ? null : formatDuration(call.durationMs),
            call.failed ? "failed" : null,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
          icon="mic"
          iconColor={iconColor}
          failed={call.failed}
        />
        {call.historyWarning === null ? null : (
          <Text className="-mt-2 mb-3 px-1 text-center text-xs text-warning-foreground">
            Voice history incomplete. {call.historyWarning}
          </Text>
        )}
      </View>
    );
  const content = item.content;
  if (content.type !== "transcriptSegment" || entry.promotedToCodingRequest) return divider;

  const isUser = content.role === "user";
  const capture = describeRealtimeVoiceCapture(item);
  // Partial text must say so; the rest of the capture detail stays in the accessibility hint.
  const state =
    item.captureState === "interrupted"
      ? "interrupted"
      : item.captureState === "incomplete"
        ? "incomplete"
        : null;
  const meta = (
    <View
      className={
        isUser
          ? "mt-1 flex-row items-center justify-end gap-1 pr-0.5"
          : "mt-1 flex-row items-center gap-1"
      }
    >
      <View
        accessible
        accessibilityLabel={`Spoken in a voice call${state === null ? "" : `, ${state}`}`}
        accessibilityHint={capture.detail}
        className="flex-row items-center gap-1"
      >
        <SymbolView name="mic" size={12} tintColor={iconColor} />
        <Text className="font-t3-medium text-xs text-foreground-secondary">
          {state === null ? "Voice" : `Voice · ${state}`}
        </Text>
      </View>
      <Text className="font-t3-medium text-xs tabular-nums text-foreground-secondary">
        · {timestampLabel}
      </Text>
      <CopyTextButton
        accessibilityLabel="Copy voice transcript"
        text={content.text}
        tintColor={iconColor}
        buttonSize={28}
        iconSize={13}
      />
    </View>
  );

  return (
    <>
      {divider}
      {isUser ? (
        <View className="mb-5 items-end">
          <View
            className="min-w-0 rounded-[20px] px-3.5 py-2.5"
            style={{ backgroundColor: userBubbleColor, maxWidth: bubbleMaxWidth }}
          >
            <Text selectable className="text-base leading-6 text-user-bubble-foreground">
              {content.text}
            </Text>
          </View>
          {meta}
        </View>
      ) : (
        <View className="mb-5 px-1">
          <Text selectable className="text-base leading-6">
            {content.text}
          </Text>
          {meta}
        </View>
      )}
    </>
  );
}
