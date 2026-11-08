import { CircleDashedIcon, SlidersHorizontalIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { VoiceLevels } from "@t3tools/client-runtime/realtime-voice";
import { canChooseSpeaker, type AudioDeviceKind } from "../../voice/audioDevices";
import { METER_STEPS, meterStep } from "../../voice/voiceLevels";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Separator } from "../ui/separator";
import { Spinner } from "../ui/spinner";
import { useRealtimeVoice, type VoiceAudioRouting } from "./RealtimeVoiceProvider";

interface DeviceList {
  /** Physical devices with labels; empty until the page holds microphone permission. */
  readonly devices: ReadonlyArray<MediaDeviceInfo>;
  /** What the system default currently resolves to, where the engine says (Chromium). */
  readonly defaultName: string | null;
}

// Chromium lists "default" and, on Windows, "communications" as aliases of a physical device.
const ALIASES = new Set(["default", "communications"]);

function deviceList(all: ReadonlyArray<MediaDeviceInfo>, kind: MediaDeviceKind): DeviceList {
  const labelled = all.filter((device) => device.kind === kind && device.label !== "");
  const systemDefault = labelled.find((device) => device.deviceId === "default");
  return {
    devices: labelled.filter((device) => !ALIASES.has(device.deviceId)),
    defaultName: systemDefault?.label.replace(/^Default - /, "") ?? null,
  };
}

/**
 * Lists audio devices without ever asking for permission: labels exist only once the call holds
 * the microphone. Re-reads on `devicechange` and when the call's mode changes (a grant adds labels).
 */
function useAudioDeviceLists(mode: string) {
  const [all, setAll] = useState<ReadonlyArray<MediaDeviceInfo>>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the browser's device list, which changes outside React
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (mode === "off" || media?.enumerateDevices === undefined) return;
    let current = true;
    const refresh = () =>
      void media.enumerateDevices().then(
        (devices) => current && setAll(devices),
        () => {},
      );
    refresh();
    media.addEventListener("devicechange", refresh);
    return () => {
      current = false;
      media.removeEventListener("devicechange", refresh);
    };
  }, [mode]);
  return { inputs: deviceList(all, "audioinput"), outputs: deviceList(all, "audiooutput") };
}

// A saved device the engine lists no more. Unknown (no labels yet) is not disconnected.
const isDisconnected = (chosen: string, list: DeviceList) =>
  chosen !== "" &&
  list.devices.length > 0 &&
  !list.devices.some((device) => device.deviceId === chosen);

/**
 * The call's microphone and speaker as one "Audio" button and panel. Mount it beside the voice
 * actions; it renders nothing without a call or while one ends. A choice applies at once.
 */
export function VoiceAudioDevices({ labels }: { readonly labels: string }) {
  const voice = useRealtimeVoice();
  const { snapshot, audio } = voice;
  const { inputs, outputs } = useAudioDeviceLists(snapshot.mode);
  const radios = useRef<HTMLDivElement>(null);
  if (snapshot.mode === "off" || snapshot.mode === "ending") return null;
  const speakerSelectable = canChooseSpeaker() && outputs.devices.length > 0;
  const warning = isDisconnected(audio.microphone, inputs)
    ? "microphone disconnected"
    : speakerSelectable && isDisconnected(audio.speaker, outputs)
      ? "speaker disconnected"
      : audio.failed === null
        ? null
        : `${audio.failed.kind} switch failed`;
  return (
    <Popover>
      <PopoverTrigger
        render={<Button size="sm" variant="ghost" />}
        aria-label={warning === null ? "Audio devices" : `Audio devices, ${warning}`}
      >
        <SlidersHorizontalIcon aria-hidden="true" />
        <span className={labels}>Audio</span>
        {warning !== null && (
          <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
        )}
      </PopoverTrigger>
      {/* Focus lands on the checked microphone; Escape returns it to the button. */}
      <PopoverPopup
        side="top"
        align="end"
        width="md"
        padding="compact"
        touchBackdrop
        initialFocus={() =>
          radios.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]') ?? true
        }
      >
        <div ref={radios} className="flex flex-col gap-2" role="group" aria-label="Audio devices">
          <DeviceSection
            kind="microphone"
            title="Microphone"
            list={inputs}
            audio={audio}
            levels={voice.levels}
            choose={voice.chooseAudioDevice}
            empty={<Note>Start a call to choose devices.</Note>}
          />
          <Separator />
          {speakerSelectable ? (
            <DeviceSection
              kind="speaker"
              title="Speaker"
              list={outputs}
              audio={audio}
              levels={null}
              choose={voice.chooseAudioDevice}
              empty={null}
            />
          ) : (
            <div className="flex flex-col gap-0.5 px-1">
              <p className="font-medium text-sm">Speaker</p>
              <p className="text-sm">Uses system output</p>
              <Note>
                {window.desktopBridge
                  ? "Change it in System Settings."
                  : "This browser can’t choose a speaker. Change it in your computer’s sound settings."}
              </Note>
            </div>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function Note({ children }: { readonly children: string }) {
  return <p className="px-1 text-muted-foreground text-xs">{children}</p>;
}

function DeviceSection({
  kind,
  title,
  list,
  audio,
  levels,
  choose,
  empty,
}: {
  readonly kind: AudioDeviceKind;
  readonly title: string;
  readonly list: DeviceList;
  readonly audio: VoiceAudioRouting;
  /** Meters the device in use only: opening every microphone to meter it would capture them all. */
  readonly levels: (() => VoiceLevels) | null;
  readonly choose: (kind: AudioDeviceKind, deviceId: string) => void;
  readonly empty: React.ReactNode;
}) {
  const heading = useId();
  const chosen = audio[kind];
  const disconnected = isDisconnected(chosen, list);
  // A missing saved device plays or captures on the system default.
  const inUse = disconnected ? "" : chosen;
  const failed = audio.failed?.kind === kind ? audio.failed.deviceId : null;
  const nameOf = (deviceId: string) =>
    deviceId === ""
      ? "System default"
      : (list.devices.find((device) => device.deviceId === deviceId)?.label ?? "that device");
  const trailing = (deviceId: string) => {
    if (kind === "microphone" && audio.switching === deviceId)
      return (
        <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
          <Spinner size="xs" aria-hidden="true" />
          Switching…
        </span>
      );
    if (deviceId !== inUse) return null;
    if (levels !== null && audio.switching === null) return <MicLevel levels={levels} />;
    return disconnected ? (
      <span className="shrink-0 text-muted-foreground text-xs">now</span>
    ) : null;
  };
  return (
    <section className="flex flex-col gap-1" aria-labelledby={heading}>
      <h3 id={heading} className="px-1 font-medium text-sm">
        {title}
      </h3>
      {list.devices.length === 0 ? (
        empty
      ) : (
        <>
          {disconnected && (
            <p className="flex items-center gap-2.5 rounded-md bg-warning-surface px-2 py-1.5 text-sm text-warning-foreground">
              <CircleDashedIcon className="size-4 shrink-0" aria-hidden="true" />
              Chosen {kind} disconnected · using system default
            </p>
          )}
          <RadioGroup
            aria-labelledby={heading}
            value={inUse}
            onValueChange={(value) => {
              if (typeof value === "string" && value !== chosen) choose(kind, value);
            }}
            spacing="compact"
          >
            <DeviceRow value="" name="System default" detail={list.defaultName}>
              {trailing("")}
            </DeviceRow>
            {list.devices.map((device) => (
              <DeviceRow
                key={device.deviceId}
                value={device.deviceId}
                name={device.label}
                detail={null}
              >
                {trailing(device.deviceId)}
              </DeviceRow>
            ))}
          </RadioGroup>
          {failed !== null && (
            <p className="px-1 text-warning-foreground text-xs" role="status">
              Couldn’t switch to {nameOf(failed)}. Still using {nameOf(chosen)}.
            </p>
          )}
        </>
      )}
    </section>
  );
}

// Long names clamp to one line and open in full on hover or keyboard focus.
function DeviceRow({
  value,
  name,
  detail,
  children,
}: {
  readonly value: string;
  readonly name: string;
  readonly detail: string | null;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="group/row flex cursor-default items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent has-data-checked:bg-accent/60">
      <Radio value={value} />
      <span className="line-clamp-1 min-w-0 flex-1 break-words group-hover/row:line-clamp-none group-has-focus-visible/row:line-clamp-none">
        {name}
        {detail !== null && <span className="text-muted-foreground"> ({detail})</span>}
      </span>
      {children}
    </label>
  );
}

const LEVEL_INTERVAL_MS = 67;

/**
 * The level of the audio the call sends from the microphone in use, so it reads zero while muted
 * or paused. Polled only while the panel is open, writing a CSS variable only when a step changes.
 */
function MicLevel({ levels }: { readonly levels: () => VoiceLevels }) {
  const bar = useRef<HTMLSpanElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls transport levels on a timer into this DOM node's style while mounted
  useEffect(() => {
    const node = bar.current;
    if (node === null) return;
    let step = -1;
    const timer = window.setInterval(() => {
      const next = meterStep(levels().input);
      if (next === step) return;
      step = next;
      node.style.setProperty("--mic-level", String(next / METER_STEPS));
    }, LEVEL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [levels]);
  return (
    <span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-muted" aria-hidden="true">
      <span
        ref={bar}
        className="block h-full origin-left rounded-full bg-primary [--mic-level:0]"
        style={{ scale: "var(--mic-level) 1" }}
      />
    </span>
  );
}
