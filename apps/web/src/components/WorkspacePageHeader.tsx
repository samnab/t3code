import type { ComponentPropsWithoutRef } from "react";

import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { GlobalRealtimeVoiceControl } from "./voice/GlobalRealtimeVoiceControl";
import { useRealtimeVoiceActive } from "./voice/RealtimeVoiceProvider";

export function WorkspacePageHeader({
  electron = false,
  reserveNativeControls = electron,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  readonly electron?: boolean;
  readonly reserveNativeControls?: boolean;
}) {
  return (
    <header
      className={cn(
        "@container flex h-[var(--workspace-topbar-height)]! min-h-[var(--workspace-topbar-height)]! max-h-[var(--workspace-topbar-height)]! shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left,padding-right] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out",
        electron && "drag-region",
        reserveNativeControls && "wco:pr-(--workspace-native-controls-inset)",
        COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        className,
      )}
      {...props}
    />
  );
}

/**
 * The top bar of a page with no header content of its own: the desktop window's drag strip, and on
 * every client the live voice control while a call runs.
 */
export function WorkspacePageTitlebar() {
  const voiceActive = useRealtimeVoiceActive();
  if (!isElectron && !voiceActive) return null;
  return (
    <WorkspacePageHeader electron={isElectron}>
      <GlobalRealtimeVoiceControl className="ms-auto" />
    </WorkspacePageHeader>
  );
}
