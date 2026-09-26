import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Goal, Task } from '@siyue/contracts';
import { AppIcon } from '../../ui';
import { ProgressRing } from '../../ui/progress-ring';
import { useTheme, type Theme } from '../../ui/theme';

/** A checkable task row: 44pt check target, tappable body, due chip on the right. */
export function TaskRow({ title, subtitle, due, dueToday = false, done, onToggle, onOpen, toggleLabel, openLabel, testID }: {
  title: string;
  subtitle?: string;
  due?: string | null;
  dueToday?: boolean;
  done: boolean;
  onToggle: () => void;
  onOpen?: () => void;
  toggleLabel: string;
  openLabel?: string;
  testID?: string;
}) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <View style={styles.task} testID={testID}>
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={toggleLabel}
      accessibilityState={{ checked: done }}
      onPress={onToggle}
      style={({ pressed }) => [styles.check, pressed && styles.pressed]}
    >
      <View style={[styles.circle, done && styles.circleDone]}>
        {done ? <AppIcon name="check" size={14} color={theme.color.onAccent} /> : null}
      </View>
    </Pressable>
    <Pressable
      accessibilityRole={onOpen ? 'button' : undefined}
      accessibilityLabel={onOpen ? openLabel : undefined}
      disabled={!onOpen}
      onPress={onOpen}
      style={styles.taskMain}
    >
      <Text style={[styles.taskTitle, done && styles.taskTitleDone]} numberOfLines={3}>{title}</Text>
      {subtitle ? <Text style={styles.taskSubtitle} numberOfLines={1}>{subtitle}</Text> : null}
    </Pressable>
    {due && !done ? <Text style={[styles.due, dueToday && styles.dueToday]}>{due}</Text> : null}
  </View>;
}

/** Goal card: progress ring, next open task, completed count and target date. */
export function GoalCard({ goal, completed, total, nextTitle, allDoneLabel, dateLabel, openLabel, onPress }: {
  goal: Goal;
  completed: number;
  total: number;
  nextTitle: string | null;
  allDoneLabel: string;
  dateLabel: string | null;
  openLabel: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const ratio = total > 0 ? completed / total : 0;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={openLabel}
    accessibilityValue={{ min: 0, max: total || 1, now: completed, text: `${completed}/${total}` }}
    onPress={onPress}
    style={({ pressed }) => [styles.goalCard, pressed && styles.pressed]}
  >
    <ProgressRing progress={ratio} size={46} stroke={5} />
    <View style={styles.goalMain}>
      <Text style={styles.goalTitle} numberOfLines={2}>{goal.title}</Text>
      <Text style={styles.goalNext} numberOfLines={1}>{nextTitle ?? allDoneLabel}</Text>
    </View>
    <View style={styles.goalMeta}>
      <Text style={styles.goalCount}>{completed}/{total}</Text>
      {dateLabel ? <Text style={styles.goalCount}>{dateLabel}</Text> : null}
    </View>
  </Pressable>;
}

/** Home-screen notice for a plan draft that still needs the user's confirmation. */
export function DraftFocusCard({ title, meta, openLabel, onPress }: { title: string; meta: string; openLabel: string; onPress: () => void }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={openLabel}
    onPress={onPress}
    style={({ pressed }) => [styles.focusCard, pressed && styles.focusPressed]}
  >
    <View style={styles.focusTile}><AppIcon name="target" size={18} color={theme.color.accent} /></View>
    <View style={styles.goalMain}>
      <Text style={styles.focusTitle}>{title}</Text>
      <Text style={styles.focusMeta} numberOfLines={2}>{meta}</Text>
    </View>
    <AppIcon name="chevronRight" size={16} color={theme.color.onFocus} />
  </Pressable>;
}

export function taskIsDone(task: Task): boolean { return task.status === 'done'; }

const makeStyles = (theme: Theme) => StyleSheet.create({
  task: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 56, paddingRight: 14 },
  check: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  circle: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: theme.color.controlBorder, alignItems: 'center', justifyContent: 'center' },
  circleDone: { backgroundColor: theme.color.accent, borderColor: theme.color.accent },
  taskMain: { flex: 1, minWidth: 0, paddingVertical: 6 },
  taskTitle: { color: theme.color.ink, fontSize: 16, lineHeight: 22 },
  taskTitleDone: { color: theme.color.muted, textDecorationLine: 'line-through' },
  taskSubtitle: { color: theme.color.muted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  due: { color: theme.color.muted, backgroundColor: theme.color.subtle, fontSize: 12, lineHeight: 20, paddingHorizontal: 8, borderRadius: 99, overflow: 'hidden' },
  dueToday: { color: theme.color.onFocus, backgroundColor: theme.color.focus },
  goalCard: { flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: theme.radius.group, backgroundColor: theme.color.surface, paddingVertical: 14, paddingHorizontal: 16, marginBottom: 10 },
  pressed: { backgroundColor: theme.color.subtle },
  focusPressed: { backgroundColor: theme.color.focusPressed },
  goalMain: { flex: 1, minWidth: 0 },
  goalTitle: { color: theme.color.ink, fontSize: 16, lineHeight: 22, fontWeight: '600' },
  goalNext: { color: theme.color.muted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  goalMeta: { alignItems: 'flex-end' },
  goalCount: { color: theme.color.muted, fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
  focusCard: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: theme.radius.group, backgroundColor: theme.color.focus, paddingVertical: 14, paddingHorizontal: 16, marginBottom: 10 },
  focusTile: { width: 32, height: 32, borderRadius: 9, backgroundColor: theme.color.surface, alignItems: 'center', justifyContent: 'center' },
  focusTitle: { color: theme.color.onFocus, fontSize: 16, lineHeight: 22 },
  focusMeta: { color: theme.color.focusMuted, fontSize: 13, lineHeight: 18, marginTop: 2 },
});
