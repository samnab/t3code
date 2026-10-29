import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { NumberField } from "../../components/ui/NumberField";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { COMPLETION_AUDIO_CHOICES } from "../threads/thread-settings-options";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
} from "./settings-scoped-server";
import { useSettingsWriter } from "./useSettingsWriter";

export function CompletionAudioSettingsRows() {
  const { selectedTargets, selectedIds, selectedProjectKey } = useSettingsEnvironmentFilter();
  const { environments } = useEnvironments();
  const targets = selectedTargets.filter(
    (environment) =>
      environment.serverConfig.environment.capabilities.completionNotifications === true,
  );
  const scopedTargets = resolveMobileSettingsTargets(targets, null);
  const writable = useEnvironmentsWithScope(targets, AuthSettingsWriteScope);
  const operable = useEnvironmentsWithScope(targets, AuthOrchestrationOperateScope);
  const writeSettings = useSettingsWriter();
  const bulkOff = useAtomCommand(serverEnvironment.bulkOffCompletionAudio, {
    label: "turn off existing completion audio",
    reportFailure: false,
  });
  const [writing, setWriting] = useState(false);
  const [runningBulk, setRunningBulk] = useState(false);
  const writeInFlight = useRef(false);
  const bulkInFlight = useRef(false);
  const common = uniformMobileSetting(scopedTargets, "completionAudio");
  const audio = common ?? scopedTargets[0]?.settings.completionAudio;
  if (!audio || targets.length === 0) return null;
  const defaultMode =
    common?.defaultMode ??
    (scopedTargets.every(
      (target) => target.settings.completionAudio.defaultMode === audio.defaultMode,
    )
      ? audio.defaultMode
      : null);
  const tone =
    common?.tone ??
    (scopedTargets.every((target) => target.settings.completionAudio.tone === audio.tone)
      ? audio.tone
      : null);
  const volume =
    common?.volume ??
    (scopedTargets.every((target) => target.settings.completionAudio.volume === audio.volume)
      ? audio.volume
      : null);
  const projectSelected = selectedProjectKey !== null;
  const canWrite =
    !projectSelected && targets.every((environment) => writable.has(environment.environmentId));
  const disabled = !canWrite || writing;
  const selected = environments.filter(
    (environment) => selectedIds === null || selectedIds.has(environment.environmentId),
  );
  const skipped = selected.filter(
    (environment) => !targets.some((target) => target.environmentId === environment.environmentId),
  );
  const patch = (completionAudio: NonNullable<ServerSettingsPatch["completionAudio"]>) => {
    if (
      writeInFlight.current ||
      !canWrite ||
      !targets.every((environment) =>
        readEnvironmentScope(environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    writeInFlight.current = true;
    setWriting(true);
    const writes = planMobileScopedSettingsPatch(scopedTargets, false, { completionAudio });
    void writeSettings(scopedTargets, writes).then(
      () => {
        writeInFlight.current = false;
        setWriting(false);
      },
      () => {
        writeInFlight.current = false;
        setWriting(false);
      },
    );
  };
  return (
    <SettingsSection title="Completion audio">
      <Text className="px-4 py-3 text-sm text-foreground-muted">
        Default for future top-level threads. Subagents and forks start Off. Sound plays on web and
        desktop. Voice uses provider-owned hooks and may not stop speech already started.
        {projectSelected ? " Choose an environment scope to edit these settings." : ""}
        {!canWrite && !projectSelected
          ? " Settings-write permission is required on every selected capable environment."
          : ""}
      </Text>
      {skipped.length > 0 ? (
        <Text className="px-4 pb-3 text-sm text-foreground-muted">
          Not changed: {skipped.map((environment) => environment.label).join(", ")} (offline or
          unsupported).
        </Text>
      ) : null}
      {COMPLETION_AUDIO_CHOICES.map((choice, index) => (
        <ListChoiceRow
          key={choice.mode}
          label={`New threads: ${choice.label}`}
          selected={defaultMode === choice.mode}
          disabled={disabled}
          separated={index > 0}
          onPress={() => patch({ defaultMode: choice.mode })}
        />
      ))}
      {defaultMode !== "off" ? (
        <ListActionRow
          label="Reset new threads to Off"
          disabled={disabled}
          onPress={() => patch({ defaultMode: "off" })}
        />
      ) : null}
      <ListChoiceRow
        label="Sound: Chime"
        selected={tone === "completion"}
        disabled={disabled}
        onPress={() => patch({ tone: "completion" })}
      />
      <ListChoiceRow
        label="Sound: Alert"
        selected={tone === "input"}
        disabled={disabled}
        separated
        onPress={() => patch({ tone: "input" })}
      />
      <View className="flex-row items-center justify-between gap-4 px-4 py-4 android:min-h-14 android:py-3">
        <Text className="flex-1 text-lg text-foreground android:text-base">
          Volume{volume === null ? " (mixed)" : ""}
        </Text>
        <NumberField
          label="Completion sound volume"
          min={0}
          max={100}
          value={Math.round((volume ?? audio.volume) * 100)}
          formatValue={(value) => `${value}%`}
          disabled={disabled}
          onValueChange={(value) => patch({ volume: value / 100 })}
        />
      </View>
      <ListActionRow
        label="Turn off existing thread audio"
        description={
          operable.size === 0
            ? "This connection cannot operate threads on selected environments. The future default is separate."
            : "Includes archived threads and subagents. Does not change the future default."
        }
        loading={runningBulk}
        disabled={projectSelected || operable.size === 0}
        onPress={async () => {
          if (bulkInFlight.current || projectSelected) return;
          bulkInFlight.current = true;
          setRunningBulk(true);
          const lines: string[] = [];
          for (const environment of selected) {
            if (!targets.some((target) => target.environmentId === environment.environmentId)) {
              lines.push(`${environment.label}: not changed (offline or unsupported).`);
              continue;
            }
            if (
              !appAtomRegistry.get(
                serverEnvironment.bulkOffCompletionAudio.permissionAtom(environment.environmentId),
              )
            ) {
              lines.push(`${environment.label}: not changed (permission denied).`);
              continue;
            }
            const result = await bulkOff({
              environmentId: environment.environmentId,
              input: { clientRequestId: uuidv4() },
            });
            if (result._tag !== "Success") {
              lines.push(
                `${environment.label}: could not turn off existing thread audio. Check the connection and permissions.`,
              );
              continue;
            }
            const report = result.value;
            const superseded = report.failed.filter(
              (failure) => failure.reason === "superseded",
            ).length;
            lines.push(
              `${environment.label}: ${report.turnedOff} turned off, ${report.alreadyOff} already off${report.failedCount > 0 ? `, ${report.failedCount} failed or changed after the request` : ""}.${!report.complete ? " Incomplete." : ""}${superseded ? ` ${superseded} reported later choices were preserved.` : ""}${report.failuresTruncated ? ` Failure details were limited to ${report.failed.length} of ${report.failedCount} targets.` : ""}`,
            );
          }
          bulkInFlight.current = false;
          setRunningBulk(false);
          Dialog.alert(
            "Existing thread completion audio",
            lines.join("\n\n") || "No selected environments were changed.",
          );
        }}
      />
    </SettingsSection>
  );
}
