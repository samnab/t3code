import {
  EnvironmentId,
  type DelegationCandidate,
  type DelegationTierId,
  type DelegationTiers,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { remainingPercent } from "@t3tools/shared/usageLimits";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ControlPillMenu } from "../../components/ControlPill";
import { buildModelOptions, groupByProvider, type ModelOption } from "../../lib/modelOptions";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

const TIER_ORDER: readonly DelegationTierId[] = ["small", "medium", "large"];

const TIER_META: Readonly<
  Record<DelegationTierId, { readonly label: string; readonly description: string }>
> = {
  small: { label: "Small", description: "Retrieval, mechanical, cheap parallel work" },
  medium: { label: "Medium", description: "General implementation" },
  large: { label: "Large", description: "Critical work, planning, review" },
};

function providerLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  if (provider.driver === "codex") return "Codex";
  if (provider.driver === "claudeAgent") return "Claude";
  return provider.instanceId;
}

/** Remaining quota across the instance's windows; the tightest window decides. */
function headroomLabel(limits: ServerProviderUsageLimits | undefined): string {
  if (!limits || limits.unavailable || limits.windows.length === 0) return "usage unknown";
  return `${Math.min(...limits.windows.map(remainingPercent))}% left`;
}

/** Rebuilds a candidate without an omitted `minHeadroomPercent` key. */
function withHeadroom(
  candidate: DelegationCandidate,
  minHeadroomPercent: number | undefined,
): DelegationCandidate {
  const base = {
    providerInstanceId: candidate.providerInstanceId,
    model: candidate.model,
    ...(candidate.options ? { options: candidate.options } : {}),
  };
  return minHeadroomPercent === undefined ? base : { ...base, minHeadroomPercent };
}

function candidateFromOption(option: ModelOption): DelegationCandidate {
  return {
    providerInstanceId: option.selection.instanceId,
    model: option.selection.model,
    ...(option.selection.options ? { options: option.selection.options } : {}),
  };
}

function EnvironmentSelectionRow(props: {
  readonly value: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
}) {
  return (
    <ControlPillMenu
      accessible
      accessibilityRole="button"
      accessibilityLabel="Select delegation environment"
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Select delegation environment"
        className="flex-row items-center gap-4 p-4 active:opacity-70"
      >
        <SymbolView
          name="server.rack"
          size={22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <View className="min-w-0 flex-1">
          <Text className="text-lg text-foreground">T3 environment</Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {props.value}
          </Text>
        </View>
        <SymbolView
          name="chevron.right"
          size={16}
          tintColorClassName="accent-chevron"
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
    </ControlPillMenu>
  );
}

function CandidateRow(props: {
  readonly label: string;
  readonly headroom: string;
  readonly headroomDraft: string | null;
  readonly editable: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly accessibilityPrefix: string;
  readonly onHeadroomDraft: (value: string) => void;
  readonly onHeadroomCommit: () => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <View className="border-t border-border-subtle p-4 first:border-t-0">
      <View className="flex-row items-center gap-2">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
            {props.label}
          </Text>
          <Text className="text-sm text-foreground-muted">{props.headroom}</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Move ${props.accessibilityPrefix} up`}
          disabled={!props.editable || !props.canMoveUp}
          onPress={props.onMoveUp}
          className="p-2 active:opacity-70 disabled:opacity-30"
        >
          <SymbolView
            name="chevron.up"
            size={18}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Move ${props.accessibilityPrefix} down`}
          disabled={!props.editable || !props.canMoveDown}
          onPress={props.onMoveDown}
          className="p-2 active:opacity-70 disabled:opacity-30"
        >
          <SymbolView
            name="chevron.down"
            size={18}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Remove ${props.accessibilityPrefix}`}
          disabled={!props.editable}
          onPress={props.onRemove}
          className="p-2 active:opacity-70 disabled:opacity-30"
        >
          <SymbolView
            name="trash"
            size={18}
            tintColorClassName="accent-danger-foreground"
            type="monochrome"
            weight="regular"
          />
        </Pressable>
      </View>
      <View className="mt-2 flex-row items-center gap-3">
        <Text className="text-sm text-foreground-muted">Min headroom %</Text>
        <TextInput
          value={props.headroomDraft ?? ""}
          editable={props.editable}
          keyboardType="number-pad"
          returnKeyType="done"
          placeholder="none"
          accessibilityLabel={`Minimum headroom percent for ${props.accessibilityPrefix}`}
          className="w-24 flex-1"
          onChangeText={props.onHeadroomDraft}
          onBlur={props.onHeadroomCommit}
          onSubmitEditing={props.onHeadroomCommit}
        />
      </View>
    </View>
  );
}

export function SettingsDelegationRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const [environmentSelection, setEnvironmentSelection] = useState<EnvironmentId | null>(null);
  const [saving, setSaving] = useState(false);
  const [headroomDrafts, setHeadroomDrafts] = useState<Record<string, string>>({});
  const selectedEnvironment = useMemo(
    () =>
      environments.find((environment) => environment.environmentId === environmentSelection) ??
      environments[0] ??
      null,
    [environmentSelection, environments],
  );
  const selectedEnvironmentId = selectedEnvironment?.environmentId ?? null;
  const selectedEnvironmentConnected = selectedEnvironment?.connection.phase === "connected";
  const config = useEnvironmentServerConfig(selectedEnvironmentId);
  const tiers = config?.settings.delegationTiers ?? null;
  const modelOptions = useMemo(() => buildModelOptions(config, null), [config]);
  const optionByKey = useMemo(
    () => new Map(modelOptions.map((option) => [option.key, option])),
    [modelOptions],
  );
  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  const pickerActions = useMemo<MenuAction[]>(
    () =>
      providerGroups.map((group) => ({
        id: `provider:${group.providerKey}`,
        title: group.providerLabel,
        subactions: group.models.map((option) => ({ id: option.key, title: option.label })),
      })),
    [providerGroups],
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "delegation tiers update",
    reportFailure: true,
  });
  const editable = selectedEnvironmentConnected && config !== null && !saving;

  const writeTiers = async (next: DelegationTiers) => {
    if (selectedEnvironmentId === null || !selectedEnvironmentConnected || saving) return;
    setSaving(true);
    try {
      await updateSettings({
        environmentId: selectedEnvironmentId,
        input: { patch: { delegationTiers: next } },
      });
    } finally {
      setSaving(false);
    }
  };

  const providerByInstance = useMemo(
    () => new Map((config?.providers ?? []).map((provider) => [provider.instanceId, provider])),
    [config?.providers],
  );

  const candidateLabel = (candidate: DelegationCandidate): string => {
    const option = optionByKey.get(`${candidate.providerInstanceId}:${candidate.model}`);
    if (option) return `${option.providerLabel} · ${option.label}`;
    const provider = providerByInstance.get(candidate.providerInstanceId);
    return `${provider ? providerLabel(provider) : candidate.providerInstanceId} · ${candidate.model}`;
  };

  const candidateHeadroom = (candidate: DelegationCandidate): string =>
    headroomLabel(providerByInstance.get(candidate.providerInstanceId)?.usageLimits);

  const appendCandidate = (tierId: DelegationTierId, option: ModelOption) => {
    if (tiers === null) return;
    void writeTiers({ ...tiers, [tierId]: [...tiers[tierId], candidateFromOption(option)] });
  };

  const removeCandidate = (tierId: DelegationTierId, index: number) => {
    if (tiers === null) return;
    void writeTiers({
      ...tiers,
      [tierId]: tiers[tierId].filter((_, entryIndex) => entryIndex !== index),
    });
  };

  const moveCandidate = (tierId: DelegationTierId, index: number, delta: -1 | 1) => {
    if (tiers === null) return;
    const list = [...tiers[tierId]];
    const [moved] = list.splice(index, 1);
    if (moved === undefined) return;
    list.splice(index + delta, 0, moved);
    void writeTiers({ ...tiers, [tierId]: list });
  };

  const setHeadroomDraft = (key: string, value: string) => {
    setHeadroomDrafts((current) => ({ ...current, [key]: value }));
  };

  // Empty input clears the threshold; anything else clamps to a 0..100 integer.
  const commitHeadroom = (tierId: DelegationTierId, index: number) => {
    if (tiers === null) return;
    const key = `${tierId}:${index}`;
    const raw = headroomDrafts[key];
    if (raw === undefined) return;
    setHeadroomDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    const text = raw.trim();
    const parsed = /^\d+$/.test(text) ? Number(text) : null;
    const clamped = parsed === null ? undefined : Math.min(100, parsed);
    const candidate = tiers[tierId][index];
    if (candidate === undefined || candidate.minHeadroomPercent === clamped) return;
    const list = tiers[tierId].map((entry, entryIndex) =>
      entryIndex === index ? withHeadroom(entry, clamped) : entry,
    );
    void writeTiers({ ...tiers, [tierId]: list });
  };

  const environmentActions = useMemo<MenuAction[]>(
    () =>
      environments.map((environment) => ({
        id: environment.environmentId,
        title: environment.label,
        subtitle: environment.connection.phase,
        state:
          environment.environmentId === selectedEnvironmentId ? ("on" as const) : ("off" as const),
      })),
    [environments, selectedEnvironmentId],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Delegation" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          When work is delegated to child agents, each tier tries its candidates in order and skips
          one whose provider is unavailable or out of headroom. Select an environment to edit its
          tiers.
        </Text>
        {environments.length === 0 || selectedEnvironment === null ? (
          <SettingsSection title="Delegation tiers">
            <View className="p-4">
              <Text className="text-base text-foreground">Connect an environment</Text>
              <Text className="mt-1 text-sm leading-normal text-foreground-muted">
                Connect a T3 server to edit its delegation tiers.
              </Text>
            </View>
          </SettingsSection>
        ) : (
          <>
            <SettingsSection title="Environment">
              <EnvironmentSelectionRow
                value={`${selectedEnvironment.label} · ${selectedEnvironment.connection.phase}`}
                actions={environmentActions}
                onSelect={(id) => setEnvironmentSelection(EnvironmentId.make(id))}
              />
            </SettingsSection>
            {tiers === null ? (
              <SettingsSection title="Delegation tiers">
                <View className="p-4">
                  <Text className="text-base text-foreground">Environment is not connected</Text>
                  <Text className="mt-1 text-sm leading-normal text-foreground-muted">
                    Reconnect this environment to edit its delegation tiers.
                  </Text>
                </View>
              </SettingsSection>
            ) : (
              TIER_ORDER.map((tierId) => {
                const candidates = tiers[tierId];
                // Duplicates of one instance+model are legal (differing
                // thresholds), so rows key by occurrence, not array index.
                const seen = new Map<string, number>();
                const rows = candidates.map((candidate) => {
                  const base = `${candidate.providerInstanceId}:${candidate.model}`;
                  const nth = seen.get(base) ?? 0;
                  seen.set(base, nth + 1);
                  return { candidate, key: `${base}#${nth}` };
                });
                return (
                  <SettingsSection
                    key={tierId}
                    title={`${selectedEnvironment.label} · ${TIER_META[tierId].label}`}
                  >
                    <View className="px-4 pt-4">
                      <Text className="text-sm leading-normal text-foreground-muted">
                        {TIER_META[tierId].description}
                      </Text>
                    </View>
                    {rows.map(({ candidate, key }, index) => (
                      <CandidateRow
                        key={key}
                        label={candidateLabel(candidate)}
                        headroom={candidateHeadroom(candidate)}
                        headroomDraft={headroomDrafts[`${tierId}:${index}`] ?? null}
                        editable={editable}
                        canMoveUp={index > 0}
                        canMoveDown={index < candidates.length - 1}
                        accessibilityPrefix={`${TIER_META[tierId].label} ${candidate.model}`}
                        onHeadroomDraft={(value) => setHeadroomDraft(`${tierId}:${index}`, value)}
                        onHeadroomCommit={() => commitHeadroom(tierId, index)}
                        onMoveUp={() => moveCandidate(tierId, index, -1)}
                        onMoveDown={() => moveCandidate(tierId, index, 1)}
                        onRemove={() => removeCandidate(tierId, index)}
                      />
                    ))}
                    <ControlPillMenu
                      accessible
                      accessibilityRole="button"
                      accessibilityLabel={`Add candidate to ${TIER_META[tierId].label} tier`}
                      actions={pickerActions}
                      onPressAction={({ nativeEvent }) => {
                        const option = optionByKey.get(nativeEvent.event);
                        if (option) appendCandidate(tierId, option);
                      }}
                    >
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Add candidate to ${TIER_META[tierId].label} tier`}
                        disabled={!editable || pickerActions.length === 0}
                        className="flex-row items-center gap-3 border-t border-border-subtle p-4 active:opacity-70 disabled:opacity-40"
                      >
                        <SymbolView
                          name="plus"
                          size={20}
                          tintColorClassName="accent-icon"
                          type="monochrome"
                          weight="regular"
                        />
                        <Text className="text-base font-t3-medium text-link">
                          {pickerActions.length === 0
                            ? "No provider models available"
                            : "Add candidate"}
                        </Text>
                      </Pressable>
                    </ControlPillMenu>
                  </SettingsSection>
                );
              })
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
