import { ActivityIndicator, Pressable, StyleSheet, Text, useWindowDimensions } from 'react-native';
import { AppIcon, type IconName } from './icon';
import { useTheme, type Theme } from './theme';

export type ButtonVariant = 'primary' | 'tonal' | 'text' | 'danger' | 'dangerFill' | 'apple';

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  icon?: IconName;
  loading?: boolean;
  disabled?: boolean;
  size?: 'md' | 'sm';
  accessibilityLabel?: string;
  testID?: string;
};

export function Button({ label, onPress, variant = 'primary', icon, loading = false, disabled = false, size = 'md', accessibilityLabel, testID }: ButtonProps) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const styles = makeStyles(theme, fontScale);
  const small = size === 'sm';
  const textLike = !small && (variant === 'text' || variant === 'danger');
  const colors = buttonColors(theme, variant, disabled);
  const labelColor = disabled ? theme.color.muted : colors.label;
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled: disabled || loading, busy: loading }}
    disabled={disabled || loading}
    testID={testID}
    onPress={onPress}
    style={({ pressed }) => [
      styles.base,
      small ? styles.sm : styles.md,
      textLike && styles.textLikeMd,
      { backgroundColor: pressed && !disabled ? colors.pressed : colors.background },
      pressed && !disabled && styles.pressedScale,
    ]}
  >
    {loading ? <ActivityIndicator size="small" color={colors.label} /> : icon ? <AppIcon name={icon} size={small ? 18 : 20} color={labelColor} /> : null}
    <Text style={[styles.label, small ? styles.smLabel : styles.mdLabel, textLike && styles.textLikeLabel, { color: labelColor }]}>{label}</Text>
  </Pressable>;
}

// A loading button keeps the variant fill so its spinner stays legible; only a
// disabled button falls back to the subtle fill.
function buttonColors(theme: Theme, variant: ButtonVariant, disabled: boolean) {
  const quiet = variant === 'text' || variant === 'danger';
  const tones: Record<ButtonVariant, { background: string; pressed: string; label: string }> = {
    primary: { background: theme.color.accent, pressed: theme.color.accentPressed, label: theme.color.onAccent },
    tonal: { background: theme.color.subtle, pressed: theme.color.subtle, label: theme.color.ink },
    text: { background: 'transparent', pressed: theme.color.subtle, label: theme.color.accent },
    danger: { background: 'transparent', pressed: theme.color.subtle, label: theme.color.error },
    dangerFill: { background: theme.color.error, pressed: theme.color.subtle, label: theme.color.surface },
    apple: { background: theme.color.apple, pressed: theme.color.subtle, label: theme.color.onApple },
  };
  const tone = tones[variant];
  if (!disabled) return tone;
  return { ...tone, background: quiet ? 'transparent' : theme.color.subtle, label: theme.color.muted };
}

const makeStyles = (theme: Theme, fontScale: number) => StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  md: { width: '100%', minHeight: 52, borderRadius: theme.radius.control, paddingHorizontal: 18 },
  sm: { alignSelf: 'flex-start', minHeight: 36, borderRadius: theme.radius.field, paddingHorizontal: 14 },
  textLikeMd: { minHeight: 44 },
  label: { fontWeight: '600', flexShrink: 1 },
  mdLabel: { fontSize: 17, lineHeight: 24 },
  smLabel: { fontSize: 14, lineHeight: 20 },
  textLikeLabel: { fontSize: 16, lineHeight: 22, fontWeight: '500' },
  pressedScale: { transform: [{ scale: 0.985 }] },
});
