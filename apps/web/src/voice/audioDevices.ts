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

export function writeAudioDevice(kind: AudioDeviceKind, deviceId: string) {
  try {
    if (deviceId === "") window.localStorage.removeItem(STORAGE_KEYS[kind]);
    else window.localStorage.setItem(STORAGE_KEYS[kind], deviceId);
  } catch {}
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
