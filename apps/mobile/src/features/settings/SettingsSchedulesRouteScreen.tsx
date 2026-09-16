import type {
  ModelSelection,
  ProjectSchedule,
  ProjectScheduleCadence,
  ProjectScheduleWeekday,
} from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import type { ReactNode } from "react";
import { useNavigation } from "@react-navigation/native";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ControlPillMenu } from "../../components/ControlPill";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { uuidv4 } from "../../lib/uuid";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

const WEEKDAY_NAMES: Record<ProjectScheduleWeekday, string> = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};
const WEEKDAY_LETTERS: Record<ProjectScheduleWeekday, string> = {
  0: "S",
  1: "M",
  2: "T",
  3: "W",
  4: "T",
  5: "F",
  6: "S",
};
const WEEKDAYS: ReadonlyArray<ProjectScheduleWeekday> = [0, 1, 2, 3, 4, 5, 6];
const CADENCE_KINDS: ReadonlyArray<ProjectScheduleCadence["kind"]> = ["hourly", "daily", "weekly"];
const CADENCE_KIND_LABELS: Record<ProjectScheduleCadence["kind"], string> = {
  hourly: "Hourly",
  daily: "Daily",
  weekly: "Weekly",
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function cadenceLabel(cadence: ProjectScheduleCadence): string {
  if (cadence.kind === "hourly") return `Hourly at :${pad2(cadence.minute)}`;
  if (cadence.kind === "daily") return `Daily at ${cadence.time}`;
  return `Weekly ${cadence.weekdays.map((weekday) => WEEKDAY_NAMES[weekday]).join(", ")} at ${cadence.time}`;
}

/** Accepts "H:MM" or "HH:MM" and returns the canonical zero-padded form. */
function normalizeTime(raw: string): string | null {
  const match = raw.trim().match(/^(\d{1,2}):(\d{1,2})$/);
  const hours = match?.[1];
  const minutes = match?.[2];
  if (hours === undefined || minutes === undefined) return null;
  const hour = Number(hours);
  const minute = Number(minutes);
  if (hour > 23 || minute > 59) return null;
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** Editable form state for one schedule; cadence fields stay raw text until save. */
interface ScheduleDraft {
  readonly id: string;
  readonly isNew: boolean;
  /** IANA zone captured at creation; edits keep it so the cadence stays anchored. */
  readonly timeZone: string;
  name: string;
  prompt: string;
  cadenceKind: ProjectScheduleCadence["kind"];
  minuteDraft: string;
  timeDraft: string;
  weekdays: ProjectScheduleWeekday[];
  modelSelection: ModelSelection | null;
  enabled: boolean;
  lastFiredAt: string | null | undefined;
}

function draftFromSchedule(schedule: ProjectSchedule): ScheduleDraft {
  return {
    id: schedule.id,
    isNew: false,
    timeZone: schedule.timeZone,
    name: schedule.name,
    prompt: schedule.prompt,
    cadenceKind: schedule.cadence.kind,
    minuteDraft: schedule.cadence.kind === "hourly" ? String(schedule.cadence.minute) : "0",
    timeDraft: schedule.cadence.kind === "hourly" ? "09:00" : schedule.cadence.time,
    weekdays: schedule.cadence.kind === "weekly" ? [...schedule.cadence.weekdays] : [1],
    modelSelection: schedule.modelSelection,
    enabled: schedule.enabled,
    lastFiredAt: schedule.lastFiredAt,
  };
}

function newDraft(modelSelection: ModelSelection | null, timeZone: string): ScheduleDraft {
  return {
    id: uuidv4(),
    isNew: true,
    timeZone,
    name: "",
    prompt: "",
    cadenceKind: "daily",
    minuteDraft: "0",
    timeDraft: "09:00",
    weekdays: [1],
    modelSelection,
    enabled: true,
    lastFiredAt: undefined,
  };
}

/** Returns null while any field is invalid; the caller keeps the editor open. */
function scheduleFromDraft(draft: ScheduleDraft): ProjectSchedule | null {
  const name = draft.name.trim();
  const prompt = draft.prompt.trim();
  if (name.length === 0 || prompt.length === 0 || draft.modelSelection === null) return null;
  const base = {
    id: draft.id,
    name,
    prompt,
    timeZone: draft.timeZone,
    modelSelection: draft.modelSelection,
    enabled: draft.enabled,
    ...(draft.lastFiredAt === undefined ? {} : { lastFiredAt: draft.lastFiredAt }),
  };
  if (draft.cadenceKind === "hourly") {
    const minute = Number(draft.minuteDraft);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    return { ...base, cadence: { kind: "hourly", minute } };
  }
  const time = normalizeTime(draft.timeDraft);
  if (time === null) return null;
  if (draft.cadenceKind === "daily") return { ...base, cadence: { kind: "daily", time } };
  // The server rejects weekly cadences with duplicate weekdays; dedupe + sort
  // here so the label and the stored list agree.
  const weekdays = [...new Set(draft.weekdays)].sort((a, b) => a - b);
  if (weekdays.length === 0) return null;
  return { ...base, cadence: { kind: "weekly", weekdays, time } };
}

function ProjectSelectionRow(props: {
  readonly value: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
}) {
  return (
    <ControlPillMenu
      accessible
      accessibilityRole="button"
      accessibilityLabel="Select project"
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Select project"
        className="flex-row items-center gap-4 p-4 active:opacity-70"
      >
        <SymbolView
          name="folder"
          size={22}
          tintColorClassName="accent-icon"
          type="monochrome"
          weight="regular"
        />
        <View className="min-w-0 flex-1">
          <Text className="text-lg text-foreground">Project</Text>
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {props.value}
          </Text>
        </View>
        <SymbolView
          name="chevron.right"
          size={16}
          tintColorClassName="accent-chevron"
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
    </ControlPillMenu>
  );
}

function ScheduleRow(props: {
  readonly schedule: ProjectSchedule;
  readonly editable: boolean;
  readonly onEdit: () => void;
  readonly onToggle: (enabled: boolean) => void;
  readonly onDelete: () => void;
}) {
  return (
    <View className="flex-row items-center border-t border-border-subtle first:border-t-0">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Edit ${props.schedule.name}`}
        onPress={props.onEdit}
        className="min-w-0 flex-1 p-4 active:opacity-70"
      >
        <View className="gap-0.5">
          <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
            {props.schedule.name}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {cadenceLabel(props.schedule.cadence)}
          </Text>
        </View>
      </Pressable>
      <ThemedSwitch
        accessibilityLabel={`Enable ${props.schedule.name}`}
        disabled={!props.editable}
        value={props.schedule.enabled}
        onValueChange={props.onToggle}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Delete ${props.schedule.name}`}
        disabled={!props.editable}
        onPress={props.onDelete}
        className="p-4 active:opacity-70 disabled:opacity-30"
      >
        <SymbolView
          name="trash"
          size={18}
          tintColorClassName="accent-danger-foreground"
          type="monochrome"
          weight="regular"
        />
      </Pressable>
    </View>
  );
}

function EditorRow(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="gap-2 border-t border-border-subtle p-4">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      {props.children}
    </View>
  );
}

function MenuRow(props: {
  readonly label: string;
  readonly value: string;
  readonly accessibilityLabel: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
}) {
  return (
    <ControlPillMenu
      accessible
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        className="flex-row items-center gap-3 border-t border-border-subtle p-4 active:opacity-70"
      >
        <Text className="shrink-0 text-sm text-foreground-muted">{props.label}</Text>
        <View className="min-w-0 flex-1 flex-row justify-end">
          <Text className="text-sm text-foreground" numberOfLines={1}>
            {props.value}
          </Text>
        </View>
        <SymbolView
          name="chevron.up.chevron.down"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
          weight="semibold"
        />
      </Pressable>
    </ControlPillMenu>
  );
}

function TogglePill(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly accessibilityLabel: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{ selected: props.selected }}
      onPress={props.onPress}
      className={
        props.selected
          ? "min-h-10 grow items-center justify-center rounded-full bg-primary px-3 active:opacity-70"
          : "min-h-10 grow items-center justify-center rounded-full bg-input px-3 active:opacity-70"
      }
    >
      <Text
        className={
          props.selected ? "text-sm text-primary-foreground" : "text-sm text-foreground-muted"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function SettingsSchedulesRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const [projectSelection, setProjectSelection] = useState<ProjectId | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const updateProject = useAtomCommand(projectEnvironment.update, {
    label: "project schedules update",
    reportFailure: true,
  });

  const projectRows = useMemo(
    () =>
      projects.map((project) => {
        const environment = environments.find(
          (candidate) => candidate.environmentId === project.environmentId,
        );
        return {
          project,
          label: project.title,
          subtitle: environment?.label ?? project.environmentId,
        };
      }),
    [projects, environments],
  );
  const selectedRow =
    projectRows.find((row) => row.project.id === projectSelection) ?? projectRows[0] ?? null;
  const project = selectedRow?.project ?? null;
  const environmentId = project?.environmentId ?? null;
  const connected =
    environments.find((environment) => environment.environmentId === environmentId)?.connection
      .phase === "connected";
  const config = useEnvironmentServerConfig(environmentId);
  const modelOptions = useMemo(
    () => buildModelOptions(config, project?.defaultModelSelection ?? null),
    [config, project?.defaultModelSelection],
  );
  const optionByKey = useMemo(
    () => new Map(modelOptions.map((option) => [option.key, option])),
    [modelOptions],
  );
  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  const modelActions = useMemo<MenuAction[]>(
    () =>
      providerGroups.map((group) => ({
        id: `provider:${group.providerKey}`,
        title: group.providerLabel,
        subactions: group.models.map((option) => ({ id: option.key, title: option.label })),
      })),
    [providerGroups],
  );

  const schedules = project?.schedules ?? [];
  const editable = connected && project !== null && !saving;

  /** Model a new schedule starts from: the project default, else its first available model. */
  const defaultModelSelection = (): ModelSelection | null =>
    project?.defaultModelSelection ??
    modelOptions.find((option) => option.isDefault && !option.isUnavailable)?.selection ??
    modelOptions[0]?.selection ??
    null;

  /** Resolves to true only when the server accepted the whole-list write. */
  const writeSchedules = async (next: ReadonlyArray<ProjectSchedule>): Promise<boolean> => {
    if (environmentId === null || project === null || saving) return false;
    setSaving(true);
    try {
      const result = await updateProject({
        environmentId,
        input: { projectId: project.id, schedules: [...next] },
      });
      return result._tag === "Success";
    } finally {
      setSaving(false);
    }
  };

  const toggleSchedule = (schedule: ProjectSchedule, enabled: boolean) => {
    void writeSchedules(
      schedules.map((entry) => (entry.id === schedule.id ? { ...entry, enabled } : entry)),
    );
  };

  const deleteSchedule = (schedule: ProjectSchedule) => {
    void writeSchedules(schedules.filter((entry) => entry.id !== schedule.id));
  };

  const modelLabel = (selection: ModelSelection | null): string => {
    if (selection === null) return "Select a model";
    const option = optionByKey.get(`${selection.instanceId}:${selection.model}`);
    if (option) return `${option.providerLabel} · ${option.label}`;
    return selection.model;
  };

  const draftValid =
    draft !== null &&
    draft.name.trim().length > 0 &&
    draft.prompt.trim().length > 0 &&
    draft.modelSelection !== null &&
    (draft.cadenceKind !== "hourly" ||
      (Number.isInteger(Number(draft.minuteDraft)) &&
        Number(draft.minuteDraft) >= 0 &&
        Number(draft.minuteDraft) <= 59)) &&
    (draft.cadenceKind === "hourly" || normalizeTime(draft.timeDraft) !== null) &&
    (draft.cadenceKind !== "weekly" || draft.weekdays.length > 0);

  const saveDraft = () => {
    if (draft === null || !draftValid || environmentId === null || project === null) return;
    const schedule = scheduleFromDraft(draft);
    if (schedule === null) return;
    const next = draft.isNew
      ? [...schedules, schedule]
      : schedules.map((entry) => (entry.id === schedule.id ? schedule : entry));
    void writeSchedules(next).then((saved) => {
      if (saved) setDraft(null);
    });
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title="Schedules" onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Scheduled prompts start a new thread with their prompt on a recurring cadence, in the
          schedule's time zone. Select a project to edit its schedules.
        </Text>
        {project === null || selectedRow === null ? (
          <SettingsSection title="Schedules">
            <View className="p-4">
              <Text className="text-base text-foreground">Connect an environment</Text>
              <Text className="mt-1 text-sm leading-normal text-foreground-muted">
                Connect a T3 server to edit its project schedules.
              </Text>
            </View>
          </SettingsSection>
        ) : (
          <>
            <SettingsSection title="Project">
              <ProjectSelectionRow
                value={`${selectedRow.label} · ${selectedRow.subtitle}`}
                actions={projectRows.map((row) => ({
                  id: row.project.id,
                  title: row.label,
                  subtitle: row.subtitle,
                  state: row.project.id === project.id ? ("on" as const) : ("off" as const),
                }))}
                onSelect={(id) => {
                  setProjectSelection(ProjectId.make(id));
                  setDraft(null);
                }}
              />
            </SettingsSection>
            {draft === null ? (
              <SettingsSection title={`Schedules · ${project.title}`}>
                {schedules.length === 0 ? (
                  <View className="p-4">
                    <Text className="text-base text-foreground">No schedules yet.</Text>
                  </View>
                ) : (
                  schedules.map((schedule) => (
                    <ScheduleRow
                      key={schedule.id}
                      schedule={schedule}
                      editable={editable}
                      onEdit={() => setDraft(draftFromSchedule(schedule))}
                      onToggle={(enabled) => toggleSchedule(schedule, enabled)}
                      onDelete={() => deleteSchedule(schedule)}
                    />
                  ))
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Add schedule"
                  disabled={!editable}
                  onPress={() =>
                    setDraft(
                      newDraft(
                        defaultModelSelection(),
                        Intl.DateTimeFormat().resolvedOptions().timeZone,
                      ),
                    )
                  }
                  className="flex-row items-center gap-3 border-t border-border-subtle p-4 active:opacity-70 disabled:opacity-40"
                >
                  <SymbolView
                    name="plus"
                    size={20}
                    tintColorClassName="accent-icon"
                    type="monochrome"
                    weight="regular"
                  />
                  <Text className="text-base font-t3-medium text-link">Add schedule</Text>
                </Pressable>
              </SettingsSection>
            ) : (
              <SettingsSection
                title={`${draft.isNew ? "New schedule" : "Edit schedule"} · ${project.title}`}
              >
                <EditorRow label="Name">
                  <TextInput
                    value={draft.name}
                    placeholder="Nightly triage"
                    accessibilityLabel="Schedule name"
                    onChangeText={(name) => setDraft({ ...draft, name })}
                  />
                </EditorRow>
                <EditorRow label="Prompt">
                  <TextInput
                    value={draft.prompt}
                    placeholder="What should the agent do?"
                    accessibilityLabel="Schedule prompt"
                    multiline
                    onChangeText={(prompt) => setDraft({ ...draft, prompt })}
                  />
                </EditorRow>
                <MenuRow
                  label="Repeats"
                  value={CADENCE_KIND_LABELS[draft.cadenceKind]}
                  accessibilityLabel="Cadence"
                  actions={CADENCE_KINDS.map((kind) => ({
                    id: kind,
                    title: CADENCE_KIND_LABELS[kind],
                    state: kind === draft.cadenceKind ? ("on" as const) : ("off" as const),
                  }))}
                  onSelect={(kind) => {
                    if (kind === "hourly" || kind === "daily" || kind === "weekly") {
                      setDraft({ ...draft, cadenceKind: kind });
                    }
                  }}
                />
                {draft.cadenceKind === "hourly" ? (
                  <EditorRow label="Minute of the hour (0–59)">
                    <TextInput
                      value={draft.minuteDraft}
                      keyboardType="number-pad"
                      returnKeyType="done"
                      accessibilityLabel="Minute of the hour"
                      className="w-24"
                      onChangeText={(minuteDraft) => setDraft({ ...draft, minuteDraft })}
                    />
                  </EditorRow>
                ) : (
                  <EditorRow label="Time (HH:MM)">
                    <TextInput
                      value={draft.timeDraft}
                      keyboardType="numbers-and-punctuation"
                      returnKeyType="done"
                      placeholder="09:30"
                      accessibilityLabel="Time of day"
                      className="w-28"
                      onChangeText={(timeDraft) => setDraft({ ...draft, timeDraft })}
                    />
                  </EditorRow>
                )}
                {draft.cadenceKind === "weekly" ? (
                  <EditorRow label="Days of week">
                    <View className="flex-row gap-2">
                      {WEEKDAYS.map((weekday) => (
                        <TogglePill
                          key={weekday}
                          label={WEEKDAY_LETTERS[weekday]}
                          selected={draft.weekdays.includes(weekday)}
                          accessibilityLabel={WEEKDAY_NAMES[weekday]}
                          onPress={() =>
                            setDraft({
                              ...draft,
                              weekdays: draft.weekdays.includes(weekday)
                                ? draft.weekdays.filter((entry) => entry !== weekday)
                                : [...draft.weekdays, weekday],
                            })
                          }
                        />
                      ))}
                    </View>
                  </EditorRow>
                ) : null}
                <MenuRow
                  label="Model"
                  value={modelLabel(draft.modelSelection)}
                  accessibilityLabel="Schedule model"
                  actions={modelActions}
                  onSelect={(key) => {
                    const option = optionByKey.get(key);
                    if (option) setDraft({ ...draft, modelSelection: option.selection });
                  }}
                />
                <MenuRow
                  label="Enabled"
                  value={draft.enabled ? "On" : "Off"}
                  accessibilityLabel="Schedule enabled"
                  actions={[
                    {
                      id: "on",
                      title: "On",
                      state: draft.enabled ? ("on" as const) : ("off" as const),
                    },
                    {
                      id: "off",
                      title: "Off",
                      state: draft.enabled ? ("off" as const) : ("on" as const),
                    },
                  ]}
                  onSelect={(id) => setDraft({ ...draft, enabled: id === "on" })}
                />
                <EditorRow label="Time zone">
                  <Text className="text-base text-foreground">{draft.timeZone}</Text>
                </EditorRow>
                <View className="flex-row gap-3 p-4">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Save schedule"
                    disabled={!draftValid || saving}
                    onPress={saveDraft}
                    className="h-12 grow items-center justify-center rounded-full bg-primary active:opacity-70 disabled:opacity-45"
                  >
                    <Text className="text-base font-t3-medium text-primary-foreground">Save</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Cancel schedule edits"
                    onPress={() => setDraft(null)}
                    className="h-12 grow items-center justify-center rounded-full bg-input active:opacity-70"
                  >
                    <Text className="text-base font-t3-medium text-foreground-muted">Cancel</Text>
                  </Pressable>
                </View>
              </SettingsSection>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
