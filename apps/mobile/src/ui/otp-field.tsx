import { type Ref } from 'react';
import { StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { useTheme, type Theme } from './theme';

type OtpFieldProps = {
  value: string;
  onChangeText: (text: string) => void;
  length?: number;
  accessibilityLabel?: string;
  autoFocus?: boolean;
  inputRef?: Ref<TextInput>;
};

export function OtpField({ value, onChangeText, length = 6, accessibilityLabel, autoFocus, inputRef }: OtpFieldProps) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const styles = makeStyles(theme, fontScale);
  const current = Math.min(value.length, length - 1);
  return <View style={styles.container}>
    <View accessible={false} style={styles.boxes}>
      {Array.from({ length }, (_, index) => <View key={index} style={[styles.box, index === current && styles.boxCurrent]}>
        <Text style={styles.digit}>{value[index] ?? ''}</Text>
      </View>)}
    </View>
    <TextInput
      ref={inputRef}
      style={styles.input}
      value={value}
      onChangeText={text => onChangeText(text.replace(/[^0-9]/g, '').slice(0, length))}
      keyboardType="number-pad"
      textContentType="oneTimeCode"
      autoComplete="one-time-code"
      caretHidden
      maxLength={length}
      autoFocus={autoFocus}
      accessibilityLabel={accessibilityLabel}
    />
  </View>;
}

const makeStyles = (theme: Theme, fontScale: number) => StyleSheet.create({
  container: { position: 'relative', flexDirection: 'row', gap: 8 },
  boxes: { flex: 1, flexDirection: 'row', gap: 8 },
  box: { flex: 1, height: 60, borderRadius: 14, backgroundColor: theme.color.surface, borderWidth: 1.5, borderColor: theme.color.border, alignItems: 'center', justifyContent: 'center' },
  boxCurrent: { borderColor: theme.color.accent },
  digit: { color: theme.color.ink, fontSize: 26, lineHeight: 32, fontWeight: '600', fontVariant: ['tabular-nums'] },
  input: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0, color: 'transparent', fontSize: 16 },
});
