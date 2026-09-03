import { THREAD_GOAL_MAX_CHARS } from "@t3tools/contracts";
import {
  threadGoalEditorCanSave,
  threadGoalEditorDraftError,
  type ThreadGoalEditorState,
} from "@t3tools/client-runtime/state/threadGoalEditor";
import { Modal, Pressable, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";

// Hidden until the draft approaches the cap, matching the web editor.
const GOAL_COUNTER_THRESHOLD = THREAD_GOAL_MAX_CHARS - 128;

/**
 * Bottom-sheet thread-goal editor (transparent Modal, ConfirmDialogHost
 * pattern — not a new navigation screen). All state is owned by the caller
 * and keyed by thread; this sheet only reports intents.
 */
export function ThreadGoalEditorSheet(props: {
  readonly state: ThreadGoalEditorState;
  readonly onDraftChange: (text: string) => void;
  readonly onSave: () => void;
  readonly onClear: () => void;
  readonly onClose: () => void;
}) {
  const { state } = props;
  const insets = useSafeAreaInsets();
  const draftError = threadGoalEditorDraftError(state.draft);
  const canSave = threadGoalEditorCanSave(state);

  const actionButton = (
    label: string,
    onPress: () => void,
    options?: { destructive?: boolean; disabled?: boolean },
  ) => (
    <View className="overflow-hidden rounded-full">
      <Pressable
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
        {/* Lifts the sheet above the focused input so the keyboard never
            covers the action row (ReviewCommentComposerSheet pattern). */}
        <KeyboardAvoidingView automaticOffset behavior="padding">
          <View
            className="rounded-t-[24px] bg-card px-5 pb-3 pt-3"
            style={{ paddingBottom: insets.bottom + 12 }}
          >
            <View className="mb-2 flex-row items-center justify-between">
              <View className="flex-row items-center gap-1.5">
                <SymbolView
                  name="scope"
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
              value={state.draft}
              onChangeText={props.onDraftChange}
            />
            {state.error !== null || draftError !== null ? (
              <Text accessibilityRole="alert" className="mt-2 px-1 text-xs text-danger-foreground">
                {state.error ?? draftError}
              </Text>
            ) : null}
            <View className="mt-2 flex-row items-center justify-between gap-2">
              <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
                {state.draft.length >= GOAL_COUNTER_THRESHOLD
                  ? `${state.draft.length}/${THREAD_GOAL_MAX_CHARS} characters`
                  : ""}
              </Text>
              <View className="flex-row items-center justify-end gap-1">
                {state.savedGoal !== null
                  ? actionButton(state.saving ? "Clearing…" : "Clear", props.onClear, {
                      disabled: state.saving,
                      destructive: true,
                    })
                  : null}
                {actionButton(state.saving ? "Saving…" : "Save", props.onSave, {
                  disabled: !canSave,
                })}
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
