import { createNavigationContainerRef } from "@react-navigation/native";
import type { VoiceOwner } from "@t3tools/client-runtime/realtime-voice";

import { startOpeningDetail } from "../workspace/useSelectWorkspaceDetail";
import {
  selectWorkspaceDetail,
  type WorkspaceDetail,
} from "../workspace/workspace-detail-selection";

/** Root navigation for app-level owners that live outside any screen, such as realtime voice. */
export const navigationRef = createNavigationContainerRef<ReactNavigation.RootParamList>();

export function returnToVoiceOwner(owner: VoiceOwner): void {
  if (!navigationRef.isReady()) return;
  const detail: WorkspaceDetail = {
    name: "Thread",
    params: { environmentId: owner.environmentId, threadId: owner.threadId },
  };
  startOpeningDetail(detail);
  navigationRef.dispatch(selectWorkspaceDetail(detail));
}
