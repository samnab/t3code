import { DEFAULT_HEADROOM_PROXY_URL, EnvironmentId, ProjectId } from "@t3tools/contracts";
import type {
  OptimizerId,
  OptimizerSavingsInterval,
  OptimizerStatus,
  OptimizerStatusSnapshot,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ControlPillMenu } from "../../components/ControlPill";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const OPTIMIZER_ORDER: readonly OptimizerId[] = ["rtk", "headroom", "cbm"];

const OPTIMIZER_ICONS: Readonly<Record<OptimizerId, ComponentProps<typeof SymbolView>["name"]>> = {
  rtk: "terminal",
  headroom: "bolt.horizontal.circle",
  cbm: "cube",
};

const OPTIMIZER_META: Readonly<
  Record<
    OptimizerId,
    {
      readonly label: string;
      readonly description: string;
      readonly mode: string;
      readonly installUrl: string;
      readonly supportedProviders: string;
      readonly unsupportedProviders: string;
    }
  >
> = {
  rtk: {
    label: "RTK",
    description: "Shell output filtering",
    mode: "CLI wrapper",
    installUrl: "https://github.com/rtk-ai/rtk",
    supportedProviders: "Claude Code (hook) and Codex (instructions)",
    unsupportedProviders: "Cursor, Grok, external OpenCode, Antigravity, and Pi",
  },
  headroom: {
    label: "Headroom",
    description: "Local proxy detection",
    mode: "Detected proxy",
    installUrl: "https://extraheadroom.com",
    supportedProviders: "Claude Code and Codex when routed through Headroom",
    unsupportedProviders: "Other providers are not routed through Headroom by T3",
  },
  cbm: {
    label: "Codebase Memory",
    description: "Project-scoped MCP tools",
    mode: "stdio MCP",
    installUrl: "https://github.com/DeusData/codebase-memory-mcp",
    supportedProviders: "Claude Code, Codex, Grok, Cursor, Antigravity, and managed OpenCode",
    unsupportedProviders: "External OpenCode and Pi are not supported in v1",
  },
};

function OptimizerSelectionRow(props: {
  readonly label: string;
  readonly value: string;
  readonly accessibilityLabel: string;
  readonly actions: ComponentProps<typeof ControlPillMenu>["actions"];
  readonly onSelect: (id: string) => void;
}) {
  return (
    <ControlPillMenu
      accessible
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      title={props.label}
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        className="flex-row items-center gap-4 p-4 active:opacity-70"
      >
        <SymbolView
          name="folder"
          size={22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <View className="min-w-0 flex-1">
          <Text className="text-lg text-foreground">{props.label}</Text>
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

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function savingsIntervalLabel(interval: OptimizerSavingsInterval): string {
  switch (interval) {
    case "hour":
      return "Hourly";
    case "day":
      return "Daily";
    case "week":
      return "Weekly";
    case "month":
      return "Monthly";
  }
}

function optimizerStatusLabel(status: OptimizerStatus | undefined): string {
  if (!status) return "Waiting for probe";
  if (!status.installed) return "Not installed";
  if (status.id === "headroom") {
    return status.running === true ? "Running" : "Installed · not running";
  }
  return "Installed";
}

function optimizerStatusClass(status: OptimizerStatus | undefined): string {
  if (!status || !status.installed) return "text-warning-foreground";
  if (status.id === "headroom" && status.running !== true) return "text-foreground-muted";
  return "text-foreground";
}

function OptimizerRow({
  id,
  status,
  onInstall,
}: {
  readonly id: OptimizerId;
  readonly status: OptimizerStatus | undefined;
  readonly onInstall?: () => void;
}) {
  const meta = OPTIMIZER_META[id];
  const ready = status?.installed === true && (id !== "headroom" || status.running === true);
  return (
    <View className="flex-row items-start gap-3 border-t border-border-subtle p-4 first:border-t-0">
      <SymbolView
        name={ready ? "checkmark.circle" : "exclamationmark.triangle"}
        size={22}
        tintColorClassName={ready ? "accent-icon" : "accent-warning-foreground"}
        type="monochrome"
        weight="regular"
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text className="text-base font-t3-medium text-foreground">{meta.label}</Text>
          <Text className="text-xs text-foreground-muted">{meta.mode}</Text>
        </View>
        <Text className="text-sm text-foreground-muted">{meta.description}</Text>
        <Text className={`text-sm ${optimizerStatusClass(status)}`}>
          {optimizerStatusLabel(status)}
          {status?.version ? ` · v${status.version}` : ""}
        </Text>
        {status?.detail ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={3}>
            {status.detail}
          </Text>
        ) : null}
        {status?.installed !== true && onInstall ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Install ${meta.label}`}
            onPress={onInstall}
            className="self-start py-1 active:opacity-70"
          >
            <Text className="text-sm font-t3-medium text-link">Install or learn more</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function SavingsRows({ snapshot }: { readonly snapshot: OptimizerStatusSnapshot | null }) {
  if (snapshot === null || snapshot.savings.length === 0) {
    return (
      <View className="p-4">
        <Text className="text-base text-foreground">No savings reported yet</Text>
        <Text className="mt-1 text-sm leading-normal text-foreground-muted">
          RTK and Headroom report counters from the selected environment after optimizer-aware work
          runs.
        </Text>
      </View>
    );
  }

  return (
    <>
      {snapshot.savings.map((saving) => (
        <View
          key={`${saving.source}:${saving.window}`}
          className="flex-row items-center gap-3 border-t border-border-subtle p-4 first:border-t-0"
        >
          <SymbolView
            name="chart.bar.xaxis"
            size={22}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="regular"
          />
          <View className="min-w-0 flex-1">
            <Text className="text-base font-t3-medium text-foreground">
              {OPTIMIZER_META[saving.source].label} ·{" "}
              {saving.window === "all-time" ? "All time" : "This session"}
            </Text>
            <Text className="text-sm text-foreground-muted">
              Environment-level savings, across projects
            </Text>
          </View>
          <Text className="text-sm tabular-nums text-foreground">
            {formatTokens(saving.tokensSaved)} tokens
          </Text>
        </View>
      ))}
    </>
  );
}

function SavingsHistoryRows({ snapshot }: { readonly snapshot: OptimizerStatusSnapshot | null }) {
  const history = snapshot?.savingsHistory ?? [];
  if (history.length === 0) {
    return (
      <View className="p-4">
        <Text className="text-base text-foreground">No savings history yet</Text>
        <Text className="mt-1 text-sm leading-normal text-foreground-muted">
          Headroom history appears after the selected environment records optimizer-aware work.
        </Text>
      </View>
    );
  }

  return (
    <>
      {[...history]
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, 8)
        .map((point) => (
          <View
            key={`${point.interval}:${point.timestamp}`}
            className="flex-row items-center gap-3 border-t border-border-subtle p-4 first:border-t-0"
          >
            <SymbolView
              name="chart.bar.xaxis"
              size={22}
              tintColorClassName="accent-icon"
              type="monochrome"
              weight="regular"
            />
            <View className="min-w-0 flex-1">
              <Text className="text-base font-t3-medium text-foreground">
                Headroom · {savingsIntervalLabel(point.interval)}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                {new Date(point.timestamp).toLocaleString()} · Environment-level history
              </Text>
            </View>
            <Text className="text-sm tabular-nums text-foreground">
              {formatTokens(point.tokensSaved)} tokens
            </Text>
          </View>
        ))}
    </>
  );
}

function CbmIndexRows({
  snapshot,
  selectedProjectId,
}: {
  readonly snapshot: OptimizerStatusSnapshot | null;
  readonly selectedProjectId: ProjectId | null;
}) {
  const indexes =
    snapshot?.cbmIndexes.filter(
      (index) => selectedProjectId === null || index.projectId === selectedProjectId,
    ) ?? [];
  if (indexes.length === 0) {
    return (
      <View className="p-4">
        <Text className="text-base text-foreground">No CBM indexes reported yet</Text>
        <Text className="mt-1 text-sm leading-normal text-foreground-muted">
          Index health appears after Codebase Memory is enabled for a project.
        </Text>
      </View>
    );
  }

  return (
    <>
      {indexes.map((index) => (
        <View
          key={index.projectId}
          className="flex-row items-start gap-3 border-t border-border-subtle p-4 first:border-t-0"
        >
          <SymbolView
            name={index.state === "degraded" ? "exclamationmark.triangle" : "folder"}
            size={22}
            tintColorClassName={
              index.state === "degraded" ? "accent-warning-foreground" : "accent-icon"
            }
            type="monochrome"
            weight="regular"
          />
          <View className="min-w-0 flex-1">
            <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
              {index.repoPath}
            </Text>
            <Text
              className={`text-sm ${index.state === "degraded" ? "text-warning-foreground" : index.state === "ready" ? "text-foreground" : "text-foreground-muted"}`}
            >
              {index.state === "ready"
                ? "Ready"
                : index.state === "indexing"
                  ? "Indexing"
                  : "Degraded"}
              {index.nodeCount !== undefined || index.edgeCount !== undefined
                ? ` · ${index.nodeCount ?? 0} nodes · ${index.edgeCount ?? 0} edges`
                : ""}
            </Text>
            {index.detail ? (
              <Text className="text-xs text-foreground-muted" numberOfLines={3}>
                {index.detail}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </>
  );
}

function ProviderCompatibilityRows() {
  return (
    <>
      {OPTIMIZER_ORDER.map((id) => (
        <View key={id} className="border-t border-border-subtle p-4 first:border-t-0">
          <Text className="text-base font-t3-medium text-foreground">
            {OPTIMIZER_META[id].label}
          </Text>
          <Text className="mt-1 text-sm text-foreground-muted">
            Supported: {OPTIMIZER_META[id].supportedProviders}
          </Text>
          <Text className="mt-1 text-xs text-foreground-muted">
            Unsupported: {OPTIMIZER_META[id].unsupportedProviders}
          </Text>
        </View>
      ))}
    </>
  );
}

function HeadroomProxySettings({
  environmentId,
  environmentLabel,
  connected,
  proxyUrl,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
  readonly proxyUrl: string;
  readonly onSaved: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveInFlight = useRef(false);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "Headroom proxy URL update",
    reportFailure: false,
  });

  const save = useCallback(
    async (value: string) => {
      if (saveInFlight.current || !connected) return;
      const next = value.trim();
      if (next === proxyUrl) {
        setDraft(null);
        setError(null);
        return;
      }

      saveInFlight.current = true;
      setSaving(true);
      setError(null);
      try {
        const result = await updateSettings({
          environmentId,
          input: { patch: { headroomProxyUrl: next } },
        });
        if (result._tag === "Success") {
          setDraft(null);
          onSaved();
        } else if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error ? failure.message : "Headroom proxy URL could not be saved.",
          );
        }
      } catch (failure) {
        setError(
          failure instanceof Error ? failure.message : "Headroom proxy URL could not be saved.",
        );
      } finally {
        saveInFlight.current = false;
        setSaving(false);
      }
    },
    [connected, environmentId, onSaved, proxyUrl, updateSettings],
  );

  const commit = useCallback(() => {
    if (draft !== null) void save(draft);
  }, [draft, save]);

  const reset = useCallback(() => {
    setDraft(DEFAULT_HEADROOM_PROXY_URL);
    void save(DEFAULT_HEADROOM_PROXY_URL);
  }, [save]);

  return (
    <SettingsSection title={`${environmentLabel} · Configuration`}>
      <View className="gap-3 p-4">
        <View className="gap-1">
          <Text className="text-base font-t3-medium text-foreground">Headroom proxy URL</Text>
          <Text className="text-sm leading-normal text-foreground-muted">
            The HTTP loopback origin where this environment can reach an existing Headroom proxy.
            Use the base origin, such as http://127.0.0.1:8787; /v1 is not needed. T3 only detects
            and measures it and never starts or configures Headroom.
          </Text>
        </View>
        <TextInput
          value={draft ?? proxyUrl}
          editable={connected && !saving}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          keyboardType="url"
          returnKeyType="done"
          accessibilityLabel="Headroom proxy URL"
          onChangeText={(value) => {
            setDraft(value);
            setError(null);
          }}
          onBlur={commit}
          onSubmitEditing={commit}
        />
        <View className="flex-row items-center justify-between gap-3">
          {error ? (
            <Text className="min-w-0 flex-1 text-sm text-danger-foreground">{error}</Text>
          ) : (
            <Text className="min-w-0 flex-1 text-xs text-foreground-muted">
              Default: {DEFAULT_HEADROOM_PROXY_URL}
            </Text>
          )}
          {proxyUrl !== DEFAULT_HEADROOM_PROXY_URL ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reset Headroom proxy URL to default"
              disabled={!connected || saving}
              onPress={reset}
              className="rounded-full bg-subtle px-4 py-2 active:opacity-70 disabled:opacity-40"
            >
              <Text className="font-t3-medium text-foreground">Reset</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </SettingsSection>
  );
}

function ConnectedEnvironmentOptimizerSections({
  environmentId,
  environmentLabel,
  connected,
  headroomProxyUrl,
  selectedProjectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly connected: boolean;
  readonly headroomProxyUrl: string;
  readonly selectedProjectId: ProjectId | null;
}) {
  const query = useEnvironmentQuery(
    connected
      ? serverEnvironment.optimizersGetStatus({
          environmentId,
          input: { refresh: true },
        })
      : null,
  );
  const statusById = useMemo(
    () => new Map(query.data?.optimizers.map((status) => [status.id, status]) ?? []),
    [query.data?.optimizers],
  );

  return (
    <>
      <SettingsSection title={`${environmentLabel} · Status`}>
        {!connected ? (
          <View className="p-4">
            <Text className="text-base text-foreground">Environment is not connected</Text>
            <Text className="mt-1 text-sm leading-normal text-foreground-muted">
              Reconnect this environment to inspect its host-local optimizer installations.
            </Text>
          </View>
        ) : query.error ? (
          <View className="items-start gap-2 p-4">
            <Text className="text-base text-danger-foreground">
              Could not check optimizer status
            </Text>
            <Text className="text-sm leading-normal text-foreground-muted">{query.error}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Retry optimizer status for ${environmentLabel}`}
              onPress={query.refresh}
              className="rounded-full bg-subtle px-4 py-2 active:opacity-70"
            >
              <Text className="font-t3-medium text-foreground">Try again</Text>
            </Pressable>
          </View>
        ) : query.isPending && query.data === null ? (
          <View className="flex-row items-center gap-3 p-4">
            <ActivityIndicator />
            <Text className="text-sm text-foreground-muted">Checking this environment…</Text>
          </View>
        ) : (
          OPTIMIZER_ORDER.map((id) => (
            <OptimizerRow
              key={id}
              id={id}
              status={statusById.get(id)}
              onInstall={() => void Linking.openURL(OPTIMIZER_META[id].installUrl)}
            />
          ))
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Refresh optimizer status for ${environmentLabel}`}
          disabled={!connected || query.isPending}
          onPress={query.refresh}
          className="flex-row items-center gap-3 border-t border-border-subtle p-4 disabled:opacity-40"
        >
          <SymbolView
            name="arrow.clockwise"
            size={20}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="regular"
          />
          <Text className="text-base font-t3-medium text-foreground">
            {query.isPending ? "Refreshing…" : "Refresh status"}
          </Text>
        </Pressable>
      </SettingsSection>

      <SettingsSection title={`${environmentLabel} · Savings`}>
        <SavingsRows snapshot={query.data} />
      </SettingsSection>

      <SettingsSection title={`${environmentLabel} · Savings history`}>
        <SavingsHistoryRows snapshot={query.data} />
      </SettingsSection>

      <HeadroomProxySettings
        key={environmentId}
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        connected={connected}
        proxyUrl={headroomProxyUrl}
        onSaved={query.refresh}
      />

      <SettingsSection title={`${environmentLabel} · CBM index health`}>
        <CbmIndexRows snapshot={query.data} selectedProjectId={selectedProjectId} />
        <Text className="px-4 pb-4 text-sm leading-normal text-foreground-muted">
          CBM has no token-savings telemetry. T3 does not delete its index data.
        </Text>
      </SettingsSection>

      <SettingsSection title={`${environmentLabel} · Provider compatibility`}>
        <ProviderCompatibilityRows />
      </SettingsSection>
    </>
  );
}
export function SettingsOptimizersRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [environmentSelection, setEnvironmentSelection] = useState<EnvironmentId | null>(null);
  const [projectSelection, setProjectSelection] = useState<ProjectId | null>(null);
  const [savingOptimizer, setSavingOptimizer] = useState<OptimizerId | null>(null);
  const selectedEnvironment = useMemo(
    () =>
      environments.find((environment) => environment.environmentId === environmentSelection) ??
      environments[0] ??
      null,
    [environmentSelection, environments],
  );
  const selectedEnvironmentId = selectedEnvironment?.environmentId ?? null;
  const selectedEnvironmentConnected = selectedEnvironment?.connection.phase === "connected";
  const selectedEnvironmentConfig = useEnvironmentServerConfig(selectedEnvironmentId);
  const environmentProjects = useMemo(
    () =>
      selectedEnvironmentId === null
        ? []
        : projects.filter((project) => project.environmentId === selectedEnvironmentId),
    [projects, selectedEnvironmentId],
  );
  const selectedProject = useMemo(
    () =>
      environmentProjects.find((project) => project.id === projectSelection) ??
      environmentProjects[0] ??
      null,
    [environmentProjects, projectSelection],
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "project optimizer setting",
    reportFailure: true,
  });
  const updateProjectOptimizer = async (id: OptimizerId, enabled: boolean) => {
    if (
      selectedEnvironmentId === null ||
      !selectedEnvironmentConnected ||
      selectedEnvironmentConfig === null ||
      selectedProject === null ||
      savingOptimizer !== null
    ) {
      return;
    }
    setSavingOptimizer(id);
    try {
      await updateSettings({
        environmentId: selectedEnvironmentId,
        input: {
          patch: {
            projectOptimizerOverrides: {
              [selectedProject.id]: { [id]: enabled },
            },
          },
        },
      });
    } finally {
      setSavingOptimizer(null);
    }
  };
  const environmentActions = useMemo(
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
  const projectActions = useMemo(
    () =>
      environmentProjects.map((project) => ({
        id: project.id,
        title: project.title,
        subtitle: project.workspaceRoot,
        state: project.id === selectedProject?.id ? ("on" as const) : ("off" as const),
      })),
    [environmentProjects, selectedProject?.id],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Optimizers" onBack={() => navigation.goBack()} />
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
          Optimizers run where each T3 environment runs its provider sessions. Select an environment
          and project to inspect host status and toggle project attachments.
        </Text>
        {environments.length === 0 ? (
          <SettingsSection title="Optimizer status">
            <View className="p-4">
              <Text className="text-base text-foreground">Connect an environment</Text>
              <Text className="mt-1 text-sm leading-normal text-foreground-muted">
                Connect a T3 server to inspect and configure its host-local optimizer installations.
              </Text>
            </View>
          </SettingsSection>
        ) : (
          <>
            <SettingsSection title="Environment">
              <OptimizerSelectionRow
                label="T3 environment"
                value={
                  selectedEnvironment
                    ? `${selectedEnvironment.label} · ${selectedEnvironment.connection.phase}`
                    : "Select an environment"
                }
                accessibilityLabel="Select optimizer environment"
                actions={environmentActions}
                onSelect={(id) => setEnvironmentSelection(EnvironmentId.make(id))}
              />
            </SettingsSection>
            {selectedEnvironment && selectedEnvironmentId !== null ? (
              <SettingsSection title={`${selectedEnvironment.label} · Project optimizers`}>
                {selectedProject && projectActions.length > 0 ? (
                  <>
                    <OptimizerSelectionRow
                      label="Project"
                      value={selectedProject.title}
                      accessibilityLabel="Select optimizer project"
                      actions={projectActions}
                      onSelect={(id) => setProjectSelection(ProjectId.make(id))}
                    />
                    {OPTIMIZER_ORDER.map((id) => {
                      const enabled =
                        selectedEnvironmentConfig?.settings.projectOptimizerOverrides[
                          selectedProject.id
                        ]?.[id] ?? false;
                      return (
                        <SettingsSwitchRow
                          key={id}
                          icon={OPTIMIZER_ICONS[id]}
                          label={OPTIMIZER_META[id].label}
                          subtitle={
                            id === "headroom"
                              ? "Selects proxy use; never starts or stops Headroom"
                              : id === "cbm"
                                ? "Adds project-scoped MCP tools; no token savings"
                                : "Filters supported CLI output for this project"
                          }
                          value={enabled}
                          disabled={
                            !selectedEnvironmentConnected ||
                            selectedEnvironmentConfig === null ||
                            savingOptimizer !== null
                          }
                          onValueChange={(value) => void updateProjectOptimizer(id, value)}
                        />
                      );
                    })}
                  </>
                ) : (
                  <View className="p-4">
                    <Text className="text-base text-foreground">No projects available</Text>
                    <Text className="mt-1 text-sm leading-normal text-foreground-muted">
                      Sync a project from this environment before configuring optimizer attachments.
                    </Text>
                  </View>
                )}
              </SettingsSection>
            ) : null}
            {selectedEnvironment ? (
              <ConnectedEnvironmentOptimizerSections
                key={selectedEnvironment.environmentId}
                environmentId={selectedEnvironment.environmentId}
                environmentLabel={selectedEnvironment.label}
                connected={selectedEnvironmentConnected}
                headroomProxyUrl={
                  selectedEnvironmentConfig?.settings.headroomProxyUrl ?? DEFAULT_HEADROOM_PROXY_URL
                }
                selectedProjectId={selectedProject?.id ?? null}
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
