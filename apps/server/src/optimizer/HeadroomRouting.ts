import * as NodeOS from "node:os";

import {
  ClaudeSettings,
  CodexSettings,
  DEFAULT_HEADROOM_PROXY_URL,
  normalizeHeadroomProxyUrl,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../pathExpansion.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeClaudeRoutingSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      env: Schema.optionalKey(
        Schema.Struct({
          ANTHROPIC_BASE_URL: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
);

type HeadroomRoutableProvider = "claudeAgent" | "codex";

interface ProviderRoutingConfig {
  readonly config: unknown;
  readonly environment: NodeJS.ProcessEnv;
}

export interface DetectHeadroomRoutingInput {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly settings: Pick<ServerSettings, "headroomProxyUrl" | "providerInstances" | "providers">;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

function isHeadroomRoutableProvider(
  provider: ProviderDriverKind,
): provider is ProviderDriverKind & HeadroomRoutableProvider {
  return provider === "claudeAgent" || provider === "codex";
}

export function isHeadroomProxyUrl(
  value: string | undefined,
  provider: HeadroomRoutableProvider,
  configuredProxyUrl: string = DEFAULT_HEADROOM_PROXY_URL,
): boolean {
  if (value === undefined) return false;
  const configuredOrigin = normalizeHeadroomProxyUrl(configuredProxyUrl);
  if (configuredOrigin === null) return false;
  try {
    const url = new URL(value.trim());
    const pathname = url.pathname.replace(/\/$/, "") || "/";
    return (
      url.origin === configuredOrigin &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      (provider === "claudeAgent" ? pathname === "/" : pathname === "/v1")
    );
  } catch {
    return false;
  }
}

export function claudeSettingsRouteThroughHeadroom(
  contents: string,
  configuredProxyUrl: string = DEFAULT_HEADROOM_PROXY_URL,
): boolean {
  const decoded = decodeClaudeRoutingSettings(contents);
  return (
    Option.isSome(decoded) &&
    isHeadroomProxyUrl(decoded.value.env?.ANTHROPIC_BASE_URL, "claudeAgent", configuredProxyUrl)
  );
}

function stringAssignment(line: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(["'])([^"']*)\\1\\s*(?:#.*)?$`).exec(line);
  return match?.[2];
}

export interface CodexHeadroomRoutingConfig {
  readonly modelProvider: string | undefined;
  readonly openAiBaseUrl: string | undefined;
  readonly headroomBaseUrl: string | undefined;
}

export function inspectCodexHeadroomRouting(contents: string): CodexHeadroomRoutingConfig {
  let section = "";
  let modelProvider: string | undefined;
  let openAiBaseUrl: string | undefined;
  let headroomBaseUrl: string | undefined;

  for (const line of contents.split(/\r?\n/)) {
    const table = /^\s*\[\s*([^\]]+)\s*\]\s*(?:#.*)?$/.exec(line);
    if (table !== null) {
      section = table[1]?.trim() ?? "";
      continue;
    }
    if (line.trimStart().startsWith("#")) continue;
    if (section === "") {
      modelProvider = stringAssignment(line, "model_provider") ?? modelProvider;
      openAiBaseUrl = stringAssignment(line, "openai_base_url") ?? openAiBaseUrl;
    } else if (section === "model_providers.headroom") {
      headroomBaseUrl = stringAssignment(line, "base_url") ?? headroomBaseUrl;
    }
  }

  return { modelProvider, openAiBaseUrl, headroomBaseUrl };
}

function resolveProviderRoutingConfig(
  input: DetectHeadroomRoutingInput & { readonly provider: HeadroomRoutableProvider },
): ProviderRoutingConfig | undefined {
  const explicit = input.settings.providerInstances[input.providerInstanceId];
  if (explicit !== undefined) {
    return {
      config: explicit.config ?? {},
      environment: mergeProviderInstanceEnvironment(
        explicit.environment,
        input.environment ?? process.env,
      ),
    };
  }
  if (String(input.providerInstanceId) !== input.provider) return undefined;
  return {
    config:
      input.provider === "claudeAgent"
        ? input.settings.providers.claudeAgent
        : input.settings.providers.codex,
    environment: input.environment ?? process.env,
  };
}

function environmentHomePath(
  path: Path.Path,
  value: string | undefined,
  cwd: string | undefined,
): string | undefined {
  const homePath = value?.trim() ?? "";
  if (homePath.length === 0) return undefined;
  return cwd === undefined ? path.resolve(homePath) : path.resolve(cwd, homePath);
}

const readOptional = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(Effect.option);

/** Inspect only the config and base URL fields that decide whether this provider reaches Headroom. */
export const detectHeadroomRouting = Effect.fn("HeadroomRouting.detect")(function* (
  input: DetectHeadroomRoutingInput,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  if (!isHeadroomRoutableProvider(input.provider)) return false;
  const resolved = resolveProviderRoutingConfig({ ...input, provider: input.provider });
  if (resolved === undefined) return false;

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (input.provider === "claudeAgent") {
    const config = decodeClaudeSettings(resolved.config);
    if (Option.isNone(config)) return false;
    const environmentBaseUrl = resolved.environment.ANTHROPIC_BASE_URL;
    if (environmentBaseUrl !== undefined) {
      return isHeadroomProxyUrl(environmentBaseUrl, "claudeAgent", input.settings.headroomProxyUrl);
    }
    const configuredHome = config.value.homePath.trim();
    const configDir =
      configuredHome.length > 0
        ? path.resolve(expandHomePath(configuredHome))
        : (environmentHomePath(path, resolved.environment.CLAUDE_CONFIG_DIR, input.cwd) ??
          path.join(NodeOS.homedir(), ".claude"));
    const contents = yield* readOptional(fileSystem, path.join(configDir, "settings.json"));
    return (
      Option.isSome(contents) &&
      claudeSettingsRouteThroughHeadroom(contents.value, input.settings.headroomProxyUrl)
    );
  }

  const config = decodeCodexSettings(resolved.config);
  if (Option.isNone(config)) return false;
  const layout = yield* resolveCodexHomeLayout(config.value);
  const configDir =
    layout.effectiveHomePath ??
    environmentHomePath(path, resolved.environment.CODEX_HOME, input.cwd) ??
    layout.sharedHomePath;
  const contents = yield* readOptional(fileSystem, path.join(configDir, "config.toml"));
  const inspected = inspectCodexHeadroomRouting(Option.getOrElse(contents, () => ""));

  if (inspected.modelProvider === "headroom") {
    return isHeadroomProxyUrl(inspected.headroomBaseUrl, "codex", input.settings.headroomProxyUrl);
  }
  if (inspected.modelProvider !== undefined && inspected.modelProvider !== "openai") return false;

  const environmentBaseUrl = resolved.environment.OPENAI_BASE_URL;
  return environmentBaseUrl !== undefined
    ? isHeadroomProxyUrl(environmentBaseUrl, "codex", input.settings.headroomProxyUrl)
    : isHeadroomProxyUrl(inspected.openAiBaseUrl, "codex", input.settings.headroomProxyUrl);
});
