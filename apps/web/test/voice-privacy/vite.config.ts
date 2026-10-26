// @effect-diagnostics nodeBuiltinImport:off - Vite config resolves paths before any Effect runtime exists.
import * as NodePath from "node:path";
import react from "@vitejs/plugin-react";
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
  ].map((file) => NodePath.join(webSrc, file)),
);
const provider = NodePath.join(webSrc, "components/voice/RealtimeVoiceProvider.tsx");

function stubAppState(): Plugin {
  return {
    name: "voice-privacy-stubs",
    enforce: "pre",
    async resolveId(source, importer) {
      if (source === "@effect/atom-react" && importer === provider) return stubs;
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
  plugins: [stubAppState(), react()],
  resolve: { tsconfigPaths: true, dedupe: ["react", "react-dom"] },
  build: {
    outDir: process.env.VOICE_PRIVACY_OUT ?? "/tmp/t3-voice-privacy-egress/dist",
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
  },
});
