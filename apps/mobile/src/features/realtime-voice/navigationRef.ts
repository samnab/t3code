import { createNavigationContainerRef } from "@react-navigation/native";
import type { VoiceOwner } from "@t3tools/client-runtime/realtime-voice";

import { createHomeThreadRouteAction } from "../home/home-thread-navigation";

/** Root navigation for app-level owners that live outside any screen, such as realtime voice. */
export const navigationRef = createNavigationContainerRef<ReactNavigation.RootParamList>();

export function returnToVoiceOwner(owner: VoiceOwner): void {
  const state = navigationRef.isReady() ? navigationRef.getRootState() : undefined;
  if (!state) return;
  navigationRef.dispatch(
    createHomeThreadRouteAction({
      state,
      dismissingRouteKey: null,
      params: { environmentId: owner.environmentId, threadId: owner.threadId },
    }),
  );
}
