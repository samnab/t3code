import type {
  EnvironmentId,
  OptimizerId,
  OptimizerStatus,
  OptimizerStatusSnapshot,
  ProjectId,
} from "@t3tools/contracts";
import { CheckCircle2Icon, CircleAlertIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const INSTALL_LINKS: Readonly<
  Record<OptimizerId, { readonly label: string; readonly href: string }>
> = {
  rtk: { label: "Install RTK", href: "https://github.com/rtk-ai/rtk" },
  headroom: { label: "Get Headroom", href: "https://extraheadroom.com" },
  cbm: {
    label: "Install CBM",
    href: "https://github.com/DeusData/codebase-memory-mcp",
  },
};

const OPTIMIZER_META: Readonly<
  Record<
    OptimizerId,
    {
      readonly label: string;
      readonly description: string;
      readonly mode: string;
      readonly supportedProviders: string;
    }
  >
> = {
  rtk: {
    label: "RTK",
    description: "Reduces shell output before it reaches an agent.",
    mode: "CLI wrapper",
    supportedProviders: "Claude Code (hook) and Codex (instructions)",
  },
  headroom: {
    label: "Headroom",
    description: "Detects Headroom's local proxy and reports its savings.",
    mode: "Detected proxy",
    supportedProviders: "Claude Code and Codex when their configs route via Headroom",
  },
  cbm: {
    label: "Codebase Memory",
    description: "Adds project-scoped codebase search tools through MCP.",
    mode: "stdio MCP",
    supportedProviders: "Claude Code, Codex, Grok, Cursor, and Antigravity",
  },
};

const OPTIMIZER_ORDER: readonly OptimizerId[] = ["rtk", "headroom", "cbm"];

function formatTokens(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}

function statusLabel(status: OptimizerStatus | undefined): string {
  if (!status) return "Waiting for probe";
  if (!status.installed) return "Not installed";
  if (status.id === "headroom") {
    return status.running === true ? "Running" : "Installed · not running";
  }
  return "Installed";
}

function statusTone(status: OptimizerStatus | undefined): "success" | "warning" | "secondary" {
  if (!status || !status.installed) return "warning";
  if (status.id === "headroom" && status.running !== true) return "secondary";
  return "success";
}

function StatusIcon({ status }: { readonly status: OptimizerStatus | undefined }) {
  if (status?.installed && (status.id !== "headroom" || status.running === true)) {
    return <CheckCircle2Icon aria-hidden className="size-4 text-success" />;
  }
  return <CircleAlertIcon aria-hidden className="size-4 text-warning" />;
}

function ProviderCompatibilityRow({ id }: { readonly id: OptimizerId }) {
  const meta = OPTIMIZER_META[id];
  const unsupported =
    id === "rtk"
      ? "Cursor, Grok, OpenCode, Antigravity, and Pi are not supported"
      : id === "cbm"
        ? "OpenCode and Pi are not supported in v1"
        : "Other providers are not routed through Headroom by T3";

  return (
    <SettingsRow
      title={meta.label}
      description={meta.supportedProviders}
      status={unsupported}
      control={<Badge variant="outline">{meta.mode}</Badge>}
    />
  );
}

function OptimizerStatusRows({ snapshot }: { readonly snapshot: OptimizerStatusSnapshot | null }) {
  const statusById = useMemo(
    () => new Map(snapshot?.optimizers.map((status) => [status.id, status]) ?? []),
    [snapshot?.optimizers],
  );

  return (
    <>
      {OPTIMIZER_ORDER.map((id) => {
        const status = statusById.get(id);
        const meta = OPTIMIZER_META[id];
        const installLink = INSTALL_LINKS[id];
        return (
          <SettingsRow
            key={id}
            title={
              <span className="flex items-center gap-2">
                <StatusIcon status={status} />
                {meta.label}
              </span>
            }
            description={meta.description}
            status={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Badge variant={statusTone(status)}>{statusLabel(status)}</Badge>
                {status?.version ? <span>{`v${status.version}`}</span> : null}
                {status?.detail ? <span>{status.detail}</span> : null}
              </span>
            }
            control={
              status?.installed ? null : (
                <a
                  className="inline-flex items-center gap-1 text-xs font-medium text-link hover:underline"
                  href={installLink.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  {installLink.label}
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </a>
              )
            }
          />
        );
      })}
    </>
  );
}

function SavingsRows({
  snapshot,
  environmentConnected = true,
}: {
  readonly snapshot: OptimizerStatusSnapshot | null;
  readonly environmentConnected?: boolean;
}) {
  if (!environmentConnected) {
    return (
      <SettingsRow
        title="Savings unavailable"
        description="Reconnect this environment to inspect its host-local counters."
      />
    );
  }
  if (snapshot === null || snapshot.savings.length === 0) {
    return (
      <SettingsRow
        title="No savings reported yet"
        description="Savings appear after the selected environment has processed optimizer-aware work."
      />
    );
  }

  return (
    <>
      {snapshot.savings.map((saving) => (
        <SettingsRow
          key={`${saving.source}:${saving.window}`}
          title={`${OPTIMIZER_META[saving.source].label} · ${saving.window === "all-time" ? "All time" : "This session"}`}
          description="Environment-level savings. These counters are not scoped to this project."
          control={
            <span className="text-sm tabular-nums">{formatTokens(saving.tokensSaved)} tokens</span>
          }
        />
      ))}
    </>
  );
}

function CbmIndexRow({
  projectId,
  snapshot,
}: {
  readonly projectId: ProjectId | null;
  readonly snapshot: OptimizerStatusSnapshot | null;
}) {
  const index =
    projectId === null
      ? null
      : (snapshot?.cbmIndexes.find((candidate) => candidate.projectId === projectId) ?? null);

  if (projectId === null) {
    return (
      <SettingsRow
        title="CBM index"
        description="Choose a project to inspect its codebase-memory index."
        status="No project selected"
      />
    );
  }

  const stateLabel = index
    ? index.state === "ready"
      ? "Ready"
      : index.state === "indexing"
        ? "Indexing"
        : "Degraded"
    : "Not indexed";
  const counts =
    index?.nodeCount !== undefined || index?.edgeCount !== undefined
      ? `${index.nodeCount ?? 0} nodes · ${index.edgeCount ?? 0} edges`
      : undefined;

  return (
    <SettingsRow
      title="CBM index"
      description="The index is scoped to this project. T3 does not delete CBM data."
      status={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge
            variant={
              index?.state === "ready"
                ? "success"
                : index?.state === "degraded"
                  ? "warning"
                  : "secondary"
            }
          >
            {stateLabel}
          </Badge>
          {counts ? <span>{counts}</span> : null}
          {index?.detail ? <span>{index.detail}</span> : null}
        </span>
      }
      control={
        <span className="text-xs text-muted-foreground">
          {index
            ? `Checked ${new Date(index.checkedAt).toLocaleTimeString()}`
            : "No index reported"}
        </span>
      }
    />
  );
}

function OptimizerEnvironmentSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const environment = useEnvironments().environments.find(
    (candidate) => candidate.environmentId === environmentId,
  );
  const settings = useEnvironmentSettings(environmentId);
  const projects = useProjects();
  const environmentProjects = useMemo(
    () => projects.filter((project) => project.environmentId === environmentId),
    [environmentId, projects],
  );
  const [projectSelection, setProjectSelection] = useState<ProjectId | null>(
    environmentProjects[0]?.id ?? null,
  );
  const selectedProjectId =
    projectSelection !== null &&
    environmentProjects.some((project) => project.id === projectSelection)
      ? projectSelection
      : (environmentProjects[0]?.id ?? null);
  const [binaryDraft, setBinaryDraft] = useState<string | null>(null);
  const statusQuery = useEnvironmentQuery(
    environment?.connection.phase === "connected"
      ? serverEnvironment.optimizersGetStatus({
          environmentId,
          input: { refresh: true },
        })
      : null,
  );
  const environmentConnected = environment?.connection.phase === "connected";
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "optimizer setting",
    reportFailure: true,
  });
  const [savingProject, setSavingProject] = useState(false);
  const [savingBinary, setSavingBinary] = useState(false);
  const selectedProject = environmentProjects.find((project) => project.id === selectedProjectId);
  const selectedProjectSettings =
    selectedProjectId === null ? undefined : settings.projectOptimizerOverrides[selectedProjectId];
  const cbmBinaryPath = settings.optimizerBinaryPaths.cbm;

  const saveProjectOptimizer = async (id: OptimizerId, enabled: boolean) => {
    if (selectedProjectId === null || savingProject || !environmentConnected) return;
    setSavingProject(true);
    try {
      await updateSettings({
        environmentId,
        input: {
          patch: {
            projectOptimizerOverrides: {
              [selectedProjectId]: { [id]: enabled },
            },
          },
        },
      });
    } finally {
      setSavingProject(false);
    }
  };

  const saveBinaryPath = useCallback(
    (next: string) => {
      if (savingBinary || next === cbmBinaryPath || !environmentConnected) return;
      setBinaryDraft(null);
      setSavingBinary(true);
      void updateSettings({
        environmentId,
        input: { patch: { optimizerBinaryPaths: { cbm: next } } },
      }).finally(() => setSavingBinary(false));
    },
    [cbmBinaryPath, environmentConnected, environmentId, savingBinary, updateSettings],
  );

  const commitBinaryPath = useCallback(() => {
    if (binaryDraft === null) return;
    const next = binaryDraft.trim();
    if (next === cbmBinaryPath) {
      setBinaryDraft(null);
      return;
    }
    saveBinaryPath(next);
  }, [binaryDraft, cbmBinaryPath, saveBinaryPath]);

  const resetBinaryPath = useCallback(() => {
    saveBinaryPath("");
  }, [saveBinaryPath]);

  return (
    <>
      <SettingsSection
        id="optimizer-status"
        title="Status"
        description={
          environment
            ? `${environment.label} · probes run where this environment's server runs.`
            : "Probes run where the selected environment's server runs."
        }
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={statusQuery.isPending || !environmentConnected}
            aria-label="Refresh optimizer status"
            onClick={statusQuery.refresh}
          >
            <RefreshCwIcon className="size-3.5" />
            {statusQuery.isPending ? "Checking…" : "Refresh"}
          </Button>
        }
      >
        {!environmentConnected ? (
          <SettingsRow
            title="Environment not connected"
            description="Reconnect this environment to probe its host-local optimizer tools."
            status={environment?.connection.phase ?? "Unavailable"}
          />
        ) : statusQuery.error ? (
          <SettingsRow
            title="Could not check optimizer status"
            description={statusQuery.error}
            control={
              <Button size="sm" variant="outline" onClick={statusQuery.refresh}>
                Try again
              </Button>
            }
          />
        ) : statusQuery.isPending && statusQuery.data === null ? (
          <SettingsRow
            title="Checking this environment…"
            description="The probe will finish shortly."
          />
        ) : (
          <OptimizerStatusRows snapshot={statusQuery.data} />
        )}
      </SettingsSection>

      <SettingsSection
        id="optimizer-savings"
        title="Savings"
        description="RTK and Headroom report their own environment-level counters. CBM has no token-savings telemetry."
      >
        <SavingsRows snapshot={statusQuery.data} environmentConnected={environmentConnected} />
      </SettingsSection>

      <SettingsSection
        id="optimizer-project"
        title="Project attachments"
        description="Choose which optimizers T3 attaches when a new provider session starts. All are off by default."
      >
        {environmentProjects.length === 0 ? (
          <SettingsRow
            title="No projects on this environment"
            description="Add a project before choosing optimizer attachments."
          />
        ) : (
          <>
            <SettingsRow
              title="Project"
              description="Optimizer status and attachments below are scoped to this project."
              control={
                <Select
                  value={selectedProjectId ?? ""}
                  onValueChange={(value) => {
                    const project = environmentProjects.find((candidate) => candidate.id === value);
                    setProjectSelection(project?.id ?? null);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="max-w-full sm:w-64"
                    aria-label="Optimizer project"
                  >
                    <SelectValue>{selectedProject?.title ?? "Choose a project"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {environmentProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        <span className="max-w-80 truncate">{project.title}</span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
            {OPTIMIZER_ORDER.map((id) => (
              <SettingsRow
                key={id}
                title={OPTIMIZER_META[id].label}
                description={
                  id === "headroom"
                    ? "T3 detects the local Headroom proxy; this switch never starts or stops it."
                    : id === "cbm"
                      ? "Adds CBM as a project-scoped MCP server for supported providers."
                      : "Adds RTK's shell filtering at the provider attachment layer."
                }
                status={
                  selectedProjectSettings?.[id] === true ? "Enabled for the next session" : "Off"
                }
                control={
                  <Switch
                    checked={selectedProjectSettings?.[id] === true}
                    disabled={savingProject || selectedProjectId === null || !environmentConnected}
                    aria-label={`Enable ${OPTIMIZER_META[id].label} for project`}
                    onCheckedChange={(enabled) => void saveProjectOptimizer(id, enabled)}
                  />
                }
              />
            ))}
            <CbmIndexRow projectId={selectedProjectId} snapshot={statusQuery.data} />
          </>
        )}
      </SettingsSection>

      <SettingsSection
        id="optimizer-compatibility"
        title="Provider compatibility"
        description="T3 only attaches an optimizer where the provider has a compatible hook, proxy, or MCP surface."
      >
        {OPTIMIZER_ORDER.map((id) => (
          <ProviderCompatibilityRow key={id} id={id} />
        ))}
      </SettingsSection>

      <SettingsSection
        id="optimizer-configuration"
        title="Configuration"
        description="These paths are read on the selected environment. T3 does not install or update optimizer binaries."
      >
        <SettingsRow
          title="CBM binary path"
          description="Use a custom codebase-memory-mcp executable when it is not on PATH. Leave blank to use codebase-memory-mcp."
          resetAction={
            cbmBinaryPath !== "codebase-memory-mcp" ? (
              <SettingResetButton
                label="CBM binary path"
                disabled={savingBinary || !environmentConnected}
                onClick={resetBinaryPath}
              />
            ) : null
          }
          control={
            <Input
              size="sm"
              className="w-full sm:w-64"
              value={binaryDraft ?? cbmBinaryPath}
              disabled={savingBinary || !environmentConnected}
              aria-label="CBM binary path"
              onChange={(event) => setBinaryDraft(event.currentTarget.value)}
              onBlur={commitBinaryPath}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          }
        />
      </SettingsSection>
    </>
  );
}

export function OptimizersSettingsPanel() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [environmentSelection, setEnvironmentSelection] = useState<EnvironmentId | null>(
    primaryEnvironmentId ?? environments[0]?.environmentId ?? null,
  );

  const selectedEnvironmentId =
    environmentSelection !== null &&
    environments.some((environment) => environment.environmentId === environmentSelection)
      ? environmentSelection
      : (primaryEnvironmentId ?? environments[0]?.environmentId ?? null);

  const selectedEnvironment = environments.find(
    (environment) => environment.environmentId === selectedEnvironmentId,
  );

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        id="optimizers"
        title="Optimizers"
        description="Bring your own RTK, Headroom, or Codebase Memory installation. T3 discovers tools on the environment that runs your provider sessions."
      >
        <SettingsRow
          title="Environment"
          description="Status, savings, and project attachments below belong to this environment."
          control={
            environments.length > 0 ? (
              <Select
                value={selectedEnvironmentId ?? ""}
                onValueChange={(value) => {
                  const environment = environments.find(
                    (candidate) => candidate.environmentId === value,
                  );
                  setEnvironmentSelection(environment?.environmentId ?? null);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="max-w-full sm:w-64"
                  aria-label="Optimizer environment"
                >
                  <SelectValue>{selectedEnvironment?.label ?? "Choose an environment"}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {environments.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      <span className="flex max-w-80 items-center gap-2">
                        <span className="truncate">{environment.label}</span>
                        {environment.connection.phase !== "connected" ? (
                          <span className="text-xs text-muted-foreground">
                            {environment.connection.phase}
                          </span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : (
              <span className="text-sm text-muted-foreground">No environments connected</span>
            )
          }
        />
      </SettingsSection>
      {selectedEnvironmentId === null ? (
        <SettingsSection id="optimizer-empty" title="Optimizer status">
          <SettingsRow
            title="Connect an environment"
            description="Optimizer status lives on a T3 server. Connect an environment to inspect its host-local tools."
          />
        </SettingsSection>
      ) : (
        <OptimizerEnvironmentSettings environmentId={selectedEnvironmentId} />
      )}
    </SettingsPageContainer>
  );
}
