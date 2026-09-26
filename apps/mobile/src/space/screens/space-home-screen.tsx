import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ActionDraft } from '@siyue/contracts';
import type { PlanSnapshot } from '@siyue/adapters';
import { Banner, Button, ListGroup, ListRow, Screen, SectionLabel, useTheme, type Theme } from '../../ui';
import { useWorkspace } from '../../account/workspace-provider';
import { useCurrentSpace, useSpaceSwitcher } from '../../shell/space-switcher';
import { TopBar } from '../../shell/top-bar';
import { useLocale } from '../../i18n';
import { useSpaceText } from '../use-space-text';
import { usePlanSnapshot } from '../use-plan-snapshot';
import { spaceView } from '../space-scope';
import { goalProgress, todayTasks } from '../goal-progress';
import { localDateOf, formatLocalDate } from '../dates.ts';
import { DraftFocusCard, GoalCard, TaskRow } from '../components/space-lists';
import { IconButton, ProgressBar, SpaceTitleButton, SyncLine } from '../components/space-chrome';

const draftNeedsReview = (draft: ActionDraft) => draft.command.kind === 'plan.create'
  && ['draft', 'approved', 'expired'].includes(draft.status);

export default function SpaceHomeScreen() {
  const t = useSpaceText(), theme = useTheme(), router = useRouter(), insets = useSafeAreaInsets();
  const switcher = useSpaceSwitcher();
  const { state } = useWorkspace();
  const currentSpace = useCurrentSpace();
  const { locale } = useLocale();
  const { snapshot, loading, failed, reload, update } = usePlanSnapshot();
  const [changed, setChanged] = useState<string | null>(null);
  const today = useMemo(() => localDateOf(), []);
  const view = spaceView(state);
  const goals = useMemo(() => snapshot?.goals.filter(goal => goal.status !== 'archived') ?? [], [snapshot]);
  const archived = useMemo(() => snapshot?.goals.filter(goal => goal.status === 'archived') ?? [], [snapshot]);
  const drafts = useMemo(() => snapshot?.drafts.filter(draftNeedsReview) ?? [], [snapshot]);
  const due = useMemo(() => snapshot ? todayTasks(snapshot, today) : [], [snapshot, today]);
  const empty = !!snapshot && goals.length === 0 && drafts.length === 0;
  const toggle = useCallback(async (task: { id: string; version: number; status: string; title: string }) => {
    setChanged(null);
    const result = await update('task', task.id, task.version, { status: task.status === 'done' ? 'open' : 'done' });
    if (result.kind === 'conflict') setChanged(task.title);
  }, [update]);
  const restore = useCallback(async (goal: { id: string; version: number }) => {
    setChanged(null);
    await update('goal', goal.id, goal.version, { status: 'active' });
  }, [update]);
  const progressOf = useCallback((id: string) => snapshot ? goalProgress(snapshot, id) : { completed: 0, total: 0, tasks: [] }, [snapshot]);
  return <View style={styles.fill}>
    <TopBar />
    <Screen maxWidth={theme.layout.contentWidth} testID="space-home">
      <SpaceTitleButton label={currentSpace.name} onPress={() => switcher.open()} />
      {view ? <SyncLine icon={view.kind === 'local' ? 'lock' : 'cloudOff'} text={t(view.syncKey)} /> : null}
      {failed ? <Banner kind="warn" title={t('home.error')} action={<Button label={t('home.retry')} variant="tonal" size="sm" onPress={() => void reload()} />} /> : null}
      {changed ? <Banner kind="warn" title={t('home.changed', { title: changed })} body={t('home.changedBody')} /> : null}
      {empty
        ? <EmptySpace onPlan={() => router.push('/plan/new')} onChat={() => router.navigate('/')} />
        : <>
          {drafts.map(draft => <DraftFocusCard
            key={draft.id}
            title={t('home.draftCount', { count: drafts.length })}
            meta={draft.command.kind === 'plan.create' ? draft.command.payload.title : ''}
            openLabel={t('home.draftOpen', { title: draft.command.kind === 'plan.create' ? draft.command.payload.title : '' })}
            onPress={() => router.push({ pathname: '/plan/draft', params: { id: draft.id } })}
          />)}
          {due.length > 0 ? <>
            <SectionLabel>{t('home.today')}</SectionLabel>
            <ListGroup>
              {due.map(({ task, goal }) => <TaskRow
                key={task.id}
                title={task.title}
                subtitle={goal.title}
                due={formatLocalDate('en', task.dueLocalDate, today) === 'Today' ? t('home.today') : null}
                dueToday
                done={task.status === 'done'}
                toggleLabel={task.status === 'done' ? t('goal.uncheckTask', { title: task.title }) : t('goal.checkTask', { title: task.title })}
                onToggle={() => void toggle(task)}
                onOpen={() => router.push({ pathname: '/space/goal/[id]', params: { id: goal.id } })}
                openLabel={t('home.openGoal', { title: goal.title })}
              />)}
            </ListGroup>
          </> : null}
          <SectionLabel>{t('home.goals')}</SectionLabel>
          {goals.length === 0
            ? <Text style={styles.quiet}>{t('home.emptyTitle')}</Text>
            : goals.map(goal => {
              const value = progressOf(goal.id);
              const next = value.tasks.find(task => task.status !== 'done');
              return <GoalCard
                key={goal.id}
                goal={goal}
                completed={value.completed}
                total={value.total}
                nextTitle={next ? t('home.next', { title: next.title }) : null}
                allDoneLabel={t('home.allDone')}
                dateLabel={formatLocalDate(locale, goal.targetDate, today)}
                openLabel={t('home.openGoal', { title: goal.title })}
                onPress={() => router.push({ pathname: '/space/goal/[id]', params: { id: goal.id } })}
              />;
            })}
          {archived.length > 0 ? <>
            <SectionLabel>{t('home.archived')}</SectionLabel>
            <ListGroup>
              {archived.map(goal => <ListRow
                key={goal.id}
                title={goal.title}
                disabled={loading}
                trailing={<Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('home.restoreGoal', { title: goal.title })}
                  onPress={() => void restore(goal)}
                  style={styles.restore}
                ><Text style={styles.restoreLabel}>{t('home.restore')}</Text></Pressable>}
              />)}
            </ListGroup>
          </> : null}
        </>}
    </Screen>
    {!empty ? <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('home.newPlan')}
      onPress={() => router.push('/plan/new')}
      style={({ pressed }) => [styles.fab, { backgroundColor: theme.color.accent, bottom: insets.bottom + 24 }, pressed && styles.fabPressed]}
    ><Text style={styles.fabLabel}>+</Text></Pressable> : null}
  </View>;
}

function EmptySpace({ onPlan, onChat }: { onPlan: () => void; onChat: () => void }) {
  const t = useSpaceText(), theme = useTheme();
  return <View style={styles.empty}>
    <View style={[styles.emptyRing, { backgroundColor: theme.color.focus }]}><Text style={styles.emptyIcon}>◎</Text></View>
    <Text accessibilityRole="header" style={[styles.emptyTitle, { color: theme.color.ink }]}>{t('home.emptyTitle')}</Text>
    <Text style={[styles.emptyBody, { color: theme.color.muted }]}>{t('home.emptyBody')}</Text>
    <View style={styles.emptyActions}>
      <Button label={t('home.emptyPlan')} onPress={onPlan} />
      <Button label={t('home.emptyChat')} variant="text" onPress={onChat} />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  quiet: { color: '#5D695F', fontSize: 15, lineHeight: 21, marginHorizontal: 4 },
  restore: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' },
  restoreLabel: { fontSize: 15, lineHeight: 22, color: '#476B53' },
  fab: { position: 'absolute', right: 20, width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', shadowColor: '#284632', shadowOpacity: 0.35, shadowRadius: 24, shadowOffset: { width: 0, height: 10 }, elevation: 6 },
  fabPressed: { transform: [{ scale: 0.96 }] },
  fabLabel: { color: '#FFFFFF', fontSize: 30, lineHeight: 34, fontWeight: '400' },
  empty: { alignItems: 'center', paddingTop: 40, gap: 4 },
  emptyRing: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  emptyIcon: { fontSize: 34, lineHeight: 40 },
  emptyTitle: { fontSize: 22, lineHeight: 28, fontWeight: '600', marginBottom: 8 },
  emptyBody: { fontSize: 16, lineHeight: 24, textAlign: 'center', maxWidth: 320, marginBottom: 20 },
  emptyActions: { width: '100%', maxWidth: 360, gap: 10 },
});
