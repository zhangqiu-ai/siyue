import { useState, type ReactNode, type Ref } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions, type TextInputProps } from 'react-native';
import { AppIcon } from './icon';
import { useTheme, type Theme } from './theme';

type TextFieldProps = {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  error?: string | null;
  hint?: string;
  trailing?: ReactNode;
  secure?: boolean;
  keyboardType?: TextInputProps['keyboardType'];
  autoComplete?: TextInputProps['autoComplete'];
  textContentType?: TextInputProps['textContentType'];
  editable?: boolean;
  maxLength?: number;
  inputRef?: Ref<TextInput>;
  testID?: string;
  onSubmitEditing?: () => void;
  returnKeyType?: TextInputProps['returnKeyType'];
  inputTrailing?: ReactNode;
};

export function TextField({ label, value, onChangeText, error = null, hint, trailing, secure, keyboardType, autoComplete, textContentType, editable = true, maxLength, inputRef, testID, onSubmitEditing, returnKeyType, inputTrailing }: TextFieldProps) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const styles = makeStyles(theme, fontScale);
  const [focused, setFocused] = useState(false);
  return <View style={styles.field}>
    <View style={styles.labelRow}>
      <Text style={styles.label}>{label}</Text>
      {trailing}
    </View>
    <View style={[styles.inputWrap, focused && styles.inputWrapFocused, error ? styles.inputWrapError : null]}>
      <TextInput
        ref={inputRef}
        accessibilityLabel={label}
        style={[styles.input, editable ? null : styles.inputReadOnly]}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        maxLength={maxLength}
        secureTextEntry={secure}
        keyboardType={keyboardType}
        autoComplete={autoComplete}
        textContentType={textContentType}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        testID={testID}
      />
      {inputTrailing}
    </View>
    {error
      ? <View accessibilityRole="alert" style={styles.errorRow}>
        <AppIcon name="info" size={16} color={theme.color.error} />
        <Text style={styles.errorText}>{error}</Text>
      </View>
      : hint ? <Text style={styles.hint}>{hint}</Text> : null}
  </View>;
}

type PasswordFieldProps = Omit<TextFieldProps, 'secure' | 'inputTrailing'> & { showLabel: string; hideLabel: string };

export function PasswordField({ showLabel, hideLabel, ...props }: PasswordFieldProps) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const styles = makeStyles(theme, fontScale);
  const [revealed, setRevealed] = useState(false);
  return <TextField
    {...props}
    secure={!revealed}
    inputTrailing={<Pressable
      accessibilityRole="button"
      accessibilityLabel={revealed ? hideLabel : showLabel}
      onPress={() => setRevealed(current => !current)}
      style={styles.eye}
    >
      <AppIcon name={revealed ? 'eyeOff' : 'eye'} size={20} color={theme.color.muted} />
    </Pressable>}
  />;
}

const makeStyles = (theme: Theme, fontScale: number) => StyleSheet.create({
  field: { marginBottom: 16 },
  labelRow: { flexDirection: fontScale > 1.4 ? 'column' : 'row', justifyContent: 'space-between', alignItems: fontScale > 1.4 ? 'flex-start' : 'baseline', gap: fontScale > 1.4 ? 4 : 0, marginHorizontal: 4, marginBottom: 8 },
  label: { color: theme.color.muted, fontSize: 14, lineHeight: 20, fontWeight: '500', flexShrink: 1 },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.color.surface, borderWidth: 1.5, borderColor: theme.color.border, borderRadius: theme.radius.control, minHeight: 54 },
  inputWrapFocused: { borderColor: theme.color.accent },
  inputWrapError: { borderColor: theme.color.error },
  input: { flex: 1, minWidth: 0, color: theme.color.ink, fontSize: 17, lineHeight: 24, paddingHorizontal: 16, paddingVertical: 14 },
  inputReadOnly: { color: theme.color.muted },
  errorRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', marginTop: 8, marginHorizontal: 4 },
  errorText: { color: theme.color.error, fontSize: 14, lineHeight: 20, flexShrink: 1 },
  hint: { color: theme.color.muted, fontSize: 13, lineHeight: 19, marginTop: 8, marginHorizontal: 4 },
  eye: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
});
