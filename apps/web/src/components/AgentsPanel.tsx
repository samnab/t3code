/**
 * Agents right-panel surface: the fleet view over the native subagent fold,
 * and the ONLY place the roster renders (the chat carries one CTA row per
 * spawn batch).
 *
 * Visualization rules (from live-test feedback):
 * - Spawn order is stable. Activity and completion update rows in place.
 * - Agent rows reserve three fixed lines for identity, activity, and metrics;
 *   changing data must never change their height.
 * - Workflow expansion is presentation state. A live run stays expanded when
 *   it settles; older collapsed runs can still be opened at run granularity.
 * - Static status dots, DOM-write elapsed timers, plain token counters.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeBackgroundProcess,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isTerminalSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { RuntimeTaskId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { ArrowLeft, Bot, Braces, Check, ChevronDown, ChevronRight, Send, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";

/**
 * In-flight states all present as Working (one steady state, per the
 * monitoring-pill design: detail belongs in the activity sub-line, and a
 * stalled/waiting/queued subagent is still the fleet doing its job, not a
 * user problem). Only settled states differentiate.
 */
const STATUS_VISUALS: Record<RuntimeSubagent["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Working" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-info", label: "Working" },
  // Idle reads as settled (muted, not sky): a resting Codex child looks done
  // unless resumed — live-test: sky idle dots read as stuck in-progress.
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
    />
  );
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 */
function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}

/**
 * Status-dependent activity line. Live rows lead with what is happening now;
 * settled rows lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
function agentActivityText(agent: RuntimeSubagent): string | null {
  if (agent.terminalReason === "server-restart") return "Interrupted by T3 restart";
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  if (live) {
    return (
      agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
      agent.result ??
      agent.error
    );
  }
  return (
    agent.error ??
    agent.result ??
    agent.progress ??
    (agent.lastToolName ? `▸ ${agent.lastToolName}` : null)
  );
}

export function canShowTranscriptDetail(
  agent: Pick<RuntimeSubagent, "historyAvailability">,
): boolean {
  return agent.historyAvailability === "durable";
}

export function transcriptMarkerText(
  kind: "evicted" | "gap",
  startSequence: number,
  endSequence: number,
) {
  const range =
    startSequence === endSequence ? `#${startSequence}` : `#${startSequence}–#${endSequence}`;
  return kind === "evicted"
    ? `Earlier transcript items were evicted (${range}).`
    : `Never-observed transcript gap (${range}).`;
}

export function transcriptFlagLabels(flags: {
  readonly truncated: boolean;
  readonly upstreamTruncated: boolean;
}) {
  return [
    flags.truncated ? "truncated" : null,
    flags.upstreamTruncated ? "upstream truncated" : null,
  ].filter((label): label is string => label !== null);
}

export function transcriptDisplayState(input: {
  readonly hasError: boolean;
  readonly isPending: boolean;
  readonly terminal: boolean;
  readonly terminalCatchUpComplete: boolean;
}) {
  if (input.hasError) {
    return "error";
  }
  if (input.isPending || (input.terminal && !input.terminalCatchUpComplete)) {
    return "loading";
  }
  return "ready";
}

function AgentTranscript({
  agent,
  environmentId,
  threadId,
  transcriptId,
  fill = false,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  transcriptId: string;
  /** Detail-view mode: fill the available height instead of the bounded
   * inline-disclosure card. */
  fill?: boolean;
}) {
  const runId = RuntimeTaskId.make(agent.id);
  const terminal = isTerminalSubagentStatus(agent.status);
  const queryAtom = orchestrationEnvironment.subagentTranscript({
    environmentId,
    input: { threadId, runId, terminal },
  });
  const { data: view, error, isPending } = useEnvironmentQuery(queryAtom);
  const displayState = transcriptDisplayState({
    hasError: error !== null,
    isPending: isPending || view === null,
    terminal,
    terminalCatchUpComplete: view?.terminalCatchUpComplete ?? false,
  });
  const entries = view?.entries ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest item while the run is live; a finished run
  // keeps whatever scroll position the user left it at.
  useEffect(() => {
    if (fill && !terminal && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [fill, terminal, entries.length]);

  return (
    <div
      id={transcriptId}
      role="region"
      aria-label="Child transcript"
      className={cn(
        "rounded-md border border-border/60 bg-background/60",
        fill ? "flex h-full min-h-0 flex-col border-x-0 border-t-0 rounded-none" : "mx-1.5 mb-1",
      )}
      data-transcript-state={displayState}
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <span className="text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
          Child transcript
        </span>
        <span className="font-mono text-[.65rem] text-muted-foreground/70">
          {terminal ? "finalized" : "live"}
        </span>
      </div>
      <div
        ref={scrollRef}
        className={cn("overflow-auto p-2", fill ? "min-h-0 flex-1" : "max-h-80")}
      >
        {displayState === "error" ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            Could not load the child transcript.
          </p>
        ) : null}
        {displayState === "loading" && entries.length === 0 ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading child transcript…
          </p>
        ) : null}
        {displayState === "loading" && entries.length > 0 ? (
          <p role="status" className="mb-2 text-[.65rem] text-muted-foreground">
            {terminal ? "Finishing transcript…" : "Refreshing transcript…"}
          </p>
        ) : null}
        {entries.length > 0 ? (
          <div className="flex flex-col gap-2">
            {entries.map((entry) => {
              if ("fromSequence" in entry) {
                return (
                  <p
                    key={`${entry.kind}-${entry.fromSequence}-${entry.toSequence}`}
                    role="note"
                    data-transcript-marker={entry.kind}
                    className="border-l border-border px-2 text-[.7rem] text-muted-foreground"
                  >
                    {transcriptMarkerText(entry.kind, entry.fromSequence, entry.toSequence)}
                  </p>
                );
              }

              const flags = transcriptFlagLabels(entry);
              const label =
                entry.kind === "toolResult"
                  ? "Tool result"
                  : entry.kind === "user"
                    ? "User"
                    : "Assistant";
              return (
                <article
                  key={`${entry.kind}-${entry.transcriptSequence}`}
                  data-transcript-entry={entry.kind}
                  data-sequence={entry.transcriptSequence}
                  className="rounded-sm border border-border/50 px-2 py-1.5"
                >
                  <div className="mb-1 flex items-center gap-2 text-[.65rem] font-medium text-muted-foreground">
                    <span>{label}</span>
                    {flags.map((flag) => (
                      <span
                        key={flag}
                        className="rounded-sm border border-warning/40 px-1 text-warning-foreground"
                      >
                        {flag}
                      </span>
                    ))}
                  </div>
                  <p className="whitespace-pre-wrap break-words text-xs text-foreground/90">
                    {entry.text}
                  </p>
                </article>
              );
            })}
          </div>
        ) : null}
        {displayState === "ready" && entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">No finalized transcript items.</p>
        ) : null}
        {displayState === "ready" && view?.hasOlder ? (
          <button
            type="button"
            disabled={view.isLoadingOlder}
            onClick={() => {
              orchestrationEnvironment.requestOlderSubagentTranscript({
                environmentId,
                input: { threadId, runId },
              });
            }}
            className="mt-2 rounded-sm border border-border/60 px-2 py-1 text-[.7rem] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
          >
            {view.isLoadingOlder ? "Loading older…" : "Load older"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Agent status row. Clicking it opens the agent's own session detail view. */
function AgentRow({
  agent,
  onSelect,
}: {
  agent: RuntimeSubagent;
  onSelect: (agentId: string) => void;
}) {
  const visuals = STATUS_VISUALS[agent.status];
  const activity = agentActivityText(agent);
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  const historyLabel =
    agent.historyAvailability === "summary-only"
      ? "Child transcript detail unavailable"
      : agent.historyAvailability === "unavailable"
        ? "History unavailable"
        : agent.historyAvailability === "durable"
          ? "History available"
          : null;
  const controlLabel =
    agent.controlAvailability === "owner-routed"
      ? "Controls available"
      : agent.controlAvailability === "read-only"
        ? "Read-only"
        : agent.controlAvailability === "unsupported"
          ? "Controls unsupported"
          : null;
  const metadata = [
    agent.runNumber !== undefined ? `#${agent.runNumber}` : null,
    modelLabel,
    historyLabel,
    controlLabel,
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok",
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
    agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  ].filter((value): value is string => value !== null);

  return (
    <button
      type="button"
      onClick={() => onSelect(agent.id)}
      className="grid h-[3.875rem] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <StatusDot status={agent.status} />
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{agent.title}</span>
        {role ? (
          <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-[.65rem] text-muted-foreground">
            {role}
          </span>
        ) : null}
      </span>
      <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-[.7rem] text-muted-foreground/80">
        <span className="inline-flex items-center gap-1">
          <AgentElapsed agent={agent} />
          {agent.status === "completed" ? (
            <Check aria-hidden className="size-3 text-success" />
          ) : null}
          <ChevronRight aria-hidden className="size-3 text-muted-foreground/60" />
        </span>
      </span>
      <span
        className={cn(
          "col-start-2 col-end-4 row-start-2 block truncate text-xs",
          agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {activity ?? visuals.label}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
        {metadata.join(" · ")}
      </span>
      <span className="sr-only">{visuals.label}</span>
    </button>
  );
}

const BACKGROUND_STATUS_DOT: Record<RuntimeBackgroundProcess["status"], string> = {
  running: "bg-info",
  completed: "bg-success",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/60",
};

/** Short status label for a settled background process: "exit N" from detail, else a status fallback. */
export function backgroundStatusLabel(
  status: RuntimeBackgroundProcess["status"],
  detail: string | null | undefined,
): string {
  const exitMatch = detail?.match(/exit code (-?\d+)/i);
  if (exitMatch) {
    return `exit ${exitMatch[1]}`;
  }
  return status === "failed" ? "failed" : status === "stopped" ? "stopped" : "done";
}

/** Background command/watch-loop row: same visual language as AgentRow, no click-through. */
function BackgroundProcessRow({ process }: { process: RuntimeBackgroundProcess }) {
  const elapsed = elapsedBetween(
    process.startedAt,
    process.status === "running" ? null : process.endedAt,
  );
  const statusText =
    process.status === "running"
      ? elapsed
      : [backgroundStatusLabel(process.status, process.detail), elapsed]
          .filter(Boolean)
          .join(" · ");
  return (
    <div
      className="grid w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] items-start gap-x-2 rounded-md px-1.5 py-1"
      title={process.detail ?? undefined}
    >
      <span className="flex items-center pt-0.5">
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", BACKGROUND_STATUS_DOT[process.status])}
        />
      </span>
      <span className="min-w-0 whitespace-pre-wrap break-words font-mono text-xs font-medium">
        {process.title}
      </span>
      <span className="min-w-14 whitespace-nowrap pt-0.5 text-right font-mono text-[.7rem] tabular-nums text-muted-foreground/80">
        {statusText}
      </span>
    </div>
  );
}

function workflowIsLive(group: AgentPanelWorkflowGroup): boolean {
  const status = group.workflow.status;
  return (
    status !== "completed" &&
    status !== "failed" &&
    status !== "cancelled" &&
    status !== "interrupted"
  );
}

function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

/**
 * Phase rail: the run's shape at a glance. One segment per phase in order,
 * separated by chevrons; each segment shows title + one dot per member.
 * The whole arc (done → live → pending) is visible without scrolling the
 * member list.
 */
function PhaseRail({ group }: { group: AgentPanelWorkflowGroup }) {
  if (group.phases.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-1.5 pb-1 pt-1.5">
      {group.phases.map((phase, index) => (
        <div key={phase.index} className="flex items-center gap-1">
          {index > 0 ? (
            <ChevronRight aria-hidden className="size-3 text-muted-foreground/40" />
          ) : null}
          <div
            className={cn(
              "flex items-center gap-1 rounded-sm border px-1.5 py-0.5",
              phase.state === "running"
                ? "border-info/40"
                : phase.state === "done"
                  ? "border-success/30"
                  : "border-border/50",
            )}
          >
            <span
              className={cn(
                "font-mono text-[.65rem]",
                phase.state === "running"
                  ? "text-info-foreground"
                  : phase.state === "done"
                    ? "text-success-foreground"
                    : "text-muted-foreground/70",
              )}
            >
              {phase.state === "done" ? "✓ " : ""}
              {phase.title}
            </span>
            <span className="flex items-center gap-0.5">
              {phase.members.length === 0 ? (
                <span className="font-mono text-[.6rem] text-muted-foreground/50">–</span>
              ) : (
                phase.members.map((member) => <StatusDot key={member.id} status={member.status} />)
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Read-only workflow script viewer, fetched through the contained
 * getWorkflowScript RPC (never a raw filesystem read from the client).
 */
function WorkflowScriptView({
  environmentId,
  threadId,
  scriptPath,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  scriptPath: string;
  onClose: () => void;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.workflowScript({ environmentId, input: { threadId, scriptPath } }),
  );
  return (
    <div className="mx-1.5 mb-1 rounded-md border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <Braces aria-hidden className="size-3 text-muted-foreground" />
        <span className="truncate font-mono text-[.65rem] text-muted-foreground">
          {scriptPath.split("/").at(-1)}
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onClose}
          aria-label="Close script"
          className="ml-auto"
        >
          <X aria-hidden className="size-3" />
        </Button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {result._tag === "Success" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-foreground/90">
            {result.value.contents}
            {result.value.truncated ? "\n… (truncated)" : ""}
          </pre>
        ) : result._tag === "Failure" ? (
          <p className="text-xs text-destructive-foreground">Could not load the script.</p>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </div>
    </div>
  );
}

/**
 * Collapsible phase section. A phase opens when it becomes active, then keeps
 * that shape as it settles so completion never yanks rows out from under the
 * user. Manual toggles stick until a later activation begins.
 */
function PhaseSection({
  phase,
  defaultOpen = false,
  onSelect,
}: {
  phase: AgentPanelWorkflowGroup["phases"][number];
  defaultOpen?: boolean;
  onSelect: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen || phase.state === "running");
  const previousState = useRef(phase.state);

  useEffect(() => {
    if (previousState.current !== "running" && phase.state === "running") {
      setOpen(true);
    }
    previousState.current = phase.state;
  }, [phase.state]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "mt-2 flex w-full items-center gap-1.5 rounded-sm px-1.5 text-left text-[.65rem] font-medium uppercase tracking-wider hover:bg-accent/40",
          phase.state === "done"
            ? "text-success-foreground"
            : phase.state === "running"
              ? "text-info-foreground"
              : "text-muted-foreground/70",
        )}
      >
        {open ? (
          <ChevronDown aria-hidden className="size-3 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-3 shrink-0" />
        )}
        {phase.state === "done" ? <Check aria-hidden className="size-3" /> : null}
        <span>{phase.title}</span>
        <span className="font-normal normal-case text-muted-foreground/70">
          {phase.state === "pending" && phase.members.length === 0
            ? "pending"
            : phase.state === "done"
              ? `${phase.settledCount} done`
              : `${phase.activeCount} active · ${phase.settledCount} done`}
        </span>
        {!open && phase.members.length > 0 ? (
          <span className="ml-auto flex items-center gap-0.5">
            {phase.members.map((member) => (
              <StatusDot key={member.id} status={member.status} />
            ))}
          </span>
        ) : null}
      </button>
      {open
        ? phase.members.map((member) => (
            <AgentRow key={member.id} agent={member} onSelect={onSelect} />
          ))
        : null}
    </div>
  );
}

/** Expanded workflow: phase rail + full phase tree. */
function ExpandedWorkflowSection({
  group,
  environmentId,
  threadId,
  onCollapse,
  onSelect,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onCollapse: () => void;
  onSelect: (agentId: string) => void;
}) {
  const [scriptOpen, setScriptOpen] = useState(false);
  const members = workflowMembers(group);
  const settled = members.filter(
    (member) =>
      member.status === "completed" ||
      member.status === "failed" ||
      member.status === "cancelled" ||
      member.status === "interrupted",
  ).length;
  const scriptPath = group.workflow.runHandles?.scriptPath;
  const canShowScript = scriptPath !== undefined && environmentId !== null && threadId !== null;
  return (
    <section className="rounded-lg border border-border/50 bg-card/30 p-1.5">
      <div className="flex items-center gap-2 px-1.5 pt-0.5 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        <StatusDot status={group.workflow.status} />
        <span className="min-w-0 truncate">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        {canShowScript ? (
          <button
            type="button"
            onClick={() => setScriptOpen((value) => !value)}
            className={cn(
              "rounded-sm border border-border/60 px-1 font-mono normal-case hover:text-foreground",
              scriptOpen && "text-foreground",
            )}
            aria-expanded={scriptOpen}
          >
            {"{}"} script
          </button>
        ) : null}
        <span className="ml-auto font-mono normal-case text-muted-foreground/80">
          {settled}/{members.length} settled
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onCollapse}
          aria-label="Collapse workflow"
        >
          <ChevronDown aria-hidden className="size-3" />
        </Button>
      </div>
      <PhaseRail group={group} />
      {scriptOpen && canShowScript ? (
        <WorkflowScriptView
          environmentId={environmentId}
          threadId={threadId}
          scriptPath={scriptPath}
          onClose={() => setScriptOpen(false)}
        />
      ) : null}
      {group.phases.map((phase) => (
        <PhaseSection
          key={phase.index}
          phase={phase}
          defaultOpen={!workflowIsLive(group)}
          onSelect={onSelect}
        />
      ))}
      {group.unphasedMembers.map((member) => (
        <AgentRow key={member.id} agent={member} onSelect={onSelect} />
      ))}
      {group.phases.length === 0 && group.unphasedMembers.length === 0 ? (
        <AgentRow agent={group.workflow} onSelect={onSelect} />
      ) : null}
    </section>
  );
}

/**
 * Collapsed workflow: one summary line. The parent owns expansion so a live
 * workflow keeps its shape when it settles.
 */
function CollapsedWorkflowSection({
  group,
  onExpand,
}: {
  group: AgentPanelWorkflowGroup;
  onExpand: () => void;
}) {
  const members = workflowMembers(group);
  const failed = members.filter((member) => member.status === "failed").length;
  // Coordinator usage may already aggregate members (panel-footer rule):
  // count it only when there are no member rows to sum.
  const totalTokens = members.reduce(
    (sum, member) => sum + (member.usage?.totalTokens ?? 0),
    members.length === 0 ? (group.workflow.usage?.totalTokens ?? 0) : 0,
  );
  const elapsed =
    group.workflow.startedAt && group.workflow.completedAt
      ? elapsedBetween(group.workflow.startedAt, group.workflow.completedAt)
      : null;
  return (
    <section>
      <button
        type="button"
        onClick={onExpand}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40"
        aria-expanded={false}
      >
        <StatusDot status={failed > 0 ? "failed" : group.workflow.status} />
        <span className="truncate text-sm">
          {group.workflow.workflowName ?? group.workflow.title}
        </span>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[.7rem] text-muted-foreground/80">
          {failed > 0 ? <span className="text-destructive-foreground">{failed} failed</span> : null}
          <span>{members.length} agents</span>
          <span className="tabular-nums">· {formatSubagentTokenCount(totalTokens)} tok</span>
          {elapsed ? <span className="tabular-nums">· {elapsed}</span> : null}
          <ChevronRight aria-hidden className="size-3" />
        </span>
      </button>
    </section>
  );
}

/** A workflow's open state is presentation state, not a status derivative. */
function WorkflowSection({
  group,
  environmentId,
  threadId,
  onSelect,
}: {
  group: AgentPanelWorkflowGroup;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  onSelect: (agentId: string) => void;
}) {
  const [open, setOpen] = useState(() => workflowIsLive(group));
  return open ? (
    <ExpandedWorkflowSection
      group={group}
      environmentId={environmentId}
      threadId={threadId}
      onCollapse={() => setOpen(false)}
      onSelect={onSelect}
    />
  ) : (
    <CollapsedWorkflowSection group={group} onExpand={() => setOpen(true)} />
  );
}

/**
 * One subagent's own session: its transcript plus a composer to steer it,
 * replacing the roster in the same right-pane surface (mirrors how the Codex
 * app opens a child's own conversation).
 */
export function AgentDetailView({
  agent,
  environmentId,
  threadId,
  onBack,
}: {
  agent: RuntimeSubagent;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onBack: () => void;
}) {
  const transcriptId = useId();
  const visuals = STATUS_VISUALS[agent.status];
  const modelLabel = formatSubagentModelLabel(agent.model, agent.effort);
  const terminal = isTerminalSubagentStatus(agent.status);

  const { data: controlStatus } = useEnvironmentQuery(
    orchestrationEnvironment.subagentControlStatus({ environmentId, input: {} }),
  );
  // One manager owns all of a thread's subagent runs today: resolve it by
  // matching this thread against the live adapters' declared status, rather
  // than a per-run lookup.
  const managerId = useMemo(() => {
    const match = controlStatus?.statuses.find(
      (status) =>
        status.supported && status.threadId === threadId && status.managerId !== undefined,
    );
    return match?.managerId ?? null;
  }, [controlStatus, threadId]);

  const steer = useAtomCommand(orchestrationEnvironment.subagentControlSteer, {
    reportFailure: false,
  });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const disabledReason =
    agent.controlAvailability === "read-only"
      ? "This agent's session is read-only."
      : agent.controlAvailability === "unsupported"
        ? "Sending messages isn't supported for this agent."
        : terminal
          ? "This agent has already finished."
          : managerId === null
            ? "No live session currently owns this agent."
            : null;

  const handleSend = async () => {
    const trimmed = text.trim();
    if (trimmed === "" || managerId === null || sending) return;
    setSending(true);
    setSendError(null);
    const result = await steer({
      environmentId,
      input: { managerId, runId: RuntimeTaskId.make(agent.id), text: trimmed },
    });
    setSending(false);
    if (result._tag === "Success") {
      setText("");
    } else {
      setSendError("Could not send the message. Try again.");
    }
  };

  // Same truthful gate as the roster row's disclosure: only a run stamped
  // "durable" ever has transcript rows to fetch. Most subagents (only
  // PiAdapter stamps this evidence today) are undefined here, not
  // "summary-only" — that reads the same as summary-only: no body to show.
  const canShowTranscript = canShowTranscriptDetail(agent);
  const fallbackSummary = agent.error ?? agent.result;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5">
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onBack}
          aria-label="Back to agents"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
        </Button>
        <StatusDot status={agent.status} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{agent.title}</div>
          <div className="truncate font-mono text-[.7rem] text-muted-foreground/80">
            {[agent.role, modelLabel, visuals.label].filter(Boolean).join(" · ")}
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {canShowTranscript ? (
          <AgentTranscript
            agent={agent}
            environmentId={environmentId}
            threadId={threadId}
            transcriptId={transcriptId}
            fill
          />
        ) : (
          <div className="flex flex-col gap-2 p-3">
            <p className="text-xs text-muted-foreground">
              {agent.historyAvailability === "unavailable"
                ? "History unavailable for this agent."
                : "Child transcript detail unavailable for this agent."}
            </p>
            {terminal && fallbackSummary ? (
              <p className="whitespace-pre-wrap break-words text-xs text-foreground/90">
                {fallbackSummary}
              </p>
            ) : null}
          </div>
        )}
      </div>
      <footer className="border-t border-border/60 p-2">
        {disabledReason ? (
          <p className="mb-1.5 text-[.7rem] text-muted-foreground">{disabledReason}</p>
        ) : null}
        {sendError ? (
          <p role="alert" className="mb-1.5 text-[.7rem] text-destructive-foreground">
            {sendError}
          </p>
        ) : null}
        <div className="flex items-end gap-1.5">
          <Textarea
            size="sm"
            value={text}
            disabled={disabledReason !== null || sending}
            placeholder="Message this agent…"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
          />
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label="Send message"
            disabled={disabledReason !== null || sending || text.trim() === ""}
            onClick={() => void handleSend()}
          >
            <Send aria-hidden className="size-3.5" />
          </Button>
        </div>
      </footer>
    </div>
  );
}

export function AgentsPanel({
  model,
  environmentId = null,
  threadId = null,
}: {
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
}) {
  const allAgents = useMemo(() => {
    const list: Array<RuntimeSubagent> = [...model.directAgents];
    for (const group of model.workflows) {
      list.push(group.workflow, ...workflowMembers(group));
    }
    return list;
  }, [model]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const selectedAgent = selectedAgentId
    ? (allAgents.find((agent) => agent.id === selectedAgentId) ?? null)
    : null;

  // The selected agent can vanish from the model (roster eviction, thread
  // switch): fall back to the roster rather than showing a stale detail view.
  useEffect(() => {
    if (selectedAgentId !== null && selectedAgent === null) {
      setSelectedAgentId(null);
    }
  }, [selectedAgentId, selectedAgent]);

  if (selectedAgent !== null && environmentId !== null && threadId !== null) {
    return (
      <AgentDetailView
        agent={selectedAgent}
        environmentId={environmentId}
        threadId={threadId}
        onBack={() => setSelectedAgentId(null)}
      />
    );
  }

  if (!model.hasAgents) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns subagents, runs a workflow, or launches a background command, they
          show up here with live status, activity, and token usage.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-2">
          {model.workflows.map((group) => (
            <WorkflowSection
              key={group.workflow.id}
              group={group}
              environmentId={environmentId}
              threadId={threadId}
              onSelect={setSelectedAgentId}
            />
          ))}
          {model.directAgents.length > 0 ? (
            <section>
              <div className="px-1.5 pt-1 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
                Direct spawns
              </div>
              {model.directAgents.map((agent) => (
                <AgentRow key={agent.id} agent={agent} onSelect={setSelectedAgentId} />
              ))}
            </section>
          ) : null}
          {model.backgroundProcesses.length > 0 ? (
            <section>
              <div className="px-1.5 pt-1 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
                Background processes
              </div>
              {model.backgroundProcesses.map((process) => (
                <BackgroundProcessRow key={process.id} process={process} />
              ))}
            </section>
          ) : null}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-[.7rem] text-muted-foreground">
        <span className="flex items-center gap-2">
          {model.runningCount + model.waitingCount + model.liveBackgroundCount > 0 ? (
            <span className="text-info-foreground">
              ● {model.runningCount + model.waitingCount + model.liveBackgroundCount} working
            </span>
          ) : null}
          {model.idleCount > 0 ? <span>{model.idleCount} idle</span> : null}
          {model.settledCount > 0 ? <span>{model.settledCount} settled</span> : null}
        </span>
        <span className="tabular-nums">Σ {formatSubagentTokenCount(model.totalTokens)} tok</span>
      </footer>
    </div>
  );
}
