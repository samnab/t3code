import type { EnvironmentId, OptimizerId, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { GaugeIcon, Settings2Icon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

interface ChatOptimizersMenuProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly sessionOptimizers: ReadonlyArray<string>;
  readonly onManage: () => void;
}

// Labels mirror Settings → Optimizers; kept local so the chat bundle does not
// pull in the settings page.
const CHAT_OPTIMIZERS: ReadonlyArray<{ readonly id: OptimizerId; readonly label: string }> = [
  { id: "rtk", label: "RTK" },
  { id: "headroom", label: "Headroom" },
  { id: "cbm", label: "Codebase Memory" },
];

// Header control for the active project's optimizer attachments. Writes the
// same server settings patch as Settings → Optimizers, so both stay one source
// of truth. Attachments take effect when the next provider session starts;
// the running session is not modified.
export function ChatOptimizersMenu({
  environmentId,
  projectId,
  sessionOptimizers,
  onManage,
}: ChatOptimizersMenuProps) {
  const overrides = useEnvironmentSettings(environmentId, (settings) =>
    projectId === null ? undefined : settings.projectOptimizerOverrides[projectId],
  );
  const environmentConnected =
    useEnvironments().environments.find((candidate) => candidate.environmentId === environmentId)
      ?.connection.phase === "connected";
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "optimizer setting",
    reportFailure: true,
  });
  const canUpdateSettings = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId),
  );
  const [saving, setSaving] = useState(false);
  const disabled = saving || !environmentConnected || projectId === null || !canUpdateSettings;

  const setOptimizer = (id: OptimizerId, enabled: boolean) => {
    if (projectId === null || saving || !environmentConnected || !canUpdateSettings) return;
    setSaving(true);
    void updateSettings({
      environmentId,
      input: { patch: { projectOptimizerOverrides: { [projectId]: { [id]: enabled } } } },
    }).finally(() => setSaving(false));
  };

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label="Optimizers"
                  className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                />
              }
            />
          }
        >
          <GaugeIcon className="size-4" />
          {sessionOptimizers.length > 0 ? (
            <span
              aria-hidden
              className="absolute right-0.5 bottom-0.5 size-1.5 rounded-full bg-success ring-2 ring-background"
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {sessionOptimizers.length > 0
            ? `Optimizers active this session: ${sessionOptimizers.join(", ")}`
            : "Optimizers"}
        </TooltipPopup>
      </Tooltip>
      <PopoverPopup side="bottom" align="end" width="sm" padding="compact">
        <div className="flex flex-col gap-0.5">
          <PopoverTitle>Optimizers</PopoverTitle>
          {CHAT_OPTIMIZERS.map(({ id, label }) => (
            <label
              key={id}
              className="-mx-1 flex cursor-pointer items-center justify-between gap-2 rounded-md px-1 py-1 text-sm transition-colors hover:bg-accent"
            >
              <span>{label}</span>
              <Switch
                size="sm"
                checked={overrides?.[id] === true}
                disabled={disabled}
                aria-label={`Enable ${label}`}
                onCheckedChange={(enabled) => setOptimizer(id, enabled)}
              />
            </label>
          ))}
          <p className="pt-1 text-xs text-muted-foreground">
            {projectId === null
              ? "Open a project thread to attach optimizers."
              : environmentConnected
                ? canUpdateSettings
                  ? "Applies to the next session."
                  : "You do not have permission to change optimizers."
                : "Reconnect the environment to change optimizers."}
          </p>
        </div>
        <div className="mt-1 border-t border-border/60 pt-1">
          <button
            type="button"
            onClick={onManage}
            className={cn(
              "-mx-1 flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-sm text-muted-foreground",
              "transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            )}
          >
            <Settings2Icon className="size-3.5 shrink-0" />
            Manage optimizers
          </button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
