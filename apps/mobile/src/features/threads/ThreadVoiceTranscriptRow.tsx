import { describeRealtimeVoiceCapture } from "@t3tools/shared/orchestrationV2Timeline";
import { View, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { CopyTextButton } from "./CopyTextButton";
import { ThreadContextDivider } from "./thread-context-divider";

/** Historical provider speech stays outside message actions and markdown execution links. */
export function ThreadVoiceTranscriptRow({
  entry,
  timestampLabel,
  iconColor,
}: {
  readonly entry: Extract<ThreadFeedEntry, { type: "realtime-voice" }>;
  readonly timestampLabel: string;
  readonly iconColor: ColorValue;
}) {
  const { item, visibility } = entry.projectedItem;
  if (item.type !== "realtime_voice") return null;
  const content = item.content;
  if (content.type === "bemItemPromoted") return null;
  if (content.type !== "transcriptSegment") {
    return (
      <ThreadContextDivider
        label={
          content.type === "realtimeSessionStarted"
            ? "Voice conversation started"
            : content.outcome === "failed"
              ? "Voice conversation failed"
              : "Voice conversation ended"
        }
        icon="mic"
        iconColor={iconColor}
        failed={content.type === "realtimeSessionClosed" && content.outcome === "failed"}
      />
    );
  }
  const author = content.role === "user" ? "You" : "Codex";
  const capture = describeRealtimeVoiceCapture(item);
  return (
    <View className="mb-5 gap-1.5 px-1">
      <Text className="font-t3-medium text-xs text-foreground-secondary">
        {author} · Voice transcript{visibility === "inherited" ? " · Inherited" : ""}
      </Text>
      <Text selectable className="text-base leading-6">
        {content.text}
      </Text>
      <View className="flex-row flex-wrap items-center gap-1">
        <CopyTextButton
          accessibilityLabel="Copy voice transcript"
          text={content.text}
          tintColor={iconColor}
          buttonSize={28}
          iconSize={13}
        />
        <Text className="text-xs text-foreground-secondary" accessibilityHint={capture.detail}>
          {capture.status} · {capture.timeLabel} {timestampLabel}
          {entry.promotedToCodingRequest ? " · Sent as coding request" : ""}
        </Text>
      </View>
    </View>
  );
}
