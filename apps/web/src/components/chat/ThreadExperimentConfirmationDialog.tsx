import type { ThreadExperimentPreview } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  canConfirmThreadExperiment,
  formatThreadExperimentArgv,
  threadExperimentMetricLabel,
  type ThreadExperimentConfirmationState,
} from "./threadExperimentConfirmation";

const EXPIRY_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

function ConfigRow(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-3">
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 break-words text-foreground">{props.children}</dd>
    </div>
  );
}

function CommandList(props: {
  readonly commands: ReadonlyArray<{
    readonly name?: string;
    readonly argv: ReadonlyArray<string>;
  }>;
}) {
  return (
    <ul className="space-y-1">
      {props.commands.map((command, index) => (
        <li key={`${command.name ?? "command"}:${index}`}>
          {command.name ? <span className="me-2 text-muted-foreground">{command.name}</span> : null}
          <code className="break-all font-mono text-[0.7rem]">
            {formatThreadExperimentArgv(command.argv)}
          </code>
        </li>
      ))}
    </ul>
  );
}

function ReviewedConfiguration(props: { readonly preview: ThreadExperimentPreview }) {
  const { preview } = props;
  const limits = preview.limits;
  return (
    <dl className="space-y-2 text-xs">
      <ConfigRow label="Working directory">
        <code className="font-mono">{preview.cwd}</code>
      </ConfigRow>
      <ConfigRow label="Branch">
        <code className="font-mono">{preview.branch}</code>
      </ConfigRow>
      <ConfigRow label="HEAD">
        <code className="font-mono">{preview.head}</code>
      </ConfigRow>
      <ConfigRow label="Config digest">
        <code className="font-mono">{preview.configDigest}</code>
      </ConfigRow>
      <ConfigRow label="Provider">
        <span>
          {preview.provider.instanceId} ({preview.provider.driver}) ·{" "}
          {preview.provider.supported ? "supported" : "not supported"}
          {preview.provider.reason ? `: ${preview.provider.reason}` : ""}
        </span>
      </ConfigRow>
      <ConfigRow label="Approved files">
        <ul className="space-y-0.5">
          {preview.approvedFiles.map((path) => (
            <li key={path}>
              <code className="font-mono">{path}</code>
            </li>
          ))}
        </ul>
      </ConfigRow>
      <ConfigRow label="Evaluator">
        <CommandList commands={[preview.evaluator]} />
      </ConfigRow>
      <ConfigRow label="Metric">{threadExperimentMetricLabel(preview.evaluator.metric)}</ConfigRow>
      <ConfigRow label="Checks">
        {preview.checks.length > 0 ? <CommandList commands={preview.checks} /> : <span>None</span>}
      </ConfigRow>
      <ConfigRow label="Run limits">
        {limits.maxExperiments} experiments · {limits.maxTotalSeconds}s total
      </ConfigRow>
      <ConfigRow label="Command timeouts">
        evaluator {limits.evaluatorTimeoutSeconds}s · each check {limits.checkTimeoutSeconds}s
      </ConfigRow>
      <ConfigRow label="Output limits">
        evaluator {limits.maxEvaluatorOutputBytes.toLocaleString()} bytes · each check{" "}
        {limits.maxCheckOutputBytes.toLocaleString()} bytes
      </ConfigRow>
      <ConfigRow label="Apply limits">
        {limits.maxFilesPerApply} files · {limits.maxBytesPerFile.toLocaleString()} bytes per file ·{" "}
        {limits.maxTotalApplyBytes.toLocaleString()} bytes total
      </ConfigRow>
      <ConfigRow label="Preview expires">
        {EXPIRY_FORMAT.format(new Date(preview.expiresAt))}
      </ConfigRow>
    </dl>
  );
}

/** Review gate for `/goal experiment`; the caller owns the transient state and RPCs. */
export function ThreadExperimentConfirmationDialog(props: {
  readonly state: ThreadExperimentConfirmationState;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { state } = props;
  const canConfirm = canConfirmThreadExperiment(state);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !state.confirming) props.onCancel();
      }}
    >
      <DialogPopup className="max-w-2xl" showCloseButton={!state.confirming}>
        <DialogHeader>
          <DialogTitle>Review experiment</DialogTitle>
          <DialogDescription>
            T3 Code will use only this pinned configuration. Starting consumes a one-shot
            confirmation.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4" scrollFade>
          <section aria-labelledby="experiment-objective-heading" className="space-y-1">
            <h3
              id="experiment-objective-heading"
              className="text-xs font-medium text-muted-foreground"
            >
              Objective
            </h3>
            <p className="text-sm text-foreground">{state.objective}</p>
          </section>
          <section aria-labelledby="experiment-config-heading" className="space-y-2">
            <h3 id="experiment-config-heading" className="text-sm font-medium text-foreground">
              Reviewed configuration
            </h3>
            <ReviewedConfiguration preview={state.preview} />
          </section>
          {!state.preview.provider.supported ? (
            <p role="alert" className="text-sm text-destructive">
              This provider cannot run experiments
              {state.preview.provider.reason ? `: ${state.preview.provider.reason}` : "."}
            </p>
          ) : null}
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={state.confirming} onClick={props.onCancel}>
            Cancel
          </Button>
          <Button autoFocus disabled={!canConfirm} onClick={props.onConfirm}>
            {state.confirming ? "Starting…" : "Confirm and start"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
