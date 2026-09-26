import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppIcon } from './icon';
import { useTheme, type Theme } from './theme';

export function ChoiceCard({ title, detail, selected, onPress, disabled = false }: { title: string; detail?: string; selected: boolean; onPress: () => void; disabled?: boolean }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <Pressable
    accessibilityRole="radio"
    accessibilityLabel={title}
    accessibilityState={{ checked: selected, disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.choice, selected && styles.choiceSelected, pressed && !selected && styles.pressed]}
  >
    <View style={[styles.radio, selected && styles.radioSelected]}>{selected ? <View style={styles.dot} /> : null}</View>
    <View style={styles.text}>
      <Text style={[styles.title, disabled && styles.disabledText]}>{title}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
  </Pressable>;
}

export function Checkbox({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <Pressable
    accessibilityRole="checkbox"
    accessibilityLabel={label}
    accessibilityState={{ checked, disabled }}
    disabled={disabled}
    onPress={() => onChange(!checked)}
    style={({ pressed }) => [styles.check, pressed && !disabled && styles.pressed]}
  >
    <View style={[styles.box, checked && styles.boxChecked]}>{checked ? <AppIcon name="check" size={14} color={theme.color.onAccent} /> : null}</View>
    <Text style={[styles.checkLabel, disabled && styles.disabledText]}>{label}</Text>
  </Pressable>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  choice: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, borderWidth: 1.5, borderColor: theme.color.border, backgroundColor: 'transparent', borderRadius: theme.radius.control, paddingHorizontal: 14, paddingVertical: 12, marginTop: 10 },
  choiceSelected: { borderColor: theme.color.accent, backgroundColor: theme.color.focus },
  pressed: { backgroundColor: theme.color.subtle },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: theme.color.controlBorder, alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 },
  radioSelected: { borderColor: theme.color.accent },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: theme.color.accent },
  text: { flex: 1, minWidth: 0 },
  title: { color: theme.color.ink, fontSize: 16, lineHeight: 22, fontWeight: '500' },
  detail: { color: theme.color.muted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  disabledText: { color: theme.color.muted },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingHorizontal: 4, paddingVertical: 12 },
  box: { width: 24, height: 24, borderRadius: 7, borderWidth: 1.5, borderColor: theme.color.controlBorder, backgroundColor: theme.color.surface, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  boxChecked: { backgroundColor: theme.color.accent, borderColor: theme.color.accent },
  checkLabel: { flex: 1, color: theme.color.ink, fontSize: 16, lineHeight: 22 },
});
