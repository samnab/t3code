import { RouterProvider } from "@tanstack/react-router";

import { ElectronBrowserHost } from "./browser/ElectronBrowserHost";
import { QuitHoldOverlay } from "./components/QuitHoldOverlay";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { RealtimeVoiceProvider } from "./components/voice/RealtimeVoiceProvider";
import { GlobalRealtimeVoiceControl } from "./components/voice/GlobalRealtimeVoiceControl";
import { buildThreadRouteParams } from "./threadRoutes";

// Keep webviews and voice media outside the router but inside its atom registry so route changes preserve them.
export function AppRoot({ router }: { readonly router: AppRouter }) {
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
        <QuitHoldOverlay />
        <GlobalRealtimeVoiceControl />
      </RealtimeVoiceProvider>
    </AppAtomRegistryProvider>
  );
}
