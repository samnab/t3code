import {
  LegacyClientSettings,
  type LegacyClientSettings as LegacyClientSettingsType,
} from "@t3tools/contracts";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

// Reads through LegacyClientSettings so the retired device-local
// providerModelPreferences survives decoding for the one-time migration to
// server settings. Writes keep it while pending; the caller omits it once
// migrated.
export function readBrowserClientSettings(): LegacyClientSettingsType | null {
  if (!hasWindow()) {
    return null;
  }

  return getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, LegacyClientSettings);
}

export function writeBrowserClientSettings(settings: LegacyClientSettingsType): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, LegacyClientSettings);
}
