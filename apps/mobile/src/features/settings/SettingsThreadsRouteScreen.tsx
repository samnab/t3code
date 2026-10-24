import { AuthOrchestrationOperateScope, type ServerSettingsPatch } from "@t3tools/contracts";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { NumberField } from "../../components/ui/NumberField";
import * as Dialog from "../../components/ui/Dialog";
import { serverEnvironment } from "../../state/server";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironments } from "../../state/environments";
import { uuidv4 } from "../../lib/uuid";
import { COMPLETION_AUDIO_CHOICES } from "../threads/thread-settings-options";
import { Button } from "../../components/ui/Button";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { AutoSettleDaysField } from "./components/AutoSettleDaysField";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { AppText as Text } from "../../components/ui/AppText";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsProjectOverridesSection } from "./components/SettingsProjectOverridesSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { planAutoSettleSettingsSync, type AutoSettleSettings } from "./autoSettleSettingsSync";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { useSettingsWriter } from "./useSettingsWriter";
import {
  planMobileScopedSettingsClear,
  planMobileScopedSettingsPatch,
  resolveMobileSettingsTargets,
  uniformMobileSetting,
  type ScopedMobileSettingsTarget,
} from "./settings-scoped-server";

export function SettingsThreadsRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Thread behavior" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <AutoSettleSettingsRows />
          <CompletionAudioSettingsRows />
          <BetaSettingsSection />
          <LegacySettingsSection />
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

function AutoSettleSettingsRows() {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const projectSelected = selectedProjectKey !== null;
  const [pendingWrites, setPendingWrites] = useState(0);
  const writeInFlight = useRef(false);
  const [pendingTargets, setPendingTargets] = useState<
    readonly ScopedMobileSettingsTarget[] | null
  >(null);
  const writeSettings = useSettingsWriter();

  const syncEnvironments = selectedTargets.filter(supportsSharedSettingsSync);
  const syncTargets = resolveMobileSettingsTargets(
    syncEnvironments,
    projectSelected ? (selectedProject?.members.map((member) => member.project) ?? []) : null,
  );
  const canWriteSettings =
    syncTargets.length > 0 &&
    syncTargets.every((target) => writableEnvironments.has(target.environment.environmentId));
  const displayTargets =
    pendingWrites > 0 && pendingTargets !== null ? pendingTargets : syncTargets;
  const reference = displayTargets[0] ?? null;
  const referenceSettings = reference?.settings ?? null;

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (
    patch: Partial<AutoSettleSettings> & {
      autoResumeLimitedThreads?: boolean;
      snoozeLimitedThreads?: boolean;
    },
  ) => {
    if (
      writeInFlight.current ||
      !syncTargets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsPatch(syncTargets, projectSelected, patch);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(syncTargets);
    setPendingWrites((count) => count + 1);
    void writeSettings(syncTargets, writes).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };

  const { patch: autoSettlePatch, mismatches } = planAutoSettleSettingsSync(
    {
      environmentId: reference.environment.environmentId,
      projectId: reference.projectId,
      settings: referenceSettings,
    },
    displayTargets.map((target) => ({
      environmentId: target.environment.environmentId,
      projectId: target.projectId,
      label: target.environment.label,
      settings: target.settings,
    })),
  );

  const supportsProjectOverrides = syncTargets.every(
    (target) =>
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides === true,
  );
  const disabled =
    !canWriteSettings || pendingWrites > 0 || (projectSelected && !supportsProjectOverrides);
  const hasProjectOverrides =
    projectSelected &&
    syncTargets.some(
      (target) =>
        target.sources.sidebarAutoSettleOnMerge === "project" ||
        target.sources.sidebarAutoSettleAfterDays === "project",
    );
  const clearProjectOverrides = () => {
    if (
      writeInFlight.current ||
      !syncTargets.every((target) =>
        readEnvironmentScope(target.environment.environmentId, AuthSettingsWriteScope),
      )
    )
      return;
    const writes = planMobileScopedSettingsClear(syncTargets, [
      "sidebarAutoSettleOnMerge",
      "sidebarAutoSettleAfterDays",
    ]);
    if (writes.length === 0) return;
    writeInFlight.current = true;
    setPendingTargets(syncTargets);
    setPendingWrites((count) => count + 1);
    void writeSettings(syncTargets, writes).finally(() => {
      writeInFlight.current = false;
      setPendingTargets(null);
      setPendingWrites((count) => count - 1);
    });
  };

  const afterDays = referenceSettings.sidebarAutoSettleAfterDays;

  return (
    <View className="gap-6">
      {projectSelected ? (
        <SettingsProjectOverridesSection
          projectLabel={selectedProject?.label ?? "Unavailable project"}
          hasOverrides={hasProjectOverrides}
          supportsOverrides={supportsProjectOverrides}
          pending={pendingWrites > 0}
          disabled={!canWriteSettings}
          onClear={clearProjectOverrides}
        />
      ) : null}
      {!projectSelected ? (
        <SettingsSection title="Usage limits">
          <SettingsSwitchRow
            icon="clock"
            label="Auto-resume limited threads"
            value={uniformMobileSetting(displayTargets, "autoResumeLimitedThreads")}
            disabled={disabled}
            onValueChange={(value) => writeToAll({ autoResumeLimitedThreads: value })}
          />
          <SettingsSwitchRow
            icon="clock"
            label="Snooze limited threads"
            value={uniformMobileSetting(displayTargets, "snoozeLimitedThreads")}
            disabled={disabled}
            onValueChange={(value) => writeToAll({ snoozeLimitedThreads: value })}
          />
        </SettingsSection>
      ) : null}
      <SettingsSection title="Auto-settle">
        <SettingsSwitchRow
          icon="arrow.triangle.branch"
          label="Auto-settle merged threads"
          value={referenceSettings.sidebarAutoSettleOnMerge}
          disabled={disabled}
          onValueChange={(value) => writeToAll({ sidebarAutoSettleOnMerge: value })}
        />
        <SettingsSwitchRow
          icon="clock"
          label="Auto-settle inactive threads"
          value={afterDays !== null}
          disabled={disabled}
          onValueChange={(value) =>
            writeToAll({ sidebarAutoSettleAfterDays: value ? AUTO_SETTLE_DEFAULT_DAYS : null })
          }
        />
        {afterDays !== null ? (
          <View className="flex-row items-center gap-4 px-4 py-4 android:min-h-14 android:py-3">
            <View className="w-[22px] android:w-6" />
            <Text className="flex-1 text-foreground text-lg android:text-base">Inactive days</Text>
            <AutoSettleDaysField
              value={afterDays}
              disabled={disabled}
              onValueChange={(value) => writeToAll({ sidebarAutoSettleAfterDays: value })}
            />
          </View>
        ) : null}
      </SettingsSection>
      {pendingWrites === 0 && mismatches.length > 0 ? (
        <SettingsSection title="Across environments">
          <View className="gap-3 p-4">
            <Text className="text-base text-foreground">Auto-settle defaults differ</Text>
            <Text className="text-sm text-foreground-muted">
              {mismatches.map((mismatch) => mismatch.label).join(", ")}
            </Text>
            <Button
              label="Apply auto-settle defaults"
              tone="secondary"
              disabled={disabled}
              onPress={() => writeToAll(autoSettlePatch)}
            />
          </View>
        </SettingsSection>
      ) : null}
    </View>
  );
}

function BetaSettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const workingShelfEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.workingShelfEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Beta">
        <SettingsSwitchRow
          icon="bolt.circle"
          label="Working section"
          value={workingShelfEnabled}
          onValueChange={(value) => savePreferences({ workingShelfEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Fold working and monitoring threads into a Working section. They return to the top of the
        list when they need you. While this is on, active threads are ordered by time and cannot be
        moved.
      </Text>
    </View>
  );
}

function LegacySettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const planModeEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.planModeEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Legacy">
        <SettingsSwitchRow
          icon="hammer"
          label="Plan Mode"
          value={planModeEnabled}
          onValueChange={(value) => savePreferences({ planModeEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Opt into retired interfaces kept for compatibility. Plan Mode restores the Build/Plan
        control; otherwise every task runs in Build mode.
      </Text>
    </View>
  );
}

function CompletionAudioSettingsRows() {
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
