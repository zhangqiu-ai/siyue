import { StyleSheet, Text, View, useWindowDimensions, type DimensionValue } from 'react-native';
import { AppIcon } from './icon';
import { useTheme, type Theme } from './theme';

export function passwordRuleState(value: string, confirm: string | undefined, min: number, max: number): { length: number; lengthOk: boolean; matchOk: boolean | null } {
  const length = [...value].length;
  return { length, lengthOk: length >= min && length <= max, matchOk: confirm === undefined ? null : value === confirm };
}

/* --- component --- */

type PasswordRulesProps = {
  value: string;
  confirm?: string;
  min?: number;
  max?: number;
  lengthLabel: string;
  matchLabel?: string;
  overLabel?: (n: number) => string;
};

export function PasswordRules({ value, confirm, min = 6, max = 20, lengthLabel, matchLabel, overLabel }: PasswordRulesProps) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const styles = makeStyles(theme, fontScale);
  const state = passwordRuleState(value, confirm, min, max);
  const meterWidth: DimensionValue = `${Math.min(1, state.length / max) * 100}%`;
  const rows = [{ key: 'length', text: overLabel && state.length > max ? overLabel(state.length) : lengthLabel, ok: state.lengthOk }];
  if (confirm !== undefined && matchLabel !== undefined) rows.push({ key: 'match', text: matchLabel, ok: state.matchOk === true });
  return <>
    <View style={styles.meter}><View style={[styles.meterFill, { width: meterWidth }]} /></View>
    <View style={styles.rules}>
      {rows.map(row => <View key={row.key} style={styles.rule}>
        <View style={[styles.mark, row.ok && styles.markOk]}>{row.ok ? <AppIcon name="check" size={12} color={theme.color.onAccent} /> : null}</View>
        <Text style={[styles.ruleText, row.ok && styles.ruleTextOk]}>{row.text}</Text>
      </View>)}
    </View>
  </>;
}

const makeStyles = (theme: Theme, fontScale: number) => StyleSheet.create({
  meter: { height: 4, borderRadius: 2, backgroundColor: theme.color.subtle, marginTop: 10, marginHorizontal: 4, overflow: 'hidden' },
  meterFill: { height: '100%', borderRadius: 2, backgroundColor: theme.color.accent },
  rules: { marginTop: 10, marginHorizontal: 4, gap: 6 },
  rule: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ruleText: { color: theme.color.muted, fontSize: 14, lineHeight: 20 },
  ruleTextOk: { color: theme.color.ink },
  mark: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: theme.color.controlBorder, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  markOk: { backgroundColor: theme.color.accent, borderColor: theme.color.accent },
});
