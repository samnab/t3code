# Pi subagent control plane

The Pi adapter can project and control runs owned by a Pi subagent manager extension. This is an optional protocol. A Pi session without the extension remains usable, but its subagent controls report `supported: false` with a reason.

## Pi extension channel

Pi 0.84.4 RPC mode owns stdout. Extension `console.log` output cannot be used as RPC records, and extensions must not call Pi's private `_emit` method.

The supported extension API is `pi.appendEntry(customType, data)`. The manager reserves the custom type `t3.subagent.v1` and appends the complete manager envelope as `data`:

```ts
pi.appendEntry("t3.subagent.v1", {
  type: "t3.subagent.v1",
  kind: "ack",
  id: correlationId,
  accepted: true,
});
```

Pi emits that append through RPC stdout in this authoritative shape:

```json
{
  "type": "entry_appended",
  "entry": {
    "type": "custom",
    "id": "generated-by-pi",
    "parentId": null,
    "timestamp": "2026-01-01T00:00:00.000Z",
    "customType": "t3.subagent.v1",
    "data": {
      "type": "t3.subagent.v1",
      "kind": "ack",
      "id": "correlation-id",
      "accepted": true
    }
  }
}
```

Negotiation replies, delivery acknowledgements, and normalized `run-upsert` records all use this custom-entry channel. T3 decodes only the entry `data` whose `customType` is exactly `t3.subagent.v1`. Malformed, oversized, foreign-version, and foreign-manager records are dropped.

T3 invokes manager operations through the registered `/subagent:t3-control` extension command. The argument is one base64url-encoded version 1 envelope with `negotiate`, `steer`, `cancel`, or the internal `run-upsert-result` as its operation. T3 checks Pi's live `get_commands` result before every invocation. If the command is absent, T3 returns an unsupported error and does not send the slash command, because Pi would otherwise pass an unregistered command to the model.

## Negotiation and status

A protocol match produces `supported: true` and exposes the manager ID, protocol version, and all declared capabilities. `supported` describes protocol compatibility, not whether every control is enabled.

Steer and cancel each require:

- `normalizedEvents`, so T3 has the manager's live activation ID;
- `ownerRouting`, so the manager can prove it owns the run;
- `deliveryAcknowledgements`, because T3 waits for an explicit accepted or rejected result;
- the matching `steering` or `cancellation` capability.

A missing requirement disables the control with a reason naming that capability. In particular, `normalizedEvents: false` leaves the protocol supported but disables both controls. T3 then keeps its tool-result lifecycle fallback. `stableActivations` remains reported but does not gate controls because routing uses the current normalized activation ID.

Before steer or cancel, T3 reads the live command registry and renegotiates capabilities. A removed command never reaches the model. A changed manager ID fails ownership validation. A capability removed after extension reload disables the operation before its control envelope is sent.

Unsupported status records always include a non-empty `reason`. Disabled controls also carry the reason used by the adapter.

The initial negotiation remains bounded by the existing five-second timeout. After T3 confirms the manager identity, a reconnect with durable transcript bindings performs a second bounded negotiation carrying that manager's replay watermarks. Up to 64 run upserts that arrive before negotiation completes are retained per session and replayed in order after the manager registry activates. Negotiation remains active until that ordered queue is empty, so live records arriving during replay join the same drain. The buffer drops its oldest record when full. Stop and process replacement clear it. Open runs and finalized activation history are also bounded; evicting the oldest open row emits a stopped completion before removal.

## Authorization and RPCs

The WebSocket RPC layer exposes four methods:

| Method                                | Scope                   | Input                                                     | Result                                            |
| ------------------------------------- | ----------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| `orchestration.subagentControlStatus` | `orchestration:read`    | `{}`                                                      | Status rows for live provider sessions            |
| `orchestration.subagentControlSteer`  | `orchestration:operate` | `managerId`, namespaced `runId`, non-empty `text`         | `{ accepted: true }` or a typed control error     |
| `orchestration.subagentControlCancel` | `orchestration:operate` | `managerId`, namespaced `runId`                           | `{ accepted: true }` or a typed control error     |
| `orchestration.getSubagentTranscript` | `orchestration:read`    | `threadId`, opaque `runId`, one exclusive sequence cursor | Bounded transcript page or typed no-content error |

Routing binds a command to the live provider instance that declares the manager. The adapter then checks the namespaced task ID against that manager's open-run registry. A caller cannot steer or cancel a run owned by another manager, a prior Pi process epoch, or a closed activation.

## Additive transcript projection

Phase 1.5 adds the optional `childTranscripts` capability. A negotiating manager can bind finalized child items to an opaque T3 run identity after the allocating run row commits. T3 stores those bodies only in the additive side store, re-redacts before its 4096-code-point cap, retains at most 500 items per run, and exposes pull-only pages capped at 200 entries and 256 KiB. Durable eviction ranges remain distinct from bounded diagnostics for sequences that were never observed. Replay includes every durable binding owned by the confirmed manager in the current thread, including terminal runs and a zero watermark.

Reads require the run's durable thread binding and never publish transcript bodies through events, bootstrap state, outbox records, prompts, canonical timeline data, or inventory. Web, desktop, and mobile poll only while a durable disclosure is mounted and nonterminal, perform one bounded terminal catch-up, and leave further older navigation explicit.

Managers that do not negotiate `childTranscripts`, including stock Pi 0.84.4 and unsupported providers, stay summary-only across storage, transport, and UI. This checkout does not contain the repository-owned enhanced-manager producer, so the server path is exercisable only with its test fixture until that external producer ships.
