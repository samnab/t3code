import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import {
  canConfirmThreadExperiment,
  formatThreadExperimentArgv,
  type ThreadExperimentConfirmationState,
} from "./thread-experiment-confirmation";

function ConfigRow(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="gap-0.5">
      <Text className="text-xs font-t3-medium text-foreground-muted">{props.label}</Text>
      {props.children}
    </View>
  );
}

function Value(props: { readonly children: ReactNode; readonly code?: boolean }) {
  return (
    <Text selectable className={cn("text-sm text-foreground", props.code ? "font-mono" : null)}>
      {props.children}
    </Text>
  );
}

/** Native review gate for `/goal experiment`, with the full pinned config in a safe scroll area. */
export function ThreadExperimentConfirmationSheet(props: {
  readonly state: ThreadExperimentConfirmationState;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { state } = props;
  const { preview } = state;
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const metricDirection =
    preview.evaluator.metric.direction === "maximize" ? "higher is better" : "lower is better";

  const actionButton = (label: string, onPress: () => void, disabled: boolean) => (
    <View className="overflow-hidden rounded-full">
      <Pressable
        accessibilityLabel={label}
        accessibilityRole="button"
        className="min-h-11 items-center justify-center px-4 active:bg-subtle"
        disabled={disabled}
        onPress={onPress}
      >
        <Text
          className={cn(
            "text-base font-t3-medium",
            disabled ? "text-foreground-muted" : "text-foreground",
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
      onRequestClose={() => {
        if (!state.confirming) props.onCancel();
      }}
    >
      <View className="flex-1 justify-end bg-backdrop">
        <Pressable
          accessibilityLabel="Cancel experiment"
          accessibilityRole="button"
          className="min-h-16 flex-1"
          disabled={state.confirming}
          onPress={props.onCancel}
        />
        <View
          className="rounded-t-[24px] bg-card pt-3"
          style={{ maxHeight: Math.round(height * 0.88), paddingBottom: insets.bottom + 12 }}
        >
          <View className="flex-row items-center justify-between px-5 pb-2">
            <View className="flex-row items-center gap-1.5">
              <SymbolView
                name="scope"
                size={14}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
              <Text className="text-sm font-t3-bold text-foreground-muted">Review experiment</Text>
            </View>
            {actionButton("Cancel", props.onCancel, state.confirming)}
          </View>

          <ScrollView
            className="min-h-0"
            contentContainerClassName="gap-3 px-5 pb-3"
            keyboardShouldPersistTaps="handled"
          >
            <Text className="text-xs text-foreground-muted">
              T3 Code will use only this pinned configuration. Starting consumes a one-shot
              confirmation.
            </Text>
            <ConfigRow label="Objective">
              <Value>{state.objective}</Value>
            </ConfigRow>
            <ConfigRow label="Working directory">
              <Value code>{preview.cwd}</Value>
            </ConfigRow>
            <ConfigRow label="Branch">
              <Value code>{preview.branch}</Value>
            </ConfigRow>
            <ConfigRow label="HEAD">
              <Value code>{preview.head}</Value>
            </ConfigRow>
            <ConfigRow label="Config digest">
              <Value code>{preview.configDigest}</Value>
            </ConfigRow>
            <ConfigRow label="Provider">
              <Value>
                {preview.provider.instanceId} ({preview.provider.driver}) ·{" "}
                {preview.provider.supported ? "supported" : "not supported"}
                {preview.provider.reason ? `: ${preview.provider.reason}` : ""}
              </Value>
            </ConfigRow>
            <ConfigRow label="Approved files">
              <View className="gap-1">
                {preview.approvedFiles.map((path) => (
                  <Value key={path} code>
                    {path}
                  </Value>
                ))}
              </View>
            </ConfigRow>
            <ConfigRow label="Evaluator">
              <Value code>{formatThreadExperimentArgv(preview.evaluator.argv)}</Value>
            </ConfigRow>
            <ConfigRow label="Metric">
              <Value>
                {preview.evaluator.metric.name}, {metricDirection}, minimum improvement{" "}
                {preview.evaluator.metric.minimumImprovement}
              </Value>
            </ConfigRow>
            <ConfigRow label="Checks">
              <View className="gap-1.5">
                {preview.checks.map((check) => (
                  <View key={check.name} className="gap-0.5">
                    <Value>{check.name}</Value>
                    <Value code>{formatThreadExperimentArgv(check.argv)}</Value>
                  </View>
                ))}
              </View>
            </ConfigRow>
            <ConfigRow label="Run limits">
              <Value>
                {preview.limits.maxExperiments} experiments · {preview.limits.maxTotalSeconds}s
                total
              </Value>
            </ConfigRow>
            <ConfigRow label="Command timeouts">
              <Value>
                evaluator {preview.limits.evaluatorTimeoutSeconds}s · each check{" "}
                {preview.limits.checkTimeoutSeconds}s
              </Value>
            </ConfigRow>
            <ConfigRow label="Output limits">
              <Value>
                evaluator {preview.limits.maxEvaluatorOutputBytes.toLocaleString()} bytes · each
                check {preview.limits.maxCheckOutputBytes.toLocaleString()} bytes
              </Value>
            </ConfigRow>
            <ConfigRow label="Apply limits">
              <Value>
                {preview.limits.maxFilesPerApply} files ·{" "}
                {preview.limits.maxBytesPerFile.toLocaleString()} bytes per file ·{" "}
                {preview.limits.maxTotalApplyBytes.toLocaleString()} bytes total
              </Value>
            </ConfigRow>
            <ConfigRow label="Preview expires">
              <Value>{new Date(preview.expiresAt).toLocaleString()}</Value>
            </ConfigRow>
            {!preview.provider.supported ? (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                This provider cannot run experiments
                {preview.provider.reason ? `: ${preview.provider.reason}` : "."}
              </Text>
            ) : null}
            {state.error ? (
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                {state.error}
              </Text>
            ) : null}
          </ScrollView>

          <View className="flex-row items-center justify-end gap-1 border-t border-border px-5 pt-2">
            {actionButton(
              state.confirming ? "Starting…" : "Confirm and start",
              props.onConfirm,
              !canConfirmThreadExperiment(state),
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}
