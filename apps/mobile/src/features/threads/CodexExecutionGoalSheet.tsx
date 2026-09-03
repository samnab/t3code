import {
  executionGoalCanClear,
  executionGoalCanPause,
  executionGoalCanRefresh,
  executionGoalDurationLabel,
  executionGoalErrorCopy,
  executionGoalStatusLabel,
  executionGoalTokensLabel,
  type ExecutionGoalPanelState,
} from "@t3tools/client-runtime/state/executionGoalPanel";
import { Alert, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";

/**
 * Bottom-sheet view of the Codex-native execution goal (transparent Modal,
 * ThreadGoalEditorSheet pattern — not a navigation screen). All state is
 * owned by the caller and keyed by thread; this sheet only reports intents.
 * Deliberately separate from the T3 thread goal editor.
 */
export function CodexExecutionGoalSheet(props: {
  readonly state: ExecutionGoalPanelState;
  readonly onRefresh: () => void;
  readonly onPause: () => void;
  readonly onClear: () => void;
  readonly onClose: () => void;
}) {
  const { state } = props;
  const insets = useSafeAreaInsets();
  const errorCopy = state.error !== null ? executionGoalErrorCopy(state.error) : null;
  const snapshot = state.snapshot;

  // 44pt minimum target per action, matching the platform guidance.
  const actionButton = (
    label: string,
    onPress: () => void,
    options?: { destructive?: boolean; disabled?: boolean },
  ) => (
    <View className="overflow-hidden rounded-full">
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        className="min-h-11 items-center justify-center px-4 active:bg-subtle"
        disabled={options?.disabled}
        onPress={onPress}
      >
        <Text
          className={cn(
            "text-base font-t3-medium",
            options?.destructive && !options?.disabled
              ? "text-danger-foreground"
              : "text-foreground",
            options?.disabled ? "text-foreground-muted" : null,
          )}
        >
          {label}
        </Text>
      </Pressable>
    </View>
  );

  const confirmClear = () => {
    Alert.alert(
      "Clear Codex execution goal?",
      "Codex stops tracking it in this session. Your T3 thread goal is not affected.",
      [
        { style: "cancel", text: "Cancel" },
        { style: "destructive", text: "Clear", onPress: props.onClear },
      ],
    );
  };

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={props.onClose}
    >
      <View className="flex-1 justify-end bg-backdrop">
        <Pressable
          accessibilityLabel="Close Codex execution goal"
          accessibilityRole="button"
          className="flex-1"
          onPress={props.onClose}
        />
        <View
          className="rounded-t-[24px] bg-card px-5 pt-3"
          style={{ paddingBottom: insets.bottom + 12 }}
        >
          <View className="mb-1 flex-row items-center justify-between">
            <View className="flex-row items-center gap-1.5">
              <SymbolView
                name="flag"
                size={14}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
              <Text className="text-sm font-t3-bold text-foreground-muted">
                Codex execution goal
              </Text>
            </View>
            {actionButton("Close", props.onClose)}
          </View>
          <Text className="mb-3 px-1 text-xs text-foreground-muted">
            Set and tracked by Codex in this session. Separate from your thread goal.
          </Text>

          {state.status === "loading" && snapshot === null ? (
            <Text className="px-1 pb-2 text-base text-foreground-muted">
              Reading Codex's live goal…
            </Text>
          ) : snapshot === null ? (
            <Text className="px-1 pb-2 text-base text-foreground-muted">
              Codex has no execution goal for this thread.
            </Text>
          ) : (
            <View className="gap-1.5 px-1 pb-2">
              <View className="flex-row items-start justify-between gap-3">
                <Text className="min-w-0 flex-1 text-base text-foreground">
                  {snapshot.objective}
                </Text>
                <Text
                  accessibilityLabel={`Status: ${executionGoalStatusLabel(snapshot.status)}`}
                  className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs font-t3-medium text-foreground"
                >
                  {executionGoalStatusLabel(snapshot.status)}
                </Text>
              </View>
              <Text className="text-xs text-foreground-muted">
                Tokens: {executionGoalTokensLabel(snapshot)}
              </Text>
              <Text className="text-xs text-foreground-muted">
                Time used: {executionGoalDurationLabel(snapshot.timeUsedSeconds)}
              </Text>
              {/* The provider's own updatedAt is the only freshness signal. */}
              <Text className="text-xs text-foreground-muted">
                Updated: {new Date(snapshot.updatedAt).toLocaleString()}
              </Text>
            </View>
          )}

          {errorCopy !== null ? (
            <Text accessibilityRole="alert" className="px-1 pb-2 text-xs text-danger-foreground">
              {errorCopy.title}. {errorCopy.description}
            </Text>
          ) : null}

          <View className="flex-row items-center justify-end gap-1">
            {actionButton(state.refreshing ? "Refreshing…" : "Refresh", props.onRefresh, {
              disabled: !executionGoalCanRefresh(state),
            })}
            {snapshot?.status === "active"
              ? actionButton(state.action === "pausing" ? "Pausing…" : "Pause", props.onPause, {
                  disabled: !executionGoalCanPause(state),
                })
              : null}
            {snapshot !== null
              ? actionButton(state.action === "clearing" ? "Clearing…" : "Clear", confirmClear, {
                  destructive: true,
                  disabled: !executionGoalCanClear(state),
                })
              : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}
