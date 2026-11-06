// @effect-diagnostics nodeBuiltinImport:off - Vite config resolves paths before any Effect runtime exists.
import * as NodePath from "node:path";
import react from "@vitejs/plugin-react";
import { tailwindPlugins } from "../../vite/tailwind";
import { defineConfig, type Plugin } from "vite-plus";

const here = import.meta.dirname;
const webSrc = NodePath.resolve(here, "../../src");
const stubs = NodePath.resolve(here, "stubs.ts");
// App modules that need a live T3 host. Everything else, including the provider, controller,
// transport and shortcut resolution, is the shipped source.
const stubbed = new Set(
  [
    "state/use-orchestration-command.ts",
    "state/threads.ts",
    "state/server.ts",
    "voice/voiceOwnerLifecycle.ts",
    "components/ui/toast.tsx",
    "components/ui/toastHelpers.ts",
    "lib/utils.ts",
    "hooks/useThreadRouteTarget.ts",
  ].map((file) => NodePath.join(webSrc, file)),
);
// Importers whose atom reads (keybindings) the stubs answer.
const atomReaders = new Set(
  [
    "components/voice/RealtimeVoiceProvider.tsx",
    "components/voice/GlobalRealtimeVoiceControl.tsx",
  ].map((file) => NodePath.join(webSrc, file)),
);

function stubAppState(): Plugin {
  return {
    name: "voice-privacy-stubs",
    enforce: "pre",
    async resolveId(source, importer) {
      if (source === "@effect/atom-react" && importer !== undefined && atomReaders.has(importer))
        return stubs;
      if (importer === undefined || importer === stubs) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      return resolved && stubbed.has(resolved.id) ? stubs : null;
    },
  };
}

export default defineConfig({
  root: here,
  base: "./",
  // The shipped keyword detector assets (voice/kws) live in the web public dir.
  publicDir: NodePath.resolve(here, "../../public"),
  // ui.html renders the voice controls with the app's styles; index.html loads no CSS.
  plugins: [stubAppState(), react(), tailwindPlugins(false)],
  resolve: { tsconfigPaths: true, dedupe: ["react", "react-dom"] },
  build: {
    outDir: process.env.VOICE_PRIVACY_OUT ?? "/tmp/t3-voice-privacy-egress/dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    rollupOptions: {
      input: { index: NodePath.join(here, "index.html"), ui: NodePath.join(here, "ui.html") },
    },
  },
});
