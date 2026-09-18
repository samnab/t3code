"use client";

import { Spinner } from "~/components/ui/spinner";

import {
  ArrowUpCircleIcon,
  CopyIcon,
  DownloadIcon,
  LockIcon,
  LockOpenIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  isProviderDriverKind,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ServerProvider,
  type ProviderOptionSelections,
  type ServerProviderModel,
} from "@t3tools/contracts";

import {
  type CustomModelDefinition,
  readCustomModelEntries,
  toCustomModelSetting,
} from "@t3tools/shared/model";
import { cn } from "../../lib/utils";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  deriveProviderInstanceEntries,
  normalizeProviderAccentColor,
} from "../../providerInstances";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { DriverOption } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";
import { ProviderModelsSection } from "./ProviderModelsSection";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingResetButton } from "./settingsLayout";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { ProviderInstanceIcon, providerInstanceInitials } from "../chat/ProviderInstanceIcon";
import { ProviderAccentColorPicker } from "./ProviderAccentColorPicker";
import { RedactedSensitiveText } from "./RedactedSensitiveText";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  getProviderVersionAdvisoryPresentation,
  PROVIDER_STATUS_STYLES,
  getProviderSummary,
  getProviderVersionLabel,
  type ProviderStatusKey,
} from "./providerStatus";

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

let environmentVariableDraftId = 0;
const nextEnvironmentVariableDraftId = () => `provider-env-${environmentVariableDraftId++}`;

type EnvironmentDraftRow = {
  readonly id: string;
  readonly name: string;
  readonly value: string;
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
};

function makeEnvironmentDraftRow(
  variable: ProviderInstanceEnvironmentVariable,
  index: number,
): EnvironmentDraftRow {
  return {
    id: `${index}:${variable.name}`,
    name: variable.name,
    value: variable.value,
    sensitive: variable.sensitive,
    ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}),
  };
}

function providerEnvironmentsEqual(
  left: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  right: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): boolean {
  return (
    left.length === right.length &&
    left.every((variable, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        variable.name === other.name &&
        variable.value === other.value &&
        variable.sensitive === other.sensitive &&
        variable.valueRedacted === other.valueRedacted
      );
    })
  );
}

/**
 * Read `customModels` from the opaque config blob. The concrete driver
 * schemas type it as `CustomModelSetting[]`, but it arrives here as
 * `Schema.Unknown`, so the shared reader does the shape checking.
 */
function readConfigCustomModels(config: unknown): ReadonlyArray<CustomModelDefinition> {
  if (config === null || typeof config !== "object") return [];
  return readCustomModelEntries((config as Record<string, unknown>).customModels);
}

/**
 * Read Pi's `modelConcurrency` map from the opaque config blob. Only
 * positive safe integers survive; anything else means "no cap".
 */
function readConfigModelConcurrency(config: unknown): Record<string, number> {
  if (config === null || typeof config !== "object") return {};
  const raw = (config as Record<string, unknown>).modelConcurrency;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const caps: Record<string, number> = {};
  for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 1) {
      caps[slug] = value;
    }
  }
  return caps;
}

/**
 * Set `key` to an arbitrary value on the opaque config blob. Unlike
 * provider settings field updates, does not drop empty-looking values — the
 * caller is responsible for deciding whether an empty array / empty
 * object should be stored explicitly (e.g. `customModels: []` is a
 * meaningful "user cleared their custom list" state distinct from
 * "driver default").
 */
function nextConfigBlobWithValue(
  config: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  base[key] = value;
  return base;
}

/**
 * Custom rows come from current settings so name/descriptor edits show
 * instantly; a bare entry falls back to the live row's driver-default
 * capabilities (the server fills those in on its next probe).
 */
export function deriveProviderModelsForDisplay(input: {
  readonly liveModels: ReadonlyArray<ServerProviderModel> | undefined;
  readonly customModels: ReadonlyArray<CustomModelDefinition>;
}): ReadonlyArray<ServerProviderModel> {
  const liveCustomModelsBySlug = new Map(
    Arr.filterMap(input.liveModels ?? [], (model) =>
      model.isCustom ? Result.succeed([model.slug, model] as const) : Result.failVoid,
    ),
  );
  const serverModels = input.liveModels?.filter((model) => !model.isCustom) ?? [];
  const customModels = input.customModels.map((entry) => ({
    slug: entry.slug,
    name: entry.name,
    isCustom: true,
    capabilities:
      entry.capabilities ?? liveCustomModelsBySlug.get(entry.slug)?.capabilities ?? null,
  }));
  return [...serverModels, ...customModels];
}

function ProviderAuthEmail(props: { readonly email: string | undefined }) {
  const email = props.email?.trim();
  if (!email) return null;

  return (
    <RedactedSensitiveText
      value={email}
      ariaLabel="Toggle account email visibility"
      revealTooltip="Click to reveal email"
      hideTooltip="Click to hide email"
      className="max-w-full truncate"
    />
  );
}

function ProviderEnvironmentSection(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const [rows, setRows] = useState<ReadonlyArray<EnvironmentDraftRow>>(() =>
    props.environment.map(makeEnvironmentDraftRow),
  );
  const previousEnvironmentRef = useRef(props.environment);
  const lastPublishedEnvironmentRef = useRef<
    ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined
  >(undefined);

  useEffect(() => {
    const previousEnvironment = previousEnvironmentRef.current;
    const lastPublishedEnvironment = lastPublishedEnvironmentRef.current;
    previousEnvironmentRef.current = props.environment;
    lastPublishedEnvironmentRef.current = undefined;
    if (
      previousEnvironment === props.environment ||
      providerEnvironmentsEqual(previousEnvironment, props.environment) ||
      (lastPublishedEnvironment !== undefined &&
        providerEnvironmentsEqual(lastPublishedEnvironment, props.environment))
    ) {
      return;
    }
    setRows(props.environment.map(makeEnvironmentDraftRow));
  }, [props.environment]);

  const publishRows = (nextRows: ReadonlyArray<EnvironmentDraftRow>) => {
    const published: ProviderInstanceEnvironmentVariable[] = [];
    for (const row of nextRows) {
      const name = row.name.trim();
      if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
        if (
          name.length > 0 ||
          row.value.length > 0 ||
          row.sensitive !== true ||
          row.valueRedacted !== undefined
        ) {
          return;
        }
        continue;
      }
      const { id: _id, ...rest } = row;
      published.push({ ...rest, name });
    }
    lastPublishedEnvironmentRef.current = published;
    props.onChange(published);
  };

  const updateVariable = (id: string, patch: Partial<Omit<EnvironmentDraftRow, "id">>) => {
    const nextRows = rows.map((row) =>
      row.id === id
        ? {
            ...row,
            ...patch,
            ...(patch.value !== undefined ? { valueRedacted: false } : {}),
          }
        : row,
    );
    setRows(nextRows);
    publishRows(nextRows);
  };

  const removeVariable = (id: string) => {
    const nextRows = rows.filter((row) => row.id !== id);
    setRows(nextRows);
    publishRows(nextRows);
  };

  const addVariable = () =>
    setRows([
      ...rows,
      {
        id: nextEnvironmentVariableDraftId(),
        name: "",
        value: "",
        sensitive: true,
      },
    ]);

  return (
    <SettingsRow
      title="Variables"
      description="API keys, base URLs, and other per-instance CLI settings."
      control={
        <Button type="button" size="sm" variant="outline" onClick={addVariable}>
          <PlusIcon className="size-3" />
          Add variable
        </Button>
      }
    >
      {rows.length > 0 ? (
        <div className="mt-3 min-w-0 space-y-2 pb-2">
          {rows.map((variable, index) => (
            <div key={variable.id} className="flex min-w-0 flex-wrap items-center gap-1.5">
              <DraftInput
                size="sm"
                className="w-full min-w-0 font-mono sm:w-44 sm:shrink-0"
                value={variable.name}
                onCommit={(name) => updateVariable(variable.id, { name: name.trim() })}
                placeholder="VARIABLE_NAME"
                spellCheck={false}
                aria-label={`Environment variable name ${index + 1}`}
              />
              <span className="hidden text-xs text-muted-foreground sm:inline" aria-hidden>
                =
              </span>
              <DraftInput
                size="sm"
                className="min-w-0 flex-1 font-mono"
                value={variable.valueRedacted ? "" : variable.value}
                onCommit={(value) => updateVariable(variable.id, { value })}
                type={variable.sensitive ? "password" : undefined}
                autoComplete="off"
                placeholder={
                  variable.valueRedacted ? "Stored secret, enter a new value to replace" : "value"
                }
                spellCheck={false}
                aria-label={`Environment variable value ${index + 1}`}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-micro"
                      variant="ghost-muted"
                      className={cn(
                        "[--control-icon-color:currentColor]",
                        variable.sensitive && "text-foreground",
                      )}
                      onClick={() => {
                        const sensitive = !variable.sensitive;
                        updateVariable(variable.id, {
                          sensitive,
                          ...(sensitive && variable.valueRedacted === undefined
                            ? {}
                            : { valueRedacted: sensitive ? variable.valueRedacted : false }),
                        });
                      }}
                      aria-pressed={variable.sensitive}
                      aria-label={`Mark environment variable ${variable.name || index + 1} as sensitive`}
                    >
                      {variable.sensitive ? (
                        <LockIcon className="size-3" />
                      ) : (
                        <LockOpenIcon className="size-3" />
                      )}
                    </Button>
                  }
                />
                <TooltipPopup side="top">
                  {variable.sensitive ? "Sensitive, stored separately" : "Plain text"}
                </TooltipPopup>
              </Tooltip>
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-muted"
                className="[--control-icon-color:currentColor] hover:text-destructive"
                onClick={() => removeVariable(variable.id)}
                aria-label={`Remove environment variable ${variable.name || index + 1}`}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Sensitive values are stored separately and never returned to the app.
          </p>
        </div>
      ) : null}
    </SettingsRow>
  );
}

interface ProviderInstanceCardProps {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly driverOption: DriverOption | undefined;
  readonly liveProvider: ServerProvider | undefined;
  readonly mode: "list" | "editor";
  readonly selected?: boolean | undefined;
  readonly onSelect?: (() => void) | undefined;
  readonly readOnly?: boolean | undefined;
  readonly onUpdate: (nextInstance: ProviderInstanceConfig) => void;
  /**
   * Pass `undefined` to hide the delete footer entirely. Built-in default
   * instance slots use `undefined` — they can't be deleted without losing
   * the slot, and their "reset to defaults" affordance lives on an outer
   * reset button instead. Explicit `| undefined` in the type accommodates
   * `exactOptionalPropertyTypes: true`, where an absent key and
   * `{ onDelete: undefined }` are treated as distinct shapes.
   */
  readonly onDelete?: (() => void) | undefined;
  /**
   * Optional outer reset button rendered next to the driver icon. Built-in
   * default slots supply a reset-to-factory control here; custom instances
   * omit it.
   */
  readonly headerAction?: ReactNode | undefined;
  readonly setup?: ReactNode;
  readonly hiddenModels: ReadonlyArray<string>;
  readonly favoriteModels: ReadonlyArray<string>;
  readonly modelOrder: ReadonlyArray<string>;
  readonly onHiddenModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onFavoriteModelsChange: (next: ReadonlyArray<string>) => void;
  readonly onModelOrderChange: (next: ReadonlyArray<string>) => void;
  /** Model + options a new draft on this instance starts from when nothing more specific picks one. */
  readonly defaultModel: string | null;
  readonly defaultOptions: ProviderOptionSelections;
  readonly onDefaultModelChange: (model: string | null) => void;
  readonly onDefaultOptionsChange: (options: ProviderOptionSelections) => void;
  readonly onRunUpdate?: (() => void) | undefined;
  readonly isUpdating?: boolean | undefined;
}

/**
 * Renders one provider instance as either a compact selectable list row or
 * the full editor shown beside that list. Both modes use the same enabled
 * state and provider metadata.
 *
 * Behavior notes:
 *   - `liveProvider` is matched by the caller via `instanceId`; when no
 *     match is available (e.g. the server hasn't probed yet, or the
 *     driver is not shipped by the current build) the card still renders
 *     with a neutral "checking" summary.
 *   - Unknown drivers (`driverOption === undefined`) get a read-only
 *     notice instead of editable fields, so fork instances round-trip
 *     without accidentally destroying their config.
 *   - The enabled Switch writes to the envelope's `instance.enabled`
 *     field, which is the single enabled flag: the server folds any legacy
 *     driver-specific `config.enabled` into the envelope on load and both
 *     sides resolve through `resolveProviderInstanceEnabled` (an explicit
 *     false wins, then envelope, then config, then the driver default).
 */
export function ProviderInstanceCard({
  instanceId,
  instance,
  driverOption,
  liveProvider,
  mode,
  selected = false,
  onSelect,
  readOnly = false,
  onUpdate,
  onDelete,
  headerAction,
  setup,
  hiddenModels,
  favoriteModels,
  modelOrder,
  onHiddenModelsChange,
  onFavoriteModelsChange,
  onModelOrderChange,
  defaultModel,
  defaultOptions,
  onDefaultModelChange,
  onDefaultOptionsChange,
  onRunUpdate,
  isUpdating = false,
}: ProviderInstanceCardProps) {
  const enabled = resolveProviderInstanceEnabled(instance);
  // A locally disabled provider reads "Disabled" with a muted dot even if its
  // last server status is stale. Enabled providers use the server status.
  const statusKey: ProviderStatusKey = enabled
    ? ((liveProvider?.status as ProviderStatusKey | undefined) ?? "warning")
    : "disabled";
  const statusStyle = PROVIDER_STATUS_STYLES[statusKey];
  const summary = enabled
    ? getProviderSummary(liveProvider)
    : { headline: "Disabled", detail: null };
  const authEmail = liveProvider?.auth.email?.trim();
  const isAuthenticated = enabled && liveProvider?.auth.status === "authenticated";
  const authLabel =
    enabled && liveProvider?.auth.status === "authenticated"
      ? (liveProvider.auth.label ?? liveProvider.auth.type ?? null)
      : null;
  const versionLabel = getProviderVersionLabel(liveProvider?.version);
  const versionAdvisory = getProviderVersionAdvisoryPresentation(liveProvider?.versionAdvisory);
  const updateCommand = versionAdvisory?.updateCommand ?? null;
  const FallbackIconComponent = driverOption?.icon;
  const displayName =
    instance.displayName?.trim() || driverOption?.label || String(instance.driver);
  const accentColor = normalizeProviderAccentColor(instance.accentColor);
  const { copyToClipboard } = useCopyToClipboard<{ providerName: string }>({
    onCopy: ({ providerName }) => {
      toastManager.add({
        type: "success",
        title: `${providerName} update command copied`,
        description: "Run it in a terminal when you are ready to update.",
      });
    },
    onError: (error, { providerName }) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not copy ${providerName} update command`,
          description: error.message,
        }),
      );
    },
  });

  // Narrow `instance.driver` for callers that key on the closed
  // `ProviderDriverKind` union (e.g. `normalizeModelSlug`'s alias table). Custom
  // fork drivers pass through as `null` and those callers fall back to
  // verbatim behaviour.
  const driverKind: ProviderDriverKind | null = isProviderDriverKind(instance.driver)
    ? instance.driver
    : null;
  const customModels =
    instance.driver === "antigravity" ? [] : readConfigCustomModels(instance.config);
  // Pi-only per-model turn caps; absent on every other driver.
  const modelConcurrency =
    driverKind === "pi" ? readConfigModelConcurrency(instance.config) : undefined;
  // Server-returned models may lag behind settings writes. Treat probe
  // models as the source for built-ins only; custom rows come directly
  // from the current instance config so add/remove reflects immediately.
  const modelsForDisplay = deriveProviderModelsForDisplay({
    liveModels: liveProvider?.models,
    customModels,
  });
  // Single-instance entry for the "Default model" picker below, built from
  // the live provider snapshot so it carries the same icon/status metadata
  // as the composer's own picker. Absent until the server has probed this
  // instance at least once.
  const defaultModelEntry = liveProvider
    ? deriveProviderInstanceEntries([liveProvider])[0]
    : undefined;
  const resolvedDefaultModel =
    defaultModel && modelsForDisplay.some((model) => model.slug === defaultModel)
      ? defaultModel
      : (modelsForDisplay.find((model) => model.isDefault)?.slug ??
        modelsForDisplay[0]?.slug ??
        null);

  const updateDisplayName = (value: string) => {
    const trimmed = value.trim();
    const { displayName: _omit, ...rest } = instance;
    onUpdate(
      trimmed.length > 0
        ? ({ ...rest, displayName: trimmed } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateEnabled = (value: boolean) => {
    onUpdate({ ...instance, enabled: value });
  };

  const updateAccentColor = (value: string) => {
    const normalized = normalizeProviderAccentColor(value);
    const { accentColor: _omit, ...rest } = instance;
    onUpdate(
      normalized
        ? ({ ...rest, accentColor: normalized } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateConfig = (nextConfig: Record<string, unknown> | undefined) => {
    const { config: _omit, ...rest } = instance;
    onUpdate(
      nextConfig !== undefined
        ? ({ ...rest, config: nextConfig } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const updateCustomModels = (next: ReadonlyArray<CustomModelDefinition>) => {
    const nextConfig = nextConfigBlobWithValue(
      instance.config,
      "customModels",
      next.map(toCustomModelSetting),
    );
    // Removing a custom model removes its row. A cap keyed to a slug that no
    // longer has one (custom gone and not probe-reported) could never be
    // cleared or matched by the adapter — prune it in this same write.
    const builtInSlugs = new Set(
      modelsForDisplay.filter((model) => !model.isCustom).map((model) => model.slug),
    );
    const removedSlugs = customModels
      .filter((entry) => !next.some((candidate) => candidate.slug === entry.slug))
      .map((entry) => entry.slug)
      .filter((slug) => !builtInSlugs.has(slug));
    if (removedSlugs.length > 0) {
      const caps = readConfigModelConcurrency(nextConfig);
      if (removedSlugs.some((slug) => caps[slug] !== undefined)) {
        for (const slug of removedSlugs) delete caps[slug];
        if (Object.keys(caps).length > 0) nextConfig.modelConcurrency = caps;
        else delete nextConfig.modelConcurrency;
      }
    }
    const { config: _omit, ...rest } = instance;
    onUpdate({ ...rest, config: nextConfig } as ProviderInstanceConfig);
  };

  /** Whole-map replacement; an empty map drops the key entirely (unlimited). */
  const updateModelConcurrency = (next: Readonly<Record<string, number>>) => {
    const entries = Object.entries(next);
    const { modelConcurrency: _omit, ...configWithout } =
      instance.config !== null && typeof instance.config === "object"
        ? (instance.config as Record<string, unknown>)
        : {};
    const nextConfig =
      entries.length > 0
        ? nextConfigBlobWithValue(configWithout, "modelConcurrency", Object.fromEntries(entries))
        : configWithout;
    const { config: _drop, ...rest } = instance;
    onUpdate({ ...rest, config: nextConfig } as ProviderInstanceConfig);
  };

  const updateEnvironment = (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => {
    const cleaned = environment.filter((variable) => variable.name.trim().length > 0);
    const { environment: _omit, ...rest } = instance;
    onUpdate(
      cleaned.length > 0
        ? ({ ...rest, environment: cleaned } as ProviderInstanceConfig)
        : (rest as ProviderInstanceConfig),
    );
  };

  const titleIconNode = driverKind ? (
    <ProviderInstanceIcon
      driverKind={driverKind}
      displayName={displayName}
      accentColor={accentColor}
      showBadge={Boolean(accentColor)}
      className="size-5"
      iconClassName="size-4 text-foreground/80"
      badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-[7px]"
    />
  ) : FallbackIconComponent ? (
    <span className="inline-flex size-5 shrink-0 items-center justify-center">
      <FallbackIconComponent className="size-4 text-foreground/80" aria-hidden />
    </span>
  ) : (
    <span
      className="inline-flex size-5 shrink-0 items-center justify-center text-[10px] font-semibold leading-none text-foreground/80"
      aria-hidden
    >
      {providerInstanceInitials(displayName)}
    </span>
  );

  const titleTailNode = headerAction ? (
    <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">{headerAction}</span>
  ) : null;

  const versionCodeNode = versionLabel ? (
    <code className="text-xs text-muted-foreground">{versionLabel}</code>
  ) : null;

  // Healthy and disabled rows read fine from their text; only trouble gets a dot.
  const statusDotNode =
    statusKey === "warning" || statusKey === "error" ? (
      <span className={cn("size-1.5 shrink-0 rounded-full", statusStyle.dot)} aria-hidden />
    ) : null;
  // Trouble states carry the server's explanation (a failed probe, a shadow
  // home entry that is not a symlink, a missing binary). Show it wherever the
  // headline shows so the user can act without opening the editor.
  const needsAttention = statusKey === "warning" || statusKey === "error";
  const editorStatusNode =
    isAuthenticated && authEmail ? (
      <>
        {needsAttention ? statusDotNode : null}
        <span>Authenticated as</span>
        <ProviderAuthEmail email={authEmail} />
        {authLabel ? <span>· {authLabel}</span> : null}
        {summary.detail ? (
          <span className="min-w-0 [overflow-wrap:anywhere]">· {summary.detail}</span>
        ) : null}
      </>
    ) : (
      <>
        {statusDotNode}
        <span>{summary.headline}</span>
        {summary.detail ? (
          <span className="min-w-0 [overflow-wrap:anywhere]">· {summary.detail}</span>
        ) : null}
      </>
    );
  if (mode === "list") {
    return (
      <div
        data-slot="settings-row"
        className={cn(
          "group flex min-h-18 items-center gap-3 px-3 py-3 transition-colors sm:px-4",
          selected ? "bg-muted/45" : "hover:bg-muted/25",
        )}
      >
        <div
          className={cn(
            "pointer-events-none relative flex min-w-0 flex-1 items-start gap-3 rounded-md text-left transition-opacity",
            !enabled && !selected && "opacity-60 group-hover:opacity-100",
          )}
        >
          <button
            type="button"
            className="pointer-events-auto absolute inset-0 cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onSelect}
            aria-label={`Select ${displayName}`}
            aria-pressed={selected}
          />
          {titleIconNode}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium text-foreground">{displayName}</span>
              {String(instanceId) !== String(instance.driver) ? (
                <code className="min-w-0 truncate rounded bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
                  {instanceId}
                </code>
              ) : null}
              {versionLabel ? (
                <code className="max-w-24 shrink-0 truncate text-xs text-muted-foreground">
                  {versionLabel}
                </code>
              ) : null}
              {versionAdvisory ? (
                updateCommand ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          size="icon-micro"
                          variant="ghost-muted"
                          className="pointer-events-auto relative shrink-0"
                          aria-label={`Copy ${displayName} update command`}
                          onClick={() =>
                            copyToClipboard(updateCommand, { providerName: displayName })
                          }
                        >
                          <ArrowUpCircleIcon className="size-3.5" />
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">Copy update command</TooltipPopup>
                  </Tooltip>
                ) : (
                  <span role="img" aria-label="Update available" className="inline-flex shrink-0">
                    <ArrowUpCircleIcon className="size-3.5 text-muted-foreground" />
                  </span>
                )
              ) : null}
            </span>
            <span className="mt-0.5 flex items-start gap-1.5 text-[13px] leading-[1.45] text-muted-foreground/80">
              {statusDotNode ? (
                <span className="flex h-[1.45em] shrink-0 items-center">{statusDotNode}</span>
              ) : null}
              <span className="line-clamp-2 [overflow-wrap:anywhere]">
                {summary.headline}
                {needsAttention && summary.detail ? ` · ${summary.detail}` : null}
              </span>
            </span>
          </span>
        </div>
        <span className="flex h-5 shrink-0 items-center">
          <Switch
            checked={enabled}
            disabled={readOnly}
            onCheckedChange={(checked) => updateEnabled(Boolean(checked))}
            aria-label={`Enable ${displayName}`}
          />
        </span>
      </div>
    );
  }

  const editorHeaderAction = (
    <div className="flex shrink-0 items-center gap-1.5">
      {driverOption?.badgeLabel ? (
        <Badge variant="warning" size="sm" className="shrink-0">
          {driverOption.badgeLabel}
        </Badge>
      ) : null}
      {versionCodeNode}
      <span
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        className={cn("inline-flex items-center gap-1", readOnly && "opacity-50")}
      >
        {versionAdvisory ? (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className={cn(
                    "[--control-icon-color:currentColor]",
                    versionAdvisory.emphasis === "strong"
                      ? "text-warning hover:text-warning"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  aria-label="Update available — view details"
                >
                  <ArrowUpCircleIcon />
                </Button>
              }
            />
            <PopoverPopup
              side="bottom"
              align="end"
              className="w-[min(21rem,calc(100vw-1.5rem))] [--popup-width:min(21rem,calc(100vw-1.5rem))]"
            >
              <div className="grid min-w-0 gap-3">
                <div className="grid gap-0.5">
                  <p className="text-[13px] font-semibold leading-tight text-foreground">
                    Update available
                  </p>
                  <p
                    className={cn(
                      "text-xs leading-snug",
                      versionAdvisory.emphasis === "strong"
                        ? "text-warning"
                        : "text-muted-foreground",
                    )}
                  >
                    {versionAdvisory.detail}
                  </p>
                </div>
                {onRunUpdate ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    className="w-full"
                    disabled={isUpdating}
                    onClick={onRunUpdate}
                  >
                    {isUpdating ? <Spinner /> : <DownloadIcon />}
                    {isUpdating ? "Updating" : "Update now"}
                  </Button>
                ) : null}
                {onRunUpdate && updateCommand ? (
                  <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                    <span aria-hidden className="h-px flex-1 bg-border" />
                    or, update manually using
                    <span aria-hidden className="h-px flex-1 bg-border" />
                  </div>
                ) : null}
                {updateCommand ? (
                  <div className="flex min-w-0 items-center gap-1 rounded-md border border-border/70 bg-muted/40 py-0.5 pr-0.5 pl-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                      {updateCommand}
                    </code>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                            onClick={() =>
                              copyToClipboard(updateCommand, { providerName: displayName })
                            }
                            aria-label="Copy update command"
                          >
                            <CopyIcon className="size-3" />
                          </Button>
                        }
                      />
                      <TooltipPopup side="top">Copy command</TooltipPopup>
                    </Tooltip>
                  </div>
                ) : null}
              </div>
            </PopoverPopup>
          </Popover>
        ) : null}
        {titleTailNode}
        {onDelete ? (
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            disabled={readOnly}
            className="[--control-icon-color:currentColor] hover:text-destructive"
            onClick={onDelete}
            aria-label={`Delete instance ${instanceId}`}
          >
            <Trash2Icon />
          </Button>
        ) : null}
      </span>
    </div>
  );

  return (
    <>
      <SettingsSection title={displayName} icon={titleIconNode} headerAction={editorHeaderAction}>
        <SettingsRow
          title="Display name"
          status={
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5">{editorStatusNode}</div>
          }
          control={
            <div
              inert={readOnly}
              aria-disabled={readOnly || undefined}
              className={cn(
                "flex w-full min-w-0 items-center justify-end gap-2 @min-[32rem]/settings-row:w-auto",
                readOnly && "opacity-50 select-none",
              )}
            >
              <ProviderAccentColorPicker
                layout="inline"
                displayName={displayName}
                value={accentColor}
                onCommit={updateAccentColor}
                commitDelayMs={120}
              />
              <DraftInput
                id={`provider-instance-${instanceId}-display-name`}
                size="sm"
                className="min-w-0 flex-1 @min-[32rem]/settings-row:w-56"
                value={instance.displayName ?? ""}
                onCommit={updateDisplayName}
                placeholder={driverOption?.label ?? "Instance label"}
                spellCheck={false}
              />
            </div>
          }
        />
      </SettingsSection>

      {setup ? <SettingsSection title="Setup">{setup}</SettingsSection> : null}

      <SettingsSection
        title="Runtime"
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        className={readOnly ? "opacity-50 select-none" : undefined}
      >
        {driverOption ? (
          <ProviderSettingsForm
            definition={driverOption}
            value={instance.config}
            idPrefix={`provider-instance-${instanceId}`}
            variant="settings"
            onChange={updateConfig}
          />
        ) : (
          <SettingsRow
            title="Driver"
            description={
              <span>
                This instance uses{" "}
                <code className="text-foreground">{String(instance.driver)}</code>, which is not
                available in this build. Its configuration is preserved.
              </span>
            }
          />
        )}
      </SettingsSection>

      <SettingsSection
        title="Environment"
        inert={readOnly}
        aria-disabled={readOnly || undefined}
        className={readOnly ? "opacity-50 select-none" : undefined}
      >
        <ProviderEnvironmentSection
          environment={instance.environment ?? []}
          onChange={updateEnvironment}
        />
      </SettingsSection>

      {driverOption !== undefined ? (
        <SettingsSection
          title="Models"
          inert={readOnly}
          aria-disabled={readOnly || undefined}
          className={readOnly ? "opacity-50 select-none" : undefined}
        >
          <div className="px-3 py-3 sm:px-4">
            <p className="mb-3 text-xs text-muted-foreground">
              Favorites, visibility, and ordering are saved on this device. Custom models are saved
              on the selected environment.
            </p>
            {driverKind ? (
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium">Default model</div>
                  <div className="text-xs text-muted-foreground">
                    New threads on this provider start here.
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {defaultModel !== null ? (
                    <SettingResetButton
                      label="default model"
                      onClick={() => {
                        onDefaultModelChange(null);
                        onDefaultOptionsChange([]);
                      }}
                    />
                  ) : null}
                  {defaultModelEntry && resolvedDefaultModel ? (
                    <>
                      <ProviderModelPicker
                        activeInstanceId={instanceId}
                        model={resolvedDefaultModel}
                        lockedProvider={driverKind}
                        instanceEntries={[defaultModelEntry]}
                        modelOptionsByInstance={new Map([[instanceId, defaultModelEntry.models]])}
                        triggerVariant="outline"
                        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                        onInstanceModelChange={(_instanceId, model) => onDefaultModelChange(model)}
                      />
                      <TraitsPicker
                        provider={driverKind}
                        models={defaultModelEntry.models}
                        model={resolvedDefaultModel}
                        prompt=""
                        onPromptChange={() => {}}
                        modelOptions={defaultOptions}
                        allowPromptInjectedEffort={false}
                        planModeEnabled={false}
                        triggerVariant="outline"
                        triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                        onModelOptionsChange={(nextOptions) =>
                          onDefaultOptionsChange(nextOptions ?? [])
                        }
                      />
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Waiting for provider status…
                    </span>
                  )}
                </div>
              </div>
            ) : null}
            <ProviderModelsSection
              instanceId={instanceId}
              driverKind={driverKind}
              models={modelsForDisplay}
              customModels={customModels}
              hiddenModels={hiddenModels}
              favoriteModels={favoriteModels}
              modelOrder={modelOrder}
              {...(modelConcurrency !== undefined
                ? { modelConcurrency, onModelConcurrencyChange: updateModelConcurrency }
                : {})}
              onChange={updateCustomModels}
              onHiddenModelsChange={onHiddenModelsChange}
              onFavoriteModelsChange={onFavoriteModelsChange}
              onModelOrderChange={onModelOrderChange}
            />
          </div>
        </SettingsSection>
      ) : null}
    </>
  );
}
