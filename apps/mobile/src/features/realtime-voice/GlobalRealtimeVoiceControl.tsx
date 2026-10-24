import type { VoiceSnapshot } from "@t3tools/client-runtime/realtime-voice";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FullWindowOverlay } from "react-native-screens";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useRealtimeVoice } from "./RealtimeVoiceProvider";

// Unknown future modes read as "not sending" so the label never overstates capture.
function describeMode(snapshot: VoiceSnapshot): { label: string; sending: boolean } {
  switch (snapshot.mode) {
    case "transmitting":
      return { label: "Microphone audio sent to Codex", sending: true };
    case "connecting":
      return { label: "Connecting · microphone not sending", sending: false };
    case "ending":
      return { label: "Microphone off · ending call", sending: false };
    case "off":
      return {
        label: snapshot.replacementBlocked ? "Voice blocked" : "Voice ended",
        sending: false,
      };
    default:
      return { label: "Microphone off", sending: false };
  }
}

/** Shows which thread owns realtime voice from any screen, with Return and End. A call that
 * ended with a reason stays visible until dismissed so a revocation is never silent. */
export function GlobalRealtimeVoiceControl() {
  const { snapshot, end, returnToOwner } = useRealtimeVoice();
  const [dismissed, setDismissed] = useState<VoiceSnapshot | null>(null);
  if (snapshot === dismissed) return null;
  if (snapshot.mode === "off" && snapshot.reason === null && !snapshot.replacementBlocked) {
    return null;
  }
  const control = (
    <RealtimeVoiceBanner
      snapshot={snapshot}
      onEnd={end}
      onReturn={snapshot.owner ? () => returnToOwner(snapshot.owner) : null}
      onDismiss={() => setDismissed(snapshot)}
    />
  );
  return Platform.OS === "ios" ? <FullWindowOverlay>{control}</FullWindowOverlay> : control;
}

function RealtimeVoiceBanner(props: {
  readonly snapshot: VoiceSnapshot;
  readonly onEnd: () => void;
  readonly onReturn: (() => void) | null;
  readonly onDismiss: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { snapshot } = props;
  const { label, sending } = describeMode(snapshot);
  const owner = snapshot.owner;
  return (
    <View pointerEvents="box-none" className="absolute inset-x-0 top-0 items-center px-3">
      <View
        accessibilityLabel="Voice conversation"
        className="w-full max-w-[420px] flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-2 shadow-md shadow-black/10"
        style={{ marginTop: insets.top + 4 }}
      >
        <SymbolView
          name="mic"
          size={16}
          tintColorClassName={sending ? "accent-icon" : "accent-icon-muted"}
          type="monochrome"
        />
        <View accessibilityLiveRegion="polite" className="min-w-0 flex-1">
          <Text className="text-xs font-t3-medium text-foreground" numberOfLines={1}>
            {label}
          </Text>
          {owner ? (
            <Text className="text-xs text-foreground-muted" numberOfLines={1}>
              {owner.threadTitle} · {owner.environmentLabel}
            </Text>
          ) : null}
          {snapshot.reason ? (
            <Text className="text-xs text-foreground-muted" numberOfLines={3}>
              {snapshot.reason}
            </Text>
          ) : null}
        </View>
        {props.onReturn ? <BannerAction label="Return" onPress={props.onReturn} /> : null}
        {snapshot.mode === "off" ? (
          <BannerAction label="Dismiss" onPress={props.onDismiss} />
        ) : (
          <BannerAction
            danger
            label={snapshot.mode === "connecting" ? "Cancel" : "End"}
            onPress={props.onEnd}
          />
        )}
      </View>
    </View>
  );
}

function BannerAction(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly danger?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      className="min-h-[30px] justify-center px-2 active:opacity-70"
      hitSlop={6}
      onPress={props.onPress}
    >
      <Text
        className={cn(
          "text-xs font-t3-medium",
          props.danger ? "text-danger-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
