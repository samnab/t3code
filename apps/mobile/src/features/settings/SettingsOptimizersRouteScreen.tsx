import type {
  EnvironmentId,
  OptimizerId,
  OptimizerStatus,
  OptimizerStatusSnapshot,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsSection } from "./components/SettingsSection";

const OPTIMIZER_ORDER: readonly OptimizerId[] = ["rtk", "headroom", "cbm"];

const OPTIMIZER_META: Readonly<
  Record<
    OptimizerId,
    {
      readonly label: string;
      readonly description: string;
      readonly mode: string;
      readonly installUrl: string;
    }
  >
> = {
  rtk: {
    label: "RTK",
    description: "Shell output filtering",
    mode: "CLI wrapper",
    installUrl: "https://github.com/rtk-ai/rtk",
  },
  headroom: {
    label: "Headroom",
    description: "Local proxy detection",
    mode: "Detected proxy",
    installUrl: "https://extraheadroom.com",
  },
  cbm: {
    label: "Codebase Memory",
    description: "Project-scoped MCP tools",
    mode: "stdio MCP",
    installUrl: "https://github.com/DeusData/codebase-memory-mcp",
  },
};

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
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
  return (
    <View className="flex-row items-start gap-3 border-t border-border-subtle p-4 first:border-t-0">
      <SymbolView
        name={status?.installed ? "checkmark.circle" : "exclamationmark.triangle"}
        size={22}
        tintColorClassName={status?.installed ? "accent-icon" : "accent-warning-foreground"}
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

function CbmIndexRows({ snapshot }: { readonly snapshot: OptimizerStatusSnapshot | null }) {
  const indexes = snapshot?.cbmIndexes ?? [];
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

function ConnectedEnvironmentOptimizerSections({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.optimizersGetStatus({
      environmentId,
      input: { refresh: true },
    }),
  );
  const statusById = useMemo(
    () => new Map(query.data?.optimizers.map((status) => [status.id, status]) ?? []),
    [query.data?.optimizers],
  );

  return (
    <>
      <SettingsSection title={`${environmentLabel} · Status`}>
        {query.error ? (
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
          disabled={query.isPending}
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

      <SettingsSection title={`${environmentLabel} · CBM index health`}>
        <CbmIndexRows snapshot={query.data} />
        <Text className="px-4 pb-4 text-sm leading-normal text-foreground-muted">
          CBM has no token-savings telemetry. T3 does not delete its index data.
        </Text>
      </SettingsSection>
    </>
  );
}

export function SettingsOptimizersRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const connectedEnvironments = environments.filter(
    (environment) => environment.connection.phase === "connected",
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
          Optimizers run where each T3 environment runs its provider sessions. Mobile observes host
          status and environment-level savings; configure project attachments from the web or
          desktop Settings.
        </Text>
        {connectedEnvironments.length === 0 ? (
          <SettingsSection title="Optimizer status">
            <View className="p-4">
              <Text className="text-base text-foreground">Connect an environment</Text>
              <Text className="mt-1 text-sm leading-normal text-foreground-muted">
                Connect a T3 server to inspect its host-local optimizer installations.
              </Text>
            </View>
          </SettingsSection>
        ) : (
          connectedEnvironments.map((environment) => (
            <ConnectedEnvironmentOptimizerSections
              key={environment.environmentId}
              environmentId={environment.environmentId}
              environmentLabel={environment.label}
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}
