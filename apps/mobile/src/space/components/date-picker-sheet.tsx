import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheet, Button } from '../../ui';
import { useTheme, type Theme } from '../../ui/theme';
import { dateQuickPicks, localDateOf, monthGrid, shiftMonth, weekdayLabels } from '../dates.ts';
import type { Locale } from '../../i18n/core.ts';

/** Calendar sheet used for goal target dates and task dates: quick picks plus any day. */
export function DatePickerSheet({ visible, onClose, locale, labels, value, onSelect, onClear }: {
  visible: boolean;
  onClose: () => void;
  locale: Locale;
  labels: {
    title: string;
    today: string;
    tomorrow: string;
    saturday: string;
    clear: string;
    pick: string;
  };
  value?: string | null;
  onSelect: (date: string) => void;
  onClear?: () => void;
}) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const today = localDateOf();
  const [view, setView] = useState(() => {
    const [year, month] = (value ?? today).split('-');
    return { year: Number(year), month: Number(month) };
  });
  const grid = monthGrid(view.year, view.month);
  const monthTitle = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(new Date(view.year, view.month - 1, 1));
  return <BottomSheet visible={visible} onClose={onClose} title={labels.title}>
    <View style={styles.quickPicks}>
      {dateQuickPicks(today).map(item => <Pressable key={item.key} accessibilityRole="button" accessibilityLabel={labels[item.key]}
        onPress={() => onSelect(item.date)} style={styles.quickPick}><Text style={styles.quickLabel}>{labels[item.key]}</Text></Pressable>)}
    </View>
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={labels.pick} onPress={() => setView(current => shiftMonth(current.year, current.month, -1))} style={styles.navButton}>
        <Text style={styles.navLabel}>{'<'}</Text>
      </Pressable>
      <Text accessibilityRole="header" style={styles.month}>{monthTitle}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={labels.pick} onPress={() => setView(current => shiftMonth(current.year, current.month, 1))} style={styles.navButton}>
        <Text style={styles.navLabel}>{'>'}</Text>
      </Pressable>
    </View>
    <View style={styles.week}>
      {weekdayLabels(locale).map((label, index) => <Text key={index} style={styles.weekday}>{label}</Text>)}
    </View>
    {grid.weeks.map((week, index) => <View key={index} style={styles.week}>
      {week.map((date, cell) => date === null
        ? <View key={cell} style={styles.cell} />
        : <Pressable
          key={cell}
          accessibilityRole="button"
          accessibilityLabel={date}
          accessibilityState={{ selected: value === date }}
          onPress={() => onSelect(date)}
          style={({ pressed }) => [styles.cell, styles.day, date === value && styles.daySelected, date === today && styles.dayToday, pressed && styles.dayPressed]}
        >
          <Text style={[styles.dayLabel, date === value && styles.dayLabelSelected]}>{Number(date.slice(8))}</Text>
        </Pressable>)}
    </View>)}
    {onClear ? <View style={styles.clear}><Button label={labels.clear} variant="tonal" onPress={onClear} /></View> : null}
  </BottomSheet>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  quickPicks: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 12 },
  quickPick: { minHeight: 44, justifyContent: 'center', borderRadius: 99, paddingHorizontal: 14, backgroundColor: theme.color.subtle },
  quickLabel: { color: theme.color.ink, fontSize: 14, lineHeight: 20 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
  month: { color: theme.color.ink, fontSize: 16, lineHeight: 22, fontWeight: '600' },
  navButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: theme.color.subtle },
  navLabel: { color: theme.color.ink, fontSize: 18, lineHeight: 22, fontWeight: '600' },
  week: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', color: theme.color.muted, fontSize: 12, lineHeight: 20 },
  cell: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  day: { borderRadius: 12 },
  daySelected: { backgroundColor: theme.color.accent },
  dayToday: { borderWidth: 1.5, borderColor: theme.color.accent },
  dayPressed: { backgroundColor: theme.color.subtle },
  dayLabel: { color: theme.color.ink, fontSize: 15, lineHeight: 22 },
  dayLabelSelected: { color: theme.color.onAccent, fontWeight: '600' },
  clear: { marginTop: 12 },
});
