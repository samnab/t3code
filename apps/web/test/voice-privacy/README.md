# Voice privacy egress harness

Proves the manual Pause / Resume / Mic off boundary against the shipped `privacyController`, `browserVoiceTransport` and `RealtimeVoiceProvider`, in real Chromium and in the repo's Electron, with no microphone, T3 server or provider.

```sh
node apps/web/test/voice-privacy/run.ts            # Chromium, then Electron
node apps/web/test/voice-privacy/run.ts --chromium-only
node apps/web/test/voice-privacy/run.ts --electron-only
```

It builds `harness.tsx` with `vite.config.ts` into `/tmp/t3-voice-privacy-egress/dist`, serves it on `127.0.0.1`, and writes `results.json` there. It exits non-zero on any failed case. One-time setup, if a browser is missing: Playwright's `chromium-headless-shell` for the repo's Playwright version, and `node install.js` inside `apps/desktop/node_modules/electron`.

## How it works

- `getUserMedia` is replaced by a clone of a synthetic `OscillatorNode` track. Both browsers also run with `--use-fake-device-for-media-stream`. The probe only calls the real `getUserMedia` when every input is labelled `Fake…`.
- Markers: A is 700 Hz (public, before pause). B is 40 ms chirps at 1900/2300 Hz keyed by a random nonce. C is 3300 Hz (public, after Resume). B plays whenever the controller is not `transmitting`.
- `startProvider` / `stopProvider` answer from a local `RTCPeerConnection`. Every received stream and every sender track after the gate is recorded through Web Audio and scanned in 1024-sample windows with Goertzel filters. A window counts as a marker when the marker bins hold at least 20% of its energy and the window is at least -60 dBFS. A "trace" also counts windows down to -100 dBFS.
- The vite config swaps out the app modules that need a live host (atoms, RPC, owner lookup, toasts) for `stubs.ts`. The provider, controller, transport and shortcut resolution run as shipped.
- Fetch, XHR, WebSocket, beacon, data-channel sends, console output, toasts and provider start/stop payloads are captured. The runner checks that none of them contains the B nonce and that no request leaves the harness origin.
- `electron-main.cjs` loads the same page in Electron under the shipped desktop CSP, and sends the trusted chord with `sendInputEvent`.

Case 1b is a measurement, not a pass/fail gate. B keeps playing during the resume negotiation, so it shows how much audio captured after the Resume action but before `transmitting` reaches the new call.
