/**
 * Stand-ins for the app modules RealtimeVoiceProvider reads through atoms and RPC. The harness
 * Vite config redirects those imports here, so the real provider, controller and transport run
 * against the harness's local receiver instead of a T3 host.
 */
import { createContext, useContext } from "react";
import * as Cause from "effect/Cause";
import * as Hex from "effect/encoding/Hex";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { DEFAULT_RESOLVED_KEYBINDINGS, isMacPlatform } from "@t3tools/shared/keybindings";
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";
import type { VoiceOperationOwner, VoiceOwner } from "@t3tools/client-runtime/realtime-voice";
import type { ProviderRealtimeVoiceStartResult, ScopedThreadRef } from "@t3tools/contracts";
import { harnessOwner } from "./owner";

interface StartCall {
  readonly environmentId: string;
  readonly input: { readonly operationId: string; readonly sdp: string };
}

/** Set by the harness before the provider mounts. */
export const providerHooks = {
  start: async (
    _owner: VoiceOperationOwner,
    _sdp: string,
  ): Promise<ProviderRealtimeVoiceStartResult> => {
    throw new Error("harness start hook missing");
  },
  stop: async (): Promise<void> => {},
  toasts: [] as Array<unknown>,
};

export const threadEnvironment = {
  startRealtimeVoice: "start",
  stopRealtimeVoice: "stop",
} as const;
export const primaryServerKeybindingsAtom = "keybindings";
export const useAtomValue = () => DEFAULT_RESOLVED_KEYBINDINGS;

async function settle<A>(run: () => Promise<A>) {
  try {
    return AsyncResult.success(await run());
  } catch (error) {
    return AsyncResult.failure(Cause.fail(error));
  }
}

export function useOrchestrationCommand(command: "start" | "stop") {
  return (value: StartCall) =>
    command === "start"
      ? settle(() =>
          providerHooks.start(
            { ...harnessOwner(), operationId: value.input.operationId },
            value.input.sdp,
          ),
        )
      : settle(() => providerHooks.stop());
}

export const readVoiceOwner = (): VoiceOwner => harnessOwner();
export const validateVoiceOwner = () => {};
export const watchVoiceOwner = () => () => {};
export const randomUUID = () => `op-${Hex.encode(crypto.getRandomValues(new Uint8Array(16)))}`;
export const stackedThreadToast = (options: unknown) => options;
export const toastManager = {
  add: (toast: unknown) => {
    providerHooks.toasts.push(toast);
  },
};
export { isMacPlatform };
export const isWindowsPlatform = (platform: string) => /^win(dows)?/i.test(platform);
export const cn = (...inputs: CxOptions) => twMerge(cx(inputs));

/** The thread on screen for ui.tsx. */
export const RouteContext = createContext<ScopedThreadRef | null>(null);
export const useThreadRouteRef = () => useContext(RouteContext);
