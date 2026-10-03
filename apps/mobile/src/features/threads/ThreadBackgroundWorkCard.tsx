import type { ThreadBackgroundTask } from "@t3tools/client-runtime/state/thread-background-work";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";

function taskLabel(item: ThreadBackgroundTask): string {
  return item.task.description?.trim() || item.task.kind.replaceAll("_", " ");
}

export function ThreadBackgroundWorkCard(props: {
  readonly work: ReadonlyArray<ThreadBackgroundTask>;
  readonly onStop: (taskId: string) => void;
}) {
  if (props.work.length === 0) return null;

  return (
    <View className="mx-3 mb-2 overflow-hidden rounded-2xl bg-grouped-card">
      <Text className="px-4 pb-1 pt-3 text-xs font-t3-bold text-foreground-muted">
        Background work ({props.work.length})
      </Text>
      {props.work.map((item) => (
        <View
          key={item.task.taskId}
          className="min-h-11 flex-row items-center gap-3 border-t border-border-subtle px-4 py-2"
        >
          <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={2}>
            {taskLabel(item)}
          </Text>
          {item.canStop ? (
            <Pressable
              accessibilityRole="button"
              className="rounded-full bg-danger px-3 py-2 active:opacity-70"
              onPress={() => props.onStop(item.task.taskId)}
            >
              <Text className="text-xs font-t3-bold text-danger-foreground">Stop</Text>
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  );
}
