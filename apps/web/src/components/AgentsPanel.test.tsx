import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type {
  AgentPanelModel,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  AgentDetailView,
  AgentsPanel,
  canShowTranscriptDetail,
  transcriptDisplayState,
  transcriptFlagLabels,
  transcriptMarkerText,
} from "./AgentsPanel";

function agent(overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    id: "run-1",
    kind: "subagent",
    title: "Child agent",
    role: null,
    model: "test-model",
    effort: "high",
    status: "completed",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: "Done",
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: "2026-09-02T00:00:00.000Z",
    startedAt: "2026-09-02T00:00:00.000Z",
    completedAt: "2026-09-02T00:01:00.000Z",
    updatedAt: "2026-09-02T00:01:00.000Z",
    historyAvailability: "summary-only",
    controlAvailability: "unsupported",
    ...overrides,
  };
}

function panel(directAgent: RuntimeSubagent): AgentPanelModel {
  return {
    workflows: [],
    directAgents: [directAgent],
    runningCount: 0,
    waitingCount: 0,
    idleCount: 0,
    settledCount: 1,
    totalTokens: 0,
    hasAgents: true,
    liveCount: 0,
  };
}

describe("AgentsPanel child transcript disclosure", () => {
  it("keeps summary-only rows truthful in the roster", () => {
    const summaryOnly = agent();
    const markup = renderToStaticMarkup(<AgentsPanel model={panel(summaryOnly)} />);

    expect(canShowTranscriptDetail(summaryOnly)).toBe(false);
    expect(canShowTranscriptDetail(agent({ historyAvailability: "unavailable" }))).toBe(false);
    expect(markup).toContain("Child transcript detail unavailable");
  });

  it("renders every row as an openable button regardless of history availability", () => {
    const durable = agent({ historyAvailability: "durable" });
    const markup = renderToStaticMarkup(
      <AgentsPanel
        model={panel(durable)}
        environmentId={EnvironmentId.make("environment-1")}
        threadId={ThreadId.make("thread-1")}
      />,
    );

    expect(canShowTranscriptDetail(durable)).toBe(true);
    // The roster row itself is the click target that opens the detail view;
    // there's no separate inline-disclosure affordance to assert on here.
    expect(markup).toContain("<button");
    expect(markup).toContain("History available");
  });

  // Regression: most subagents (only PiAdapter stamps durable evidence
  // today) carry historyAvailability === undefined, not "summary-only". The
  // detail view must never attempt to load a transcript for those runs —
  // it previously fell through to the transcript body (and the ws RPC error
  // "Could not load the child transcript.") for anything that wasn't
  // explicitly flagged summary-only/unavailable.
  it("never renders a transcript load attempt when history isn't flagged durable", () => {
    const undocumented = agent({
      status: "completed",
      result: "Boston is 61°F and cloudy.",
    });
    // Simulate a Claude/Codex run: only PiAdapter stamps historyAvailability
    // at all, so this is undefined in practice, not the explicit
    // "summary-only" the `agent()` helper defaults to.
    delete (undocumented as { historyAvailability?: unknown }).historyAvailability;
    const markup = renderToStaticMarkup(
      <AgentDetailView
        agent={undocumented}
        environmentId={EnvironmentId.make("environment-1")}
        threadId={ThreadId.make("thread-1")}
        onBack={() => {}}
      />,
    );

    expect(canShowTranscriptDetail(undocumented)).toBe(false);
    expect(markup).not.toContain("Could not load");
    expect(markup).toContain("Child transcript detail unavailable");
    expect(markup).toContain("Boston is 61°F and cloudy.");
  });
});

describe("AgentsPanel transcript rendering semantics", () => {
  it("distinguishes eviction from never-observed gaps", () => {
    expect(transcriptMarkerText("evicted", 4, 6)).toBe(
      "Earlier transcript items were evicted (#4–#6).",
    );
    expect(transcriptMarkerText("gap", 4, 6)).toBe("Never-observed transcript gap (#4–#6).");
  });

  it("preserves both truncation flags independently", () => {
    expect(transcriptFlagLabels({ truncated: true, upstreamTruncated: false })).toEqual([
      "truncated",
    ]);
    expect(transcriptFlagLabels({ truncated: false, upstreamTruncated: true })).toEqual([
      "upstream truncated",
    ]);
    expect(transcriptFlagLabels({ truncated: true, upstreamTruncated: true })).toEqual([
      "truncated",
      "upstream truncated",
    ]);
  });

  it("keeps live loading separate from the one terminal catch-up", () => {
    expect(
      transcriptDisplayState({
        hasError: false,
        isPending: true,
        terminal: false,
        terminalCatchUpComplete: false,
      }),
    ).toBe("loading");
    expect(
      transcriptDisplayState({
        hasError: false,
        isPending: false,
        terminal: false,
        terminalCatchUpComplete: false,
      }),
    ).toBe("ready");
    expect(
      transcriptDisplayState({
        hasError: false,
        isPending: false,
        terminal: true,
        terminalCatchUpComplete: false,
      }),
    ).toBe("loading");
    expect(
      transcriptDisplayState({
        hasError: false,
        isPending: false,
        terminal: true,
        terminalCatchUpComplete: true,
      }),
    ).toBe("ready");
    expect(
      transcriptDisplayState({
        hasError: true,
        isPending: false,
        terminal: false,
        terminalCatchUpComplete: false,
      }),
    ).toBe("error");
  });
});
