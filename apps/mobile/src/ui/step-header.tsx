import { StyleSheet, Text, View } from 'react-native';
import { useTheme, type Theme } from './theme';

export function StepHeader({ caption, step, total }: { caption: string; step: number; total: number }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <View>
    <Text style={styles.caption}>{caption} · {step}/{total}</Text>
    <View style={styles.bars}>
      {Array.from({ length: Math.max(0, total) }, (_, index) => <View key={index} style={[styles.bar, index < step && styles.barOn]} />)}
    </View>
  </View>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  caption: { color: theme.color.muted, fontSize: 13, lineHeight: 18, fontWeight: '500', marginBottom: 6 },
  bars: { flexDirection: 'row', gap: 6, marginBottom: 18 },
  bar: { flex: 1, height: 4, borderRadius: 2, backgroundColor: theme.color.subtle },
  barOn: { backgroundColor: theme.color.accent },
});
