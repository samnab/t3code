import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DEFAULT_SIDEBAR_THREAD_SORT_ORDER, type SidebarThreadSortOrder } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const snoozedShelfExpanded =
    loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const workingShelfEnabled = loaded && preferencesResult.value.workingShelfEnabled === true;
  const workingShelfExpanded =
    loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;

  // A transform reads the optimistic value, so two presses before the next
  // render still toggle twice instead of writing the same value.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true,
      }),
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded: current.threadListWorkingShelfExpanded !== true,
      }),
    });
  };

  return {
    loaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleWorkingShelf,
  } as const;
}

/** The device's active-block sort, shared by the compact Home list and iPad
    sidebar. Defaults like the web setting until the user picks one. */
export function useThreadSortOrder() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const threadSortOrder =
    (AsyncResult.isSuccess(preferencesResult)
      ? preferencesResult.value.threadSortOrder
      : undefined) ?? DEFAULT_SIDEBAR_THREAD_SORT_ORDER;
  const setThreadSortOrder = useCallback(
    (value: SidebarThreadSortOrder) => savePreferences({ threadSortOrder: value }),
    [savePreferences],
  );
  return { threadSortOrder, setThreadSortOrder } as const;
}
