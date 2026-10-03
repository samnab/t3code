import { THREAD_GOAL_MAX_CHARS, type ThreadGoalLoop } from "@t3tools/contracts";
import {
  threadGoalEditorCanSave,
  threadGoalEditorDraftError,
  type ThreadGoalEditorState,
  type ThreadGoalLoopAction,
} from "@t3tools/client-runtime/state/thread-goal-editor";
import { Modal, Pressable, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { mobileGoalLoopAction, mobileGoalLoopRestart } from "./thread-goal-loop";

const GOAL_COUNTER_THRESHOLD = THREAD_GOAL_MAX_CHARS - 128;

export function ThreadGoalEditorSheet(props: {
  readonly state: ThreadGoalEditorState;
  readonly goalLoop: ThreadGoalLoop | null;
  readonly onDraftChange: (text: string) => void;
  readonly onSave: () => void;
  readonly onClear: () => void;
  readonly onGoalLoopAction: (action: ThreadGoalLoopAction) => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const draftError = threadGoalEditorDraftError(props.state.draft);
  const loopAction = mobileGoalLoopAction(props.goalLoop);
  const canRestart = mobileGoalLoopRestart(props.goalLoop);
  const actionButton = (
    label: string,
    onPress: () => void,
    options?: { readonly destructive?: boolean; readonly disabled?: boolean },
  ) => (
    <Pressable
      accessibilityRole="button"
      className="min-h-11 items-center justify-center rounded-full px-3 active:bg-subtle"
      disabled={options?.disabled}
      onPress={onPress}
    >
      <Text
        className={cn(
          "text-sm font-t3-medium",
          options?.destructive && !options.disabled ? "text-danger-foreground" : "text-foreground",
          options?.disabled && "text-foreground-muted",
        )}
      >
        {label}
      </Text>
    </Pressable>
  );

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
          accessibilityLabel="Close goal editor"
          accessibilityRole="button"
          className="flex-1"
          onPress={props.onClose}
        />
        <KeyboardAvoidingView automaticOffset behavior="padding">
          <View
            className="rounded-t-[24px] bg-card px-5 pb-3 pt-3"
            style={{ paddingBottom: insets.bottom + 12 }}
          >
            <View className="mb-2 flex-row items-center justify-between">
              <View className="flex-row items-center gap-2">
                <SymbolView
                  name="flag"
                  size={14}
                  tintColorClassName="accent-foreground-muted"
                  type="monochrome"
                />
                <Text className="text-sm font-t3-bold text-foreground-muted">Thread goal</Text>
              </View>
              {actionButton("Close", props.onClose)}
            </View>
            <TextInput
              accessibilityLabel="Thread goal"
              autoFocus
              maxLength={THREAD_GOAL_MAX_CHARS}
              multiline
              textAlignVertical="top"
              className="max-h-40 min-h-24 rounded-2xl bg-subtle px-3.5 py-3 text-base text-foreground"
              placeholder="What should this thread accomplish?"
              placeholderTextColorClassName="accent-placeholder"
              value={props.state.draft}
              onChangeText={props.onDraftChange}
            />
            {props.state.error !== null || draftError !== null ? (
              <Text accessibilityRole="alert" className="mt-2 px-1 text-xs text-danger-foreground">
                {props.state.error ?? draftError}
              </Text>
            ) : null}
            <View className="mt-2 flex-row items-center justify-between gap-2">
              <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                {props.state.draft.length >= GOAL_COUNTER_THRESHOLD
                  ? `${props.state.draft.length}/${THREAD_GOAL_MAX_CHARS} characters`
                  : ""}
              </Text>
              <View className="flex-row items-center justify-end">
                {loopAction
                  ? actionButton(
                      loopAction === "pause"
                        ? "Pause"
                        : loopAction === "resume"
                          ? "Resume"
                          : "Continue",
                      () => props.onGoalLoopAction(loopAction),
                    )
                  : null}
                {canRestart ? actionButton("Restart", () => props.onGoalLoopAction("reset")) : null}
                {props.state.savedGoal !== null
                  ? actionButton(props.state.saving ? "Clearing..." : "Clear", props.onClear, {
                      disabled: props.state.saving,
                      destructive: true,
                    })
                  : null}
                {actionButton(props.state.saving ? "Saving..." : "Save", props.onSave, {
                  disabled: !threadGoalEditorCanSave(props.state),
                })}
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
