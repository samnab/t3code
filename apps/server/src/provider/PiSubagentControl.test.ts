import { describe, expect, it } from "@effect/vitest";

import {
  MANAGER_PROTOCOL_VERSION,
  decodeControlEnvelope,
  decodeManagerRecord,
  deriveControlAvailabilities,
  encodeControlEnvelope,
  makeManagerRunRegistry,
  type ManagerRunUpsert,
  negotiationFromRecord,
} from "./PiSubagentControl.ts";

const ALL_CAPABILITIES = {
  normalizedEvents: true,
  stableActivations: true,
  ownerRouting: true,
  steering: true,
  cancellation: true,
  reloadRestore: true,
  scheduling: true,
  nativeChildProjection: true,
  deliveryAcknowledgements: true,
} as const;

const negotiationRecord = (overrides: Record<string, unknown> = {}) => ({
  type: "t3.subagent.v1",
  kind: "negotiation",
  id: "corr-1",
  managerId: "mgr-1",
  protocolVersion: MANAGER_PROTOCOL_VERSION,
  capabilities: ALL_CAPABILITIES,
  ...overrides,
});

const runUpsert = (overrides: Partial<ManagerRunUpsert> = {}): ManagerRunUpsert => ({
  type: "t3.subagent.v1",
  kind: "run-upsert",
  managerId: "mgr-1",
  sequence: 1,
  runId: "sa-1",
  activationId: "act-1",
  status: "running",
  ...overrides,
});

describe("PiSubagentControl", () => {
  describe("command envelopes", () => {
    it("base64url-encodes envelopes as a single whitespace-free argument", () => {
      const encoded = encodeControlEnvelope({
        v: 1,
        op: "steer",
        id: "corr 1",
        managerId: "mgr-1",
        runId: "sa-1",
        activationId: "act-1",
        text: 'steer with "quotes" & spaces\nand newlines',
      });
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      const decoded = decodeControlEnvelope(encoded);
      expect(decoded).toMatchObject({
        v: 1,
        op: "steer",
        id: "corr 1",
        managerId: "mgr-1",
        runId: "sa-1",
        activationId: "act-1",
      });
    });

    it("rejects envelopes with an unsupported version", () => {
      expect(
        decodeControlEnvelope(
          Buffer.from(JSON.stringify({ v: 2, op: "negotiate" })).toString("base64url"),
        ),
      ).toBeUndefined();
    });
  });

  describe("record decoding", () => {
    it("decodes negotiation, run-upsert, and ack records", () => {
      expect(decodeManagerRecord(negotiationRecord())).toMatchObject({
        kind: "negotiation",
        managerId: "mgr-1",
        protocolVersion: 1,
      });
      expect(decodeManagerRecord(runUpsert({ summary: "did the thing" }))).toMatchObject({
        kind: "run-upsert",
        sequence: 1,
        status: "running",
      });
      expect(
        decodeManagerRecord({ type: "t3.subagent.v1", kind: "ack", id: "corr-1", accepted: true }),
      ).toMatchObject({ kind: "ack", accepted: true });
    });

    it("drops records with a missing capability boolean", () => {
      const incomplete: Record<string, boolean> = { ...ALL_CAPABILITIES };
      delete incomplete.nativeChildProjection;
      expect(decodeManagerRecord(negotiationRecord({ capabilities: incomplete }))).toBeUndefined();
    });

    it("drops records with foreign types, unsafe ids, or out-of-domain fields", () => {
      expect(
        decodeManagerRecord({ type: "other", kind: "ack", id: "x", accepted: true }),
      ).toBeUndefined();
      expect(decodeManagerRecord(runUpsert({ runId: "sa:1" }))).toBeUndefined();
      expect(decodeManagerRecord(runUpsert({ activationId: "" }))).toBeUndefined();
      expect(decodeManagerRecord(runUpsert({ sequence: 0 }))).toBeUndefined();
      expect(decodeManagerRecord({ ...runUpsert(), status: "spawned" })).toBeUndefined();
      expect(decodeManagerRecord(runUpsert({ title: "x".repeat(600) }))).toBeUndefined();
    });
  });

  describe("negotiation", () => {
    it("accepts a declared protocol version with capabilities", () => {
      const decoded = decodeManagerRecord(negotiationRecord());
      if (decoded === undefined || decoded.kind !== "negotiation") throw new Error("bad fixture");
      const parsed = negotiationFromRecord(decoded);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.control.managerId).toBe("mgr-1");
        expect(parsed.control.capabilities.steering).toBe(true);
      }
    });

    it("rejects a mismatched protocol version with an explicit reason", () => {
      const decoded = decodeManagerRecord(negotiationRecord({ protocolVersion: 2 }));
      if (decoded === undefined || decoded.kind !== "negotiation") throw new Error("bad fixture");
      const parsed = negotiationFromRecord(decoded);
      expect(parsed).toMatchObject({ ok: false });
      if (!parsed.ok) expect(parsed.reason).toContain("protocol");
    });
  });

  describe("control availability", () => {
    it("enables every control when all capabilities are declared", () => {
      const availabilities = deriveControlAvailabilities(ALL_CAPABILITIES);
      expect(availabilities.status.enabled).toBe(true);
      expect(availabilities.steer.enabled).toBe(true);
      expect(availabilities.cancel.enabled).toBe(true);
    });

    it("disables steering only when the steering capability is absent", () => {
      const availabilities = deriveControlAvailabilities({ ...ALL_CAPABILITIES, steering: false });
      expect(availabilities.steer).toMatchObject({ enabled: false });
      if (!availabilities.steer.enabled) expect(availabilities.steer.reason).toContain("steering");
      expect(availabilities.cancel.enabled).toBe(true);
    });

    it("requires owner routing for both owner controls", () => {
      const availabilities = deriveControlAvailabilities({
        ...ALL_CAPABILITIES,
        ownerRouting: false,
      });
      expect(availabilities.steer.enabled).toBe(false);
      expect(availabilities.cancel.enabled).toBe(false);
      if (!availabilities.steer.enabled) {
        expect(availabilities.steer.reason).toContain("ownerRouting");
      }
    });

    it("disables the status read without normalized events", () => {
      const availabilities = deriveControlAvailabilities({
        ...ALL_CAPABILITIES,
        normalizedEvents: false,
      });
      expect(availabilities.status.enabled).toBe(false);
      if (!availabilities.status.enabled) {
        expect(availabilities.status.reason).toContain("normalizedEvents");
      }
    });
  });

  describe("run registry", () => {
    it("applies a run lifecycle idempotently", () => {
      const registry = makeManagerRunRegistry("mgr-1");
      expect(registry.apply(runUpsert())).toMatchObject({ accepted: true, effect: "start" });
      expect(registry.apply(runUpsert({ sequence: 2 }))).toMatchObject({
        accepted: true,
        effect: "update",
      });
      expect(registry.apply(runUpsert({ sequence: 3, status: "done" }))).toMatchObject({
        accepted: true,
        effect: "complete",
      });
      expect(registry.findOpenRun("sa-1")).toBeUndefined();
    });

    it("rejects stale sequences, duplicate terminals, and late activation events", () => {
      const registry = makeManagerRunRegistry("mgr-1");
      registry.apply(runUpsert());
      registry.apply(runUpsert({ sequence: 2 }));
      expect(registry.apply(runUpsert({ sequence: 2 }))).toMatchObject({
        accepted: false,
        reason: "stale-sequence",
      });
      registry.apply(runUpsert({ sequence: 3, status: "cancelled" }));
      expect(registry.apply(runUpsert({ sequence: 4, status: "cancelled" }))).toMatchObject({
        accepted: false,
        reason: "late-activation",
      });
    });

    it("rejects events from another manager", () => {
      const registry = makeManagerRunRegistry("mgr-1");
      expect(registry.apply(runUpsert({ managerId: "rogue" }))).toMatchObject({
        accepted: false,
        reason: "manager-mismatch",
      });
    });

    it("starts a new run for a fresh activation and completes unseen terminal activations", () => {
      const registry = makeManagerRunRegistry("mgr-1");
      registry.apply(runUpsert({ activationId: "act-1" }));
      const second = registry.apply(runUpsert({ activationId: "act-2", sequence: 5 }));
      expect(second).toMatchObject({ accepted: true, effect: "start" });
      expect(registry.findOpenRun("sa-1")).toMatchObject({ activationId: "act-2" });
      // The abandoned first activation can no longer mutate the run.
      expect(registry.apply(runUpsert({ activationId: "act-1", sequence: 6 }))).toMatchObject({
        accepted: false,
        reason: "late-activation",
      });
      // Terminal event for an activation never seen running still completes.
      const terminal = registry.apply(
        runUpsert({ runId: "sa-2", activationId: "act-9", status: "error", sequence: 1 }),
      );
      expect(terminal).toMatchObject({ accepted: true, effect: "complete" });
      expect(registry.openRuns()).toHaveLength(1);
    });
  });
});
