import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  type ProjectSchedule,
  type ProjectScheduleCadence,
  type ProjectScheduleWeekday,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { cn, newMessageId, newThreadId, randomUUID } from "../../lib/utils";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { projectEnvironment } from "../../state/projects";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { DEFAULT_RUNTIME_MODE } from "../../types";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { type ModelEsque } from "../chat/providerIconUtils";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { useSettingsScope } from "./SettingsScopeContext";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME, SettingsRow, SettingsSection } from "./settingsLayout";
import { useScopedSettings } from "./useScopedSettings";

const WEEKDAY_LABELS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS: readonly ProjectScheduleWeekday[] = [0, 1, 2, 3, 4, 5, 6];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Short human cadence label for a schedule row, e.g. "Weekly Mon, Wed at 18:00". */
export function scheduleCadenceLabel(cadence: ProjectScheduleCadence): string {
  if (cadence.kind === "hourly") return "Hourly at :" + String(cadence.minute).padStart(2, "0");
  if (cadence.kind === "daily") return "Daily at " + cadence.time;
  const days = [...cadence.weekdays]
    .sort((a, b) => a - b)
    .map((weekday) => WEEKDAY_LABELS[weekday])
    .join(", ");
  return "Weekly " + days + " at " + cadence.time;
}

function reportFailure(title: string, failure: AtomCommandResult<unknown, unknown>): void {
  if (failure._tag !== "Failure") return;
  const error = squashAtomCommandFailure(failure);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

type ScheduleEditor =
  | { kind: "add" }
  | { kind: "edit"; schedule: ProjectSchedule }
  | { kind: "closed" };

/**
 * Edit the recurring prompts of the project the settings scope points at.
 * Schedules are stored on the project record per environment (like scripts),
 * so every edit replaces the list via project.meta.update.
 */
export function ProjectSchedulesSection() {
  const { scope, targets, target } = useSettingsScope();
  const { environments } = useEnvironments();
  const navigate = useNavigate();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });

  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [editor, setEditor] = useState<ScheduleEditor>({ kind: "closed" });

  // Schedules live on one physical project per environment; edit the copy on
  // the representative target rather than fanning out, because each server
  // fires its own list and duplicating would run the prompt once per machine.
  const member =
    target?.projectId != null
      ? (scope.members.find(
          (candidate) =>
            candidate.environmentId === target.environmentId && candidate.id === target.projectId,
        ) ?? null)
      : null;
  const schedules = member?.schedules ?? [];

  const representativeEnvironment =
    target != null
      ? environments.find((entry) => entry.environmentId === target.environmentId)
      : undefined;
  const providers = representativeEnvironment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const settings = useScopedSettings();
  const defaultModelSelection = resolveDefaultProviderModelSelection(
    providers,
    settings.defaultModelSelection,
  );
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    defaultModelSelection?.instanceId,
    defaultModelSelection?.model,
  );
  const modelsAvailable = instanceEntries.length > 0 && defaultModelSelection !== null;

  async function save(next: readonly ProjectSchedule[]): Promise<boolean> {
    if (member === null || saving) return false;
    setSaving(true);
    const result = await updateProject({
      environmentId: member.environmentId,
      input: { projectId: member.id, schedules: [...next] },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) reportFailure("Failed to save schedules", result);
      return false;
    }
    return true;
  }

  // Run now does by hand what the server-side scheduler does on fire: create
  // a thread in the project and start its first turn with the schedule prompt
  // and model, then follow the new thread.
  async function runNow(schedule: ProjectSchedule): Promise<void> {
    if (member === null || runningId !== null) return;
    setRunningId(schedule.id);
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const createResult = await createThread({
      environmentId: member.environmentId,
      input: {
        threadId,
        projectId: member.id,
        title: schedule.name,
        modelSelection: schedule.modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt,
      },
    });
    let failure: AtomCommandResult<unknown, unknown> | null = null;
    if (createResult._tag === "Failure") {
      failure = createResult;
    } else {
      const startResult = await startThreadTurn({
        environmentId: member.environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: schedule.prompt,
            attachments: [],
          },
          modelSelection: schedule.modelSelection,
          titleSeed: schedule.name,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt,
        },
      });
      if (startResult._tag === "Failure") {
        failure = startResult;
        const cleanup = await deleteThread({
          environmentId: member.environmentId,
          input: { threadId },
        });
        if (cleanup._tag === "Failure" && !isAtomCommandInterrupted(cleanup)) {
          console.warn("Failed to clean up schedule thread after start failure.", cleanup);
        }
      }
    }
    setRunningId(null);
    if (failure !== null) {
      if (!isAtomCommandInterrupted(failure)) {
        reportFailure("Could not run " + schedule.name, failure);
      }
      return;
    }
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: member.environmentId, threadId },
    });
  }

  const disabled = saving || member === null;

  return (
    <SettingsSection
      id="project-schedules"
      title="Schedules"
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || !modelsAvailable}
          onClick={() => setEditor({ kind: "add" })}
        >
          <PlusIcon className="size-3.5" />
          Add schedule
        </Button>
      }
    >
      {targets.length > 1 ? (
        <SettingsRow
          title="Multiple environments selected"
          description={
            "Schedules are stored per environment; these edit the " +
            (target?.label ?? "representative") +
            " copy."
          }
        />
      ) : null}
      {schedules.length === 0 ? (
        <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">No schedules yet.</p>
      ) : null}
      {schedules.map((schedule) => (
        <SettingsRow
          key={schedule.id}
          className="group py-2"
          title={
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate">{schedule.name}</span>
              {!schedule.enabled ? (
                <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-px text-[11px] font-normal text-muted-foreground">
                  paused
                </span>
              ) : null}
            </span>
          }
          description={scheduleCadenceLabel(schedule.cadence)}
          control={
            <div className="flex items-center gap-1.5">
              <Switch
                checked={schedule.enabled}
                disabled={disabled}
                aria-label={"Enable " + schedule.name}
                onCheckedChange={(checked) => {
                  void save(
                    schedules.map((entry) =>
                      entry.id === schedule.id ? { ...entry, enabled: Boolean(checked) } : entry,
                    ),
                  );
                }}
              />
              <Button
                size="xs"
                variant="outline"
                disabled={disabled}
                aria-label={"Edit " + schedule.name}
                onClick={() => setEditor({ kind: "edit", schedule })}
              >
                Edit
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={disabled || runningId !== null}
                onClick={() => void runNow(schedule)}
              >
                {runningId === schedule.id ? "Starting…" : "Run now"}
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                className="shrink-0 text-muted-foreground"
                disabled={disabled}
                aria-label={"Delete " + schedule.name}
                onClick={() => {
                  void save(schedules.filter((entry) => entry.id !== schedule.id));
                }}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          }
        />
      ))}
      {editor.kind !== "closed" ? (
        <ProjectScheduleEditorDialog
          key={editor.kind === "edit" ? editor.schedule.id : "add"}
          schedule={editor.kind === "edit" ? editor.schedule : null}
          defaultModelSelection={defaultModelSelection}
          instanceEntries={instanceEntries}
          modelOptionsByInstance={modelOptionsByInstance}
          disabled={disabled}
          onSubmit={async (schedule) => {
            const exists = schedules.some((entry) => entry.id === schedule.id);
            const next = exists
              ? schedules.map((entry) => (entry.id === schedule.id ? schedule : entry))
              : [...schedules, schedule];
            return save(next);
          }}
          onClose={() => setEditor({ kind: "closed" })}
        />
      ) : null}
    </SettingsSection>
  );
}

/**
 * Add/edit dialog for one schedule, mirroring the project actions editor:
 * the parent owns which schedule is open (schedule = null means add); the
 * dialog owns form state and validation and submits a whole ProjectSchedule.
 */
function ProjectScheduleEditorDialog({
  schedule,
  defaultModelSelection,
  instanceEntries,
  modelOptionsByInstance,
  disabled,
  onSubmit,
  onClose,
}: {
  schedule: ProjectSchedule | null;
  defaultModelSelection: ModelSelection | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  disabled: boolean;
  onSubmit: (schedule: ProjectSchedule) => Promise<boolean>;
  onClose: () => void;
}) {
  const isEditing = schedule !== null;
  const [name, setName] = useState(schedule?.name ?? "");
  const [prompt, setPrompt] = useState(schedule?.prompt ?? "");
  const [kind, setKind] = useState<ProjectScheduleCadence["kind"]>(
    schedule?.cadence.kind ?? "daily",
  );
  const [minute, setMinute] = useState(
    schedule?.cadence.kind === "hourly" ? String(schedule.cadence.minute) : "0",
  );
  const [time, setTime] = useState(
    schedule?.cadence.kind !== "hourly" ? (schedule?.cadence.time ?? "09:00") : "09:00",
  );
  const [weekdays, setWeekdays] = useState<ProjectScheduleWeekday[]>(
    schedule?.cadence.kind === "weekly"
      ? [...schedule.cadence.weekdays].sort((a, b) => a - b)
      : [1],
  );
  const [model, setModel] = useState<ModelSelection | null>(
    schedule?.modelSelection ?? defaultModelSelection,
  );
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [timeZone] = useState(
    () => schedule?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isBusy = isSubmitting || disabled;

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (isBusy) return;
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (trimmedName.length === 0) {
      setValidationError("Name is required.");
      return;
    }
    if (trimmedPrompt.length === 0) {
      setValidationError("Prompt is required.");
      return;
    }
    if (model === null) {
      setValidationError("Select a model.");
      return;
    }
    let cadence: ProjectScheduleCadence;
    if (kind === "hourly") {
      const parsed = Number(minute);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 59) {
        setValidationError("Minute must be a number from 0 to 59.");
        return;
      }
      cadence = { kind: "hourly", minute: parsed };
    } else if (!TIME_PATTERN.test(time)) {
      setValidationError("Enter a time of day.");
      return;
    } else if (kind === "daily") {
      cadence = { kind: "daily", time };
    } else {
      if (weekdays.length === 0) {
        setValidationError("Pick at least one weekday.");
        return;
      }
      cadence = { kind: "weekly", weekdays: [...weekdays].sort((a, b) => a - b), time };
    }
    const next: ProjectSchedule = {
      ...(schedule ?? { id: randomUUID() }),
      name: trimmedName,
      prompt: trimmedPrompt,
      cadence,
      timeZone: schedule?.timeZone ?? timeZone,
      modelSelection: model,
      enabled,
    };
    setIsSubmitting(true);
    const saved = await onSubmit(next);
    setIsSubmitting(false);
    if (saved) onClose();
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSubmitting) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit Schedule" : "Add Schedule"}</DialogTitle>
          <DialogDescription>
            A recurring prompt that starts a new thread in this project on its schedule.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form id="project-schedule-form" onSubmit={(event) => void submit(event)}>
            <fieldset className="space-y-4" disabled={isBusy}>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-name">Name</Label>
                <Input
                  id="schedule-name"
                  autoFocus
                  placeholder="Nightly sync"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-prompt">Prompt</Label>
                <Textarea
                  id="schedule-prompt"
                  placeholder="What should the agent do each time this schedule fires?"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="schedule-kind">Repeats</Label>
                  <Select
                    value={kind}
                    onValueChange={(value) => {
                      if (value === "hourly" || value === "daily" || value === "weekly")
                        setKind(value);
                    }}
                  >
                    <SelectTrigger id="schedule-kind" size="sm" aria-label="Cadence">
                      <SelectValue>
                        {kind === "hourly" ? "Hourly" : kind === "daily" ? "Daily" : "Weekly"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="start" alignItemWithTrigger={false}>
                      <SelectItem value="hourly">Hourly</SelectItem>
                      <SelectItem value="daily">Daily</SelectItem>
                      <SelectItem value="weekly">Weekly</SelectItem>
                    </SelectPopup>
                  </Select>
                </div>
                {kind === "hourly" ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="schedule-minute">Minute</Label>
                    <Input
                      id="schedule-minute"
                      type="number"
                      min={0}
                      max={59}
                      value={minute}
                      onChange={(event) => setMinute(event.target.value)}
                    />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="schedule-time">Time</Label>
                    <Input
                      id="schedule-time"
                      type="time"
                      value={time}
                      onChange={(event) => setTime(event.target.value)}
                    />
                  </div>
                )}
              </div>
              {kind === "weekly" ? (
                <div className="space-y-1.5">
                  <Label>Weekdays</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((weekday, index) => {
                      const selected = weekdays.some((entry) => entry === weekday);
                      return (
                        <button
                          key={weekday}
                          type="button"
                          className={cn(
                            "rounded-md border px-2 py-1 text-xs",
                            selected
                              ? "border-primary/70 bg-primary/10"
                              : "border-border/70 text-muted-foreground hover:bg-accent/60",
                          )}
                          aria-pressed={selected}
                          aria-label={WEEKDAY_LABELS[index]}
                          onClick={() =>
                            setWeekdays((current) =>
                              current.some((entry) => entry === weekday)
                                ? current.filter((entry) => entry !== weekday)
                                : [...current, weekday],
                            )
                          }
                        >
                          {WEEKDAY_LABELS[index]}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null}
              <div className="space-y-1.5">
                <Label>Model</Label>
                {model !== null && instanceEntries.length > 0 ? (
                  <ProviderModelPicker
                    activeInstanceId={model.instanceId}
                    model={model.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    triggerVariant="outline"
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    triggerAriaLabel="Schedule model"
                    onInstanceModelChange={(instanceId, nextModel) =>
                      setModel(createModelSelection(instanceId, nextModel))
                    }
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">No models available.</p>
                )}
              </div>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border/70 px-3 py-2 text-sm dark:border-transparent dark:bg-white/[0.035]">
                <span>Enabled</span>
                <Switch
                  checked={enabled}
                  onCheckedChange={(checked) => setEnabled(Boolean(checked))}
                />
              </label>
              <p className="text-xs text-muted-foreground">Times are in {timeZone}.</p>
              {validationError && <p className="text-sm text-destructive">{validationError}</p>}
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter className="dark:border-transparent dark:bg-transparent">
          <Button type="button" variant="outline" disabled={isSubmitting} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="project-schedule-form"
            disabled={isBusy || model === null || instanceEntries.length === 0}
          >
            {isSubmitting ? "Saving…" : isEditing ? "Save changes" : "Add schedule"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
