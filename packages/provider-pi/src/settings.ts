/**
 * Pi instance settings. Shared by the server driver and the client settings
 * form, so it holds only browser-safe schema code.
 *
 * @module provider-pi/settings
 */
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
  TrimmedNonEmptyString,
  PositiveInt,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Per-model concurrent active-turn caps for Pi. Missing keys are unlimited. */
export const PiModelConcurrency = Schema.Record(TrimmedNonEmptyString, PositiveInt);

export const PiSettings = makeProviderSettingsSchema(
  {
    // Off by default like Cursor and Grok. Users opt in from Settings.
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("pi").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Pi coding agent binary.",
        providerSettingsForm: { placeholder: "pi", clearWhenEmpty: "omit" },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to pi --mode rpc on session start.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
    modelConcurrency: PiModelConcurrency.pipe(
      Schema.withDecodingDefault(Effect.succeed({})),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "launchArgs"],
  },
);
export type PiSettings = typeof PiSettings.Type;
