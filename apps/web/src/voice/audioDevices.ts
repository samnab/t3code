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

/** `microphone`/`speaker`: the saved choices. `inUse`: what the live call actually uses, as its
 * transport reports it (null without a call). `switching`: the microphone a choice is moving to.
 * `failed`: the latest choice the call could not apply. */
export interface AudioDeviceChoices {
  readonly microphone: string;
  readonly speaker: string;
  readonly inUse: Readonly<Record<AudioDeviceKind, string | null>>;
  readonly switching: string | null;
  readonly failed: { readonly kind: AudioDeviceKind; readonly deviceId: string } | null;
}

/**
 * Saves and applies a choice at once. The device in use comes only from `adopted`, which the
 * transport calls whenever its device changes. A superseded choice writes nothing; when the latest
 * choice fails, storage and the choice fall back to the device in use, beside the failure.
 */
export function createAudioDeviceChooser(
  apply: (kind: AudioDeviceKind, deviceId: string) => Promise<unknown>,
  update: (change: (current: AudioDeviceChoices) => AudioDeviceChoices) => void,
) {
  const latest: Record<AudioDeviceKind, number> = { microphone: 0, speaker: 0 };
  const inUse: Record<AudioDeviceKind, string | null> = { microphone: null, speaker: null };
  return {
    adopted(kind: AudioDeviceKind, deviceId: string | null) {
      inUse[kind] = deviceId;
      update((current) => ({ ...current, inUse: { ...current.inUse, [kind]: deviceId } }));
    },
    async choose(kind: AudioDeviceKind, deviceId: string) {
      const request = ++latest[kind];
      const settled = (current: AudioDeviceChoices, switching: string | null) =>
        kind === "microphone" ? switching : current.switching;
      writeAudioDevice(kind, deviceId);
      update((current) => ({
        ...current,
        [kind]: deviceId,
        switching: settled(current, deviceId),
        failed: null,
      }));
      let failed = false;
      try {
        await apply(kind, deviceId);
      } catch {
        failed = true;
      }
      if (request !== latest[kind]) return;
      const used = inUse[kind];
      if (!failed || used === null) {
        update((current) => ({ ...current, switching: settled(current, null) }));
        return;
      }
      writeAudioDevice(kind, used);
      update((current) => ({
        ...current,
        [kind]: used,
        switching: settled(current, null),
        failed: { kind, deviceId },
      }));
    },
  };
}

export const microphoneConstraints = (deviceId: string): MediaStreamConstraints =>
  deviceId === "" ? { audio: true } : { audio: { deviceId: { exact: deviceId } } };

/**
 * Starts capture on the chosen microphone and says which one it got. A saved device that is gone
 * falls back to the system default ("", shown disconnected); a missing default still rejects, and
 * so does a capture no longer `current` (closed or superseded), which must not ask for another mic.
 */
export async function captureMicrophone(
  deviceId: string,
  current: () => boolean,
): Promise<{ readonly stream: MediaStream; readonly deviceId: string }> {
  try {
    return {
      stream: await navigator.mediaDevices.getUserMedia(microphoneConstraints(deviceId)),
      deviceId,
    };
  } catch (error) {
    const missing =
      error instanceof Error &&
      (error.name === "OverconstrainedError" || error.name === "NotFoundError");
    if (deviceId === "" || !missing || !current()) throw error;
    return { stream: await navigator.mediaDevices.getUserMedia({ audio: true }), deviceId: "" };
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
