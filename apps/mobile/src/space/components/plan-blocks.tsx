import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, StyleSheet, Text, TextInput, View, type DimensionValue } from 'react-native';
import { AppIcon } from '../../ui';
import { useTheme, type Theme } from '../../ui/theme';

/** Segmented control for "let AI break it down" versus "fill it in myself". */
export function ModeSwitch<T extends string>({ value, options, groupLabel, onChange, disabled = false }: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  groupLabel: string;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <View accessibilityRole="radiogroup" accessibilityLabel={groupLabel} style={styles.mode}>
    {options.map(option => {
      const selected = option.value === value;
      const optionDisabled = disabled || option.disabled === true;
      return <Pressable
        key={option.value}
        accessibilityRole="radio"
        accessibilityLabel={option.label}
        accessibilityState={{ checked: selected, disabled: optionDisabled }}
        disabled={optionDisabled}
        onPress={() => onChange(option.value)}
        style={({ pressed }) => [styles.modeButton, selected && styles.modeButtonOn, pressed && !selected && styles.modePressed, optionDisabled && styles.disabled]}
      >
        <Text style={[styles.modeLabel, selected && styles.modeLabelOn]}>{option.label}</Text>
      </Pressable>;
    })}
  </View>;
}

/** One-tap examples that fill the goal field. */
export function ExampleChips({ examples, onPick }: { examples: string[]; onPick: (text: string) => void }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <View style={styles.examples}>
    {examples.map(example => <Pressable
      key={example}
      accessibilityRole="button"
      accessibilityLabel={example}
      onPress={() => onPick(example)}
      style={({ pressed }) => [styles.example, pressed && styles.modePressed]}
    >
      <Text style={styles.exampleLabel}>{example}</Text>
    </Pressable>)}
  </View>;
}

/** Quiet pulse used while a draft is being generated; static when motion is reduced. */
export function Skeleton({ width, height = 18 }: { width: DimensionValue; height?: number }) {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    let live = true;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0.55, duration: 700, useNativeDriver: true }),
    ]));
    void AccessibilityInfo.isReduceMotionEnabled().then(reduce => { if (live && !reduce) loop.start(); }, () => undefined);
    return () => { live = false; loop.stop(); };
  }, [opacity]);
  return <Animated.View style={{ width, height, borderRadius: 10, backgroundColor: theme.color.subtle, opacity, marginVertical: 12 }} />;
}

/** Multi-line title with the draft page's large type and focus underline. */
export function TitleInput({ value, onChangeText, accessibilityLabel, placeholder, editable = true, multiline = true }: {
  value: string; onChangeText: (text: string) => void; accessibilityLabel: string; placeholder: string; editable?: boolean; multiline?: boolean;
}) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const [focused, setFocused] = useState(false);
  return <TextInput
    accessibilityLabel={accessibilityLabel}
    placeholder={placeholder}
    placeholderTextColor={theme.color.muted}
    value={value}
    onChangeText={onChangeText}
    editable={editable}
    multiline={multiline}
    maxLength={160}
    scrollEnabled={false}
    onFocus={() => setFocused(true)}
    onBlur={() => setFocused(false)}
    style={[styles.titleInput, focused && styles.titleInputFocused, !editable && styles.titleInputLocked]}
  />;
}

/** Task row in the draft: drag-handle look, inline name, remove control. */
export function DraftTaskRow({ value, total, onChangeText, onReorder, onRemove, labels, editable = true }: {
  value: string;
  total: number;
  onChangeText: (text: string) => void;
  onReorder: () => void;
  onRemove: () => void;
  labels: { task: string; reorder: string; remove: string };
  editable?: boolean;
}) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <View style={styles.draftTask}>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={labels.reorder}
      accessibilityHint={labels.task}
      disabled={!editable || total < 2}
      onPress={onReorder}
      onLongPress={onReorder}
      style={({ pressed }) => [styles.grip, pressed && styles.modePressed]}
    >
      <AppIcon name="grip" size={18} color={theme.color.muted} />
    </Pressable>
    <TextInput
      accessibilityLabel={labels.task}
      placeholder={labels.task}
      placeholderTextColor={theme.color.muted}
      value={value}
      onChangeText={onChangeText}
      editable={editable}
      maxLength={240}
      multiline
      scrollEnabled={false}
      style={styles.plainInput}
    />
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={labels.remove}
      disabled={!editable}
      onPress={onRemove}
      style={({ pressed }) => [styles.remove, pressed && styles.modePressed]}
    >
      <AppIcon name="close" size={16} color={theme.color.muted} />
    </Pressable>
  </View>;
}

/** Inline "add" row shared by the draft task list. */
export function AddRow({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.addRow, pressed && !disabled && styles.modePressed, disabled && styles.disabled]}
  >
    <AppIcon name="plus" size={20} color={theme.color.accent} />
    <Text style={styles.addLabel}>{label}</Text>
  </Pressable>;
}

/** The goal text the user just wrote, quoted on the generating page. */
export function Quote({ children }: { children: string }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <View style={styles.quote}><Text style={styles.quoteText}>{children}</Text></View>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  mode: { flexDirection: 'row', backgroundColor: theme.color.subtle, borderRadius: 14, padding: 4, marginBottom: 16 },
  modeButton: { flex: 1, minHeight: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  modeButtonOn: { backgroundColor: theme.color.surface, shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 2, shadowOffset: { width: 0, height: 1 }, elevation: 1 },
  modePressed: { backgroundColor: theme.color.subtle },
  modeLabel: { color: theme.color.muted, fontSize: 15, lineHeight: 20, fontWeight: '500' },
  modeLabelOn: { color: theme.color.ink },
  disabled: { opacity: 0.45 },
  examples: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  example: { minHeight: 32, paddingHorizontal: 12, borderRadius: 99, backgroundColor: theme.color.subtle, justifyContent: 'center' },
  exampleLabel: { color: theme.color.ink, fontSize: 13, lineHeight: 18 },
  titleInput: { color: theme.color.ink, fontSize: 26, lineHeight: 34, fontWeight: '600', paddingVertical: 4, borderBottomWidth: 1.5, borderBottomColor: 'transparent' },
  titleInputFocused: { borderBottomColor: theme.color.accent },
  titleInputLocked: { color: theme.color.muted },
  draftTask: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 52, paddingLeft: 4, paddingRight: 6 },
  grip: { width: 34, height: 44, alignItems: 'center', justifyContent: 'center' },
  plainInput: { flex: 1, minWidth: 0, color: theme.color.ink, fontSize: 16, lineHeight: 22, paddingVertical: 12 },
  remove: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52, paddingLeft: 14, paddingRight: 16 },
  addLabel: { color: theme.color.accent, fontSize: 16, lineHeight: 22 },
  quote: { backgroundColor: theme.color.surface, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 16, marginBottom: 20 },
  quoteText: { color: theme.color.ink, fontSize: 16, lineHeight: 24 },
});
