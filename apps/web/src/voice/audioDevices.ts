/**
 * Device-local microphone and speaker choices for voice, keyed by `MediaDeviceInfo.deviceId`.
 * "" is the system default. Ids are per-origin, so a choice never follows the user elsewhere.
 */
export type AudioDeviceKind = "microphone" | "speaker";

const STORAGE_KEYS: Record<AudioDeviceKind, string> = {
  microphone: "t3code:voice-microphone",
  speaker: "t3code:voice-speaker",
};

export function readAudioDevice(kind: AudioDeviceKind): string {
  try {
    return window.localStorage.getItem(STORAGE_KEYS[kind]) ?? "";
  } catch {
    return "";
  }
}

function writeAudioDevice(kind: AudioDeviceKind, deviceId: string) {
  try {
    if (deviceId === "") window.localStorage.removeItem(STORAGE_KEYS[kind]);
    else window.localStorage.setItem(STORAGE_KEYS[kind], deviceId);
  } catch {}
}

/** The chosen devices as shown. `switching`: the microphone a live call is moving to. `failed`:
 * the last choice that could not be applied; the device shown is then the one still in use. */
export interface AudioDeviceChoices {
  readonly microphone: string;
  readonly speaker: string;
  readonly switching: string | null;
  readonly failed: { readonly kind: AudioDeviceKind; readonly deviceId: string } | null;
}

/**
 * Saves and applies a choice at once. Each kind tracks its own latest request and the last device
 * actually applied: only the latest request settles, and a failure restores the last applied device
 * in storage and on screen, never an earlier choice still in flight.
 */
export function createAudioDeviceChooser(
  apply: (kind: AudioDeviceKind, deviceId: string) => Promise<unknown>,
  update: (change: (current: AudioDeviceChoices) => AudioDeviceChoices) => void,
) {
  const latest: Record<AudioDeviceKind, number> = { microphone: 0, speaker: 0 };
  const applied: Record<AudioDeviceKind, string> = {
    microphone: readAudioDevice("microphone"),
    speaker: readAudioDevice("speaker"),
  };
  const switching = (kind: AudioDeviceKind, current: AudioDeviceChoices, next: string | null) =>
    kind === "microphone" ? next : current.switching;
  return async (kind: AudioDeviceKind, deviceId: string) => {
    const request = ++latest[kind];
    writeAudioDevice(kind, deviceId);
    update((current) => ({
      ...current,
      [kind]: deviceId,
      switching: switching(kind, current, deviceId),
      failed: null,
    }));
    try {
      await apply(kind, deviceId);
    } catch {
      if (request !== latest[kind]) return;
      const restored = applied[kind];
      writeAudioDevice(kind, restored);
      update((current) => ({
        ...current,
        [kind]: restored,
        switching: switching(kind, current, null),
        failed: { kind, deviceId },
      }));
      return;
    }
    if (request !== latest[kind]) return;
    applied[kind] = deviceId;
    update((current) => ({ ...current, switching: switching(kind, current, null) }));
  };
}

export const microphoneConstraints = (deviceId: string): MediaStreamConstraints =>
  deviceId === "" ? { audio: true } : { audio: { deviceId: { exact: deviceId } } };

/**
 * Starts capture on the chosen microphone. A saved device that is gone falls back to the system
 * default (the device panel shows it disconnected); a missing default still rejects.
 */
export async function captureMicrophone(deviceId: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(microphoneConstraints(deviceId));
  } catch (error) {
    const missing =
      error instanceof Error &&
      (error.name === "OverconstrainedError" || error.name === "NotFoundError");
    if (deviceId === "" || !missing) throw error;
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
}

/** Whether this engine can route an element to a chosen output (Chromium, Electron). */
export const canChooseSpeaker = () =>
  typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

const VOLUME_KEY = "t3code:voice-volume";
/** The agent's voice level, 0–100. Anything but a finite number reads as the default, 100. */
export function clampVoiceVolume(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function readVoiceVolume(): number {
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    return raw === null ? 100 : clampVoiceVolume(JSON.parse(raw));
  } catch {
    return 100;
  }
}

export function writeVoiceVolume(volume: number) {
  try {
    window.localStorage.setItem(VOLUME_KEY, JSON.stringify(clampVoiceVolume(volume)));
  } catch {}
}

let volumeSettable: boolean | undefined;
/** False where element volume is read-only (iOS reads 1 and ignores writes): use device buttons.
 * Probed once per page with a detached element. */
export function canSetVoiceVolume() {
  if (volumeSettable === undefined) {
    const probe = document.createElement("audio");
    probe.volume = 0.5;
    volumeSettable = probe.volume === 0.5;
  }
  return volumeSettable;
}
