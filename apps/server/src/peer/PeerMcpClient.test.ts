import { EnvironmentId, type PeerLink } from "@t3tools/contracts";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

const box = EnvironmentId.make("environment-box");

/** What a tool call forwards, as the fake peer receives it. */
const JsonRpcRequest = Schema.Struct({
  method: Schema.String,
  id: Schema.optional(Schema.Number),
  params: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});

/** A request the fake peer received. */
interface FakeRequest extends Schema.Schema.Type<typeof JsonRpcRequest> {}

/**
 * The peer's `/mcp` as an older T3 Code would answer it: it serves one tool,
 * `t3_thing`, whose schema declares a single `declared` argument. Every
 * request is recorded. Once `restarted` is set, it forgets the old session
 * and serves an older `t3_thing` that declares only `other`.
 */
const serveFakePeer = (
  requests: Ref.Ref<ReadonlyArray<FakeRequest>>,
  restarted?: Ref.Ref<boolean>,
) =>
  Effect.gen(function* () {
    yield* HttpRouter.serve(
      HttpRouter.add("POST", "/mcp", () =>
        Effect.gen(function* () {
          const body = yield* HttpServerRequest.schemaBodyJson(JsonRpcRequest);
          yield* Ref.update(requests, (seen) => [...seen, body]);
          const isRestarted = restarted === undefined ? false : yield* Ref.get(restarted);
          const sessionId = isRestarted ? "session-new" : "session-fake";
          if (body.method === "initialize") {
            return HttpServerResponse.empty({
              status: 200,
              headers: { "mcp-session-id": sessionId },
            });
          }
          if (body.method === "notifications/initialized") return HttpServerResponse.empty();
          if (body.method === "tools/list") {
            return yield* HttpServerResponse.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [
                  {
                    name: "t3_thing",
                    inputSchema: {
                      type: "object",
                      properties: isRestarted
                        ? { other: { type: "number" } }
                        : { declared: { type: "number" } },
                    },
                  },
                ],
              },
            });
          }
          if (body.method === "tools/call") {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (request.headers["mcp-session-id"] !== sessionId) {
              return HttpServerResponse.empty({ status: 404 });
            }
            return yield* HttpServerResponse.json({
              jsonrpc: "2.0",
              id: body.id,
              result: { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] },
            });
          }
          return yield* HttpServerResponse.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32601, message: "Tool not found" },
          });
        }),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.fresh, Layer.build);
    const address = (yield* HttpServer.HttpServer).address;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("expected a TCP address");
    return `http://127.0.0.1:${address.port}`;
  });

const fakeLink = (url: string): PeerLink => ({
  environmentId: box,
  label: "Box",
  urls: [url],
  access: "auto",
  linkedAt: DateTime.fromEpochSeconds(0),
  expiresAt: DateTime.fromEpochSeconds(3_153_600_000),
  lastReachedAt: null,
  lastError: null,
});

/** A client over the fake peer, with `t3_thing` call for its declared shape. */
const clientAt = (url: string) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      PeerMcpClient.layer.pipe(
        Layer.provide(
          Layer.mock(PeerLinks.PeerLinks)({
            resolve: () => Effect.succeed({ link: fakeLink(url), url, token: "link-token" }),
            recordOutcome: () => Effect.void,
          }),
        ),
        Layer.provide(FetchHttpClient.layer),
      ),
    );
    const client = Context.get(context, PeerMcpClient.PeerMcpClient);
    return (args: Record<string, unknown>) =>
      client.call({
        environmentId: box,
        tool: "t3_thing",
        arguments: args,
        limits: { runtimeMode: "auto", interactionMode: "default" },
        success: Schema.Struct({ ok: Schema.Boolean }),
      });
  });

const methodsOf = (requests: ReadonlyArray<FakeRequest>, method: string) =>
  requests.filter((request) => request.method === method);

it.effect("refuses an argument the linked environment's tool does not declare", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<FakeRequest>>([]);
      const url = yield* serveFakePeer(requests);
      const callThing = yield* clientAt(url);

      const failure = yield* callThing({ declared: 1, mystery: true }).pipe(Effect.flip);
      expect(failure.code).toBe("invalid_request");
      expect(failure.message).toBe(
        "The linked environment does not support `mystery` on `t3_thing`. Update it, or omit that field.",
      );

      // Discovery went out, but the call itself never did.
      const seen = yield* Ref.get(requests);
      expect(methodsOf(seen, "tools/call")).toEqual([]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("forwards arguments the linked environment's tool declares, once per session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<FakeRequest>>([]);
      const url = yield* serveFakePeer(requests);
      const callThing = yield* clientAt(url);

      expect(yield* callThing({ declared: 1 })).toEqual({ ok: true });
      expect(yield* callThing({ declared: 2 })).toEqual({ ok: true });

      const seen = yield* Ref.get(requests);
      expect(methodsOf(seen, "tools/list")).toHaveLength(1);
      expect(methodsOf(seen, "tools/call")).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("checks again after the linked environment restarts on an older version", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<FakeRequest>>([]);
      const restarted = yield* Ref.make(false);
      const url = yield* serveFakePeer(requests, restarted);
      const callThing = yield* clientAt(url);

      expect(yield* callThing({ declared: 1 })).toEqual({ ok: true });
      yield* Ref.set(restarted, true);
      const failure = yield* callThing({ declared: 2 }).pipe(Effect.flip);
      expect(failure.message).toBe(
        "The linked environment does not support `declared` on `t3_thing`. Update it, or omit that field.",
      );

      // The second call reached only the forgotten session, which applied nothing.
      const seen = yield* Ref.get(requests);
      expect(methodsOf(seen, "tools/list")).toHaveLength(2);
      expect(methodsOf(seen, "tools/call")).toHaveLength(2);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
