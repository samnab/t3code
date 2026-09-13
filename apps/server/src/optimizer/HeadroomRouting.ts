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
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
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
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));
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

export interface HeadroomSessionRoutingInput {
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly settings: Pick<ServerSettings, "headroomProxyUrl" | "providerInstances" | "providers">;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface HeadroomSessionRouting {
  readonly environment: Readonly<Record<string, string>>;
  readonly codexAppServerArgs?: ReadonlyArray<string>;
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
  input: HeadroomSessionRoutingInput & { readonly provider: HeadroomRoutableProvider },
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

const codexLaunchOverride = (launchArgs: string, key: string): string | undefined => {
  const args = tokenizeCliArgs(launchArgs);
  let value: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const override =
      argument?.startsWith("--config=") === true || argument?.startsWith("-c=") === true
        ? argument.slice(argument.indexOf("=") + 1)
        : argument === "--config" || argument === "-c"
          ? args[++index]
          : undefined;
    if (override === undefined) continue;
    const separator = override.indexOf("=");
    if (separator === -1 || override.slice(0, separator).trim() !== key) continue;
    value = override
      .slice(separator + 1)
      .trim()
      .replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
  }
  return value;
};

const selectsCodexProfile = (launchArgs: string): boolean =>
  tokenizeCliArgs(launchArgs).some(
    (argument) =>
      argument === "--profile" || argument === "-p" || argument.startsWith("--profile="),
  );

function inspectCodexDefaultProfile(contents: string): string | undefined {
  let section = "";
  let profile: string | undefined;
  const profileProviders = new Map<string, string>();
  for (const line of contents.split(/\r?\n/)) {
    const table = /^\s*\[\s*([^\]]+)\s*\]\s*(?:#.*)?$/.exec(line);
    if (table !== null) {
      section = table[1]?.trim() ?? "";
      continue;
    }
    if (section === "") {
      profile = stringAssignment(line, "profile") ?? profile;
      continue;
    }
    const profileSection = /^profiles\.([A-Za-z0-9_-]+)$/.exec(section);
    const provider = stringAssignment(line, "model_provider");
    if (profileSection?.[1] !== undefined && provider !== undefined) {
      profileProviders.set(profileSection[1], provider);
    }
  }
  return profile === undefined ? undefined : profileProviders.get(profile);
}

const headroomEnvironment = (proxyUrl: string): Readonly<Record<string, string>> => ({
  HEADROOM_ACTIVE: "1",
  HEADROOM_PROXY_URL: proxyUrl,
});

/** Build process-local launch settings without changing provider identity or persistent config. */
export const resolveHeadroomSessionRouting = Effect.fn("HeadroomRouting.resolveSession")(function* (
  input: HeadroomSessionRoutingInput,
): Effect.fn.Return<HeadroomSessionRouting | undefined, never, FileSystem.FileSystem | Path.Path> {
  if (!isHeadroomRoutableProvider(input.provider)) return undefined;
  const proxyUrl = normalizeHeadroomProxyUrl(input.settings.headroomProxyUrl);
  if (proxyUrl === null) return undefined;
  const resolved = resolveProviderRoutingConfig({ ...input, provider: input.provider });
  if (resolved === undefined) return undefined;

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (input.provider === "claudeAgent") {
    const config = decodeClaudeSettings(resolved.config);
    if (Option.isNone(config)) return undefined;
    if (
      resolved.environment.CLAUDE_CODE_USE_BEDROCK ||
      resolved.environment.CLAUDE_CODE_USE_VERTEX ||
      resolved.environment.CLAUDE_CODE_USE_FOUNDRY
    ) {
      return undefined;
    }
    const configuredHome = config.value.homePath.trim();
    const configDir =
      configuredHome.length > 0
        ? path.resolve(expandHomePath(configuredHome))
        : (environmentHomePath(path, resolved.environment.CLAUDE_CONFIG_DIR, input.cwd) ??
          path.join(NodeOS.homedir(), ".claude"));
    const contents = yield* readOptional(fileSystem, path.join(configDir, "settings.json"));
    const settingsRoute = Option.flatMap(contents, decodeClaudeRoutingSettings);
    const explicitBaseUrl =
      resolved.environment.ANTHROPIC_BASE_URL ??
      (Option.isSome(settingsRoute) ? settingsRoute.value.env?.ANTHROPIC_BASE_URL : undefined);
    if (
      explicitBaseUrl !== undefined &&
      !isHeadroomProxyUrl(explicitBaseUrl, "claudeAgent", proxyUrl)
    ) {
      return undefined;
    }
    return {
      environment: {
        ...headroomEnvironment(proxyUrl),
        ANTHROPIC_BASE_URL: proxyUrl,
      },
    };
  }

  const config = decodeCodexSettings(resolved.config);
  if (Option.isNone(config)) return undefined;
  const launchArgs =
    resolved.environment.T3CODE_CODEX_LAUNCH_ARGS?.trim() || config.value.launchArgs.trim();
  if (selectsCodexProfile(launchArgs)) return undefined;
  const layout = yield* resolveCodexHomeLayout(config.value);
  const configDir =
    layout.effectiveHomePath ??
    environmentHomePath(path, resolved.environment.CODEX_HOME, input.cwd) ??
    layout.sharedHomePath;
  const contents = yield* readOptional(fileSystem, path.join(configDir, "config.toml"));
  const configContents = Option.getOrElse(contents, () => "");
  const inspected = inspectCodexHeadroomRouting(configContents);
  const modelProvider =
    codexLaunchOverride(launchArgs, "model_provider") ??
    inspectCodexDefaultProfile(configContents) ??
    inspected.modelProvider ??
    "openai";

  if (modelProvider === "headroom") {
    const overriddenBaseUrl = codexLaunchOverride(launchArgs, "model_providers.headroom.base_url");
    return isHeadroomProxyUrl(overriddenBaseUrl ?? inspected.headroomBaseUrl, "codex", proxyUrl)
      ? { environment: headroomEnvironment(proxyUrl) }
      : undefined;
  }
  if (modelProvider !== "openai") return undefined;

  const explicitBaseUrls = [
    resolved.environment.OPENAI_BASE_URL,
    codexLaunchOverride(launchArgs, "openai_base_url"),
    inspected.openAiBaseUrl,
  ].filter((value): value is string => value !== undefined);
  if (explicitBaseUrls.some((value) => !isHeadroomProxyUrl(value, "codex", proxyUrl))) {
    return undefined;
  }
  const baseUrl = `${proxyUrl}/v1`;
  return {
    environment: {
      ...headroomEnvironment(proxyUrl),
      OPENAI_BASE_URL: baseUrl,
    },
    codexAppServerArgs: ["-c", `openai_base_url=${encodeJsonString(baseUrl)}`],
  };
});
