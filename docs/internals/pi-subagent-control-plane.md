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

T3 invokes manager operations through the registered `/subagent:t3-control` extension command. The argument is one base64url-encoded version 1 envelope with `negotiate`, `steer`, or `cancel` as its operation. T3 checks Pi's live `get_commands` result before every invocation. If the command is absent, T3 returns an unsupported error and does not send the slash command, because Pi would otherwise pass an unregistered command to the model.

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

The initial negotiation remains bounded by the existing five-second timeout. Up to 64 run upserts that arrive before negotiation completes are retained per session and replayed in order after the manager registry activates. Negotiation remains active until that ordered queue is empty, so live records arriving during replay join the same drain. The buffer drops its oldest record when full. Stop and process replacement clear it. Open runs and finalized activation history are also bounded; evicting the oldest open row emits a stopped completion before removal.

## Authorization and RPCs

The WebSocket RPC layer exposes three methods:

| Method                                | Scope                   | Input                                             | Result                                        |
| ------------------------------------- | ----------------------- | ------------------------------------------------- | --------------------------------------------- |
| `orchestration.subagentControlStatus` | `orchestration:read`    | `{}`                                              | Status rows for live provider sessions        |
| `orchestration.subagentControlSteer`  | `orchestration:operate` | `managerId`, namespaced `runId`, non-empty `text` | `{ accepted: true }` or a typed control error |
| `orchestration.subagentControlCancel` | `orchestration:operate` | `managerId`, namespaced `runId`                   | `{ accepted: true }` or a typed control error |

Routing binds a command to the live provider instance that declares the manager. The adapter then checks the namespaced task ID against that manager's open-run registry. A caller cannot steer or cancel a run owned by another manager, a prior Pi process epoch, or a closed activation.

## Deferred transcript projection

This slice does not subscribe to or resynchronize transcript history. Entry delivery is live and ordered, but T3 cannot yet prove that no entries were missed across a transport gap. Transcript projection needs a cursor-based gap check and replay from Pi session entries before it can use the manager stream as a durable transcript source.
