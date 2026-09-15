import { expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerProviderUsageLimits } from "@t3tools/contracts";

import {
  candidateHeadroomPercent,
  evaluateCandidate,
  resolveTier,
  type DelegationCandidateAvailability,
} from "./delegationTiers.ts";

const usageLimits = (
  windows: Array<{ id: string; usedPercent: number }>,
  unavailable?: { reason: "unsupported" | "probeFailed" },
): ServerProviderUsageLimits => ({
  checkedAt: "2026-09-06T00:00:00.000Z",
  windows: windows.map((window) => ({ kind: "weekly" as const, label: window.id, ...window })),
  ...(unavailable === undefined ? {} : { unavailable }),
});

const available = (usageLimits?: ServerProviderUsageLimits): DelegationCandidateAvailability => ({
  instanceAvailable: true,
  usageLimits,
});

const unavailable = (reason: string): DelegationCandidateAvailability => ({
  instanceAvailable: false,
  reason,
  usageLimits: undefined,
});

it("computes headroom as 100 minus the max used percent across all windows", () => {
  expect(
    candidateHeadroomPercent(
      { model: "any-model" },
      usageLimits([
        { id: "five_hour", usedPercent: 40 },
        { id: "seven_day", usedPercent: 10 },
      ]),
    ),
  ).toBe(60);
});

it("counts a seven_day_<model> window only when the candidate model matches it", () => {
  const limits = usageLimits([
    { id: "five_hour", usedPercent: 20 },
    { id: "seven_day_opus", usedPercent: 95 },
    { id: "seven_day_sonnet", usedPercent: 50 },
  ]);
  expect(candidateHeadroomPercent({ model: "claude-opus-4-6" }, limits)).toBe(5);
  expect(candidateHeadroomPercent({ model: "claude-sonnet-4-5" }, limits)).toBe(50);
  expect(candidateHeadroomPercent({ model: "glm-4.6" }, limits)).toBe(80);
});

it("returns unknown headroom without a snapshot, when unavailable, or with no matching window", () => {
  expect(candidateHeadroomPercent({ model: "m" }, undefined)).toBeUndefined();
  expect(
    candidateHeadroomPercent({ model: "m" }, usageLimits([], { reason: "unsupported" })),
  ).toBeUndefined();
  expect(
    candidateHeadroomPercent({ model: "m" }, usageLimits([{ id: "five_hour", usedPercent: 1 }])),
  ).toBe(99);
  // A per-model window alone does not apply to an unrelated model.
  expect(
    candidateHeadroomPercent(
      { model: "glm" },
      usageLimits([{ id: "seven_day_opus", usedPercent: 1 }]),
    ),
  ).toBeUndefined();
});

it("never blocks a candidate on unknown headroom", () => {
  const evaluation = evaluateCandidate(
    { providerInstanceId: ProviderInstanceId.make("p"), model: "m", minHeadroomPercent: 50 },
    available(undefined),
  );
  expect(evaluation).toEqual({ eligible: true });
});

it("skips a candidate whose known headroom is below the minimum", () => {
  const evaluation = evaluateCandidate(
    { providerInstanceId: ProviderInstanceId.make("p"), model: "m", minHeadroomPercent: 30 },
    available(usageLimits([{ id: "five_hour", usedPercent: 80 }])),
  );
  expect(evaluation).toEqual({
    eligible: false,
    headroomPercent: 20,
    reason: "usage headroom 20% is below the required 30%",
  });
});

it("keeps a candidate whose headroom meets the minimum", () => {
  const evaluation = evaluateCandidate(
    { providerInstanceId: ProviderInstanceId.make("p"), model: "m", minHeadroomPercent: 20 },
    available(usageLimits([{ id: "five_hour", usedPercent: 80 }])),
  );
  expect(evaluation).toEqual({ eligible: true, headroomPercent: 20 });
});

it("marks an unavailable instance ineligible with its reason", () => {
  const evaluation = evaluateCandidate(
    { providerInstanceId: ProviderInstanceId.make("p"), model: "m" },
    unavailable("This provider has no native delegation adapter."),
  );
  expect(evaluation).toEqual({
    eligible: false,
    reason: "This provider has no native delegation adapter.",
  });
});

it("resolves the first eligible candidate in tier order", () => {
  const candidates = [
    { providerInstanceId: ProviderInstanceId.make("p"), model: "drained", minHeadroomPercent: 50 },
    { providerInstanceId: ProviderInstanceId.make("q"), model: "adapterless" },
    { providerInstanceId: ProviderInstanceId.make("r"), model: "spare" },
  ];
  const evaluations = new Map([
    [candidates[0], { eligible: false, headroomPercent: 5, reason: "too drained" }],
    [candidates[1], { eligible: false, reason: "adapter missing" }],
    [candidates[2], { eligible: true, headroomPercent: 70 }],
  ]);
  const evaluate = (candidate: (typeof candidates)[number]) =>
    evaluations.get(candidate) ?? { eligible: false };
  expect(resolveTier(candidates, evaluate)).toBe(candidates[2]);
  expect(resolveTier(candidates.slice(0, 2), evaluate)).toBeUndefined();
});
