import { StyleSheet, View } from 'react-native';
import { useTheme } from './theme';

/**
 * Progress ring without a drawing dependency. Each half of the circle is a clipped
 * window holding one 180 degree arc, and rotating those arcs sweeps the fill from the
 * top: the right window covers 0-180 degrees, the left window covers 180-360.
 *
 * A border pair paints the 90 degree arc centred on each of its sides, so the top and
 * right borders together span 315-135 degrees: the 225 and -315 offsets below move that
 * arc onto the 12-to-6 half before the sweep is applied.
 */
export function ProgressRing({ progress, size = 46, stroke = 5 }: { progress: number; size?: number; stroke?: number }) {
  const theme = useTheme();
  const value = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const radius = size / 2;
  const arc = {
    position: 'absolute' as const,
    top: 0,
    width: size,
    height: size,
    borderRadius: radius,
    borderWidth: stroke,
    borderColor: 'transparent',
    borderTopColor: theme.color.accent,
    borderRightColor: theme.color.accent,
  };
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}>
    <View style={[StyleSheet.absoluteFill, { borderRadius: radius, borderWidth: stroke, borderColor: theme.color.subtle }]} />
    <View style={{ position: 'absolute', top: 0, left: 0, width: size / 2, height: size, overflow: 'hidden' }}>
      <View style={[arc, { left: 0, transform: [{ rotate: (Math.max(0, value - 0.5) * 360 - 315) + 'deg' }] }]} />
    </View>
    <View style={{ position: 'absolute', top: 0, left: size / 2, width: size / 2, height: size, overflow: 'hidden' }}>
      <View style={[arc, { left: -size / 2, transform: [{ rotate: (Math.min(value, 0.5) * 360 + 225) + 'deg' }] }]} />
    </View>
  </View>;
}
