import { RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";

import { subscribeComposerDraftModelReconciliation } from "./composerDraftStore";
import { environmentThreadShells } from "./state/threads";
import { environmentShell } from "./state/shell";

import { BrowserProfileReporter } from "./browser/BrowserProfileReporter";
import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { appAtomRegistry, AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { RealtimeVoiceProvider } from "./components/voice/RealtimeVoiceProvider";
import { GlobalRealtimeVoiceControl } from "./components/voice/GlobalRealtimeVoiceControl";
import { buildThreadRouteParams } from "./threadRoutes";

/**
 * Browser webviews and voice media outlive routed views and share their atom registry.
 */
export function AppRoot({ router }: { readonly router: AppRouter }) {
  useEffect(
    () =>
      subscribeComposerDraftModelReconciliation({
        registry: appAtomRegistry,
        threadShellAtom: environmentThreadShells.threadShellAtom,
        threadRefsAtom: environmentThreadShells.threadRefsAtom,
        shellStateAtom: environmentShell.stateAtom,
      }),
    [],
  );
  return (
    <AppAtomRegistryProvider>
      <RealtimeVoiceProvider
        returnToOwner={(owner) => {
          void router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(owner),
          });
        }}
      >
        <RouterProvider router={router} />
        <ElectronBrowserHost />
        <BrowserProfileReporter />
        <QuitHoldOverlay />
        <GlobalRealtimeVoiceControl />
      </RealtimeVoiceProvider>
    </AppAtomRegistryProvider>
  );
}
