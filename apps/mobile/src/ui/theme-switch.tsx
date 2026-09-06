import { Pressable, Text, View } from 'react-native';
import { useTheme, useThemePreference, type ThemeMode } from './theme';

export function ThemeSwitch() {
  const theme = useTheme();
  const { mode, setMode } = useThemePreference();
  return <View style={{ gap: 10, paddingVertical: 16 }}>
    <Text style={{ color: theme.color.muted, fontSize: 13 }}>外观</Text>
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {(['light', 'dark'] as ThemeMode[]).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: mode === value }} accessibilityLabel={value === 'light' ? '明色主题' : '暗色主题'} onPress={() => setMode(value)} style={{ flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: theme.color.border, backgroundColor: mode === value ? theme.color.accent : theme.color.surface }}>
        <Text style={{ color: mode === value ? theme.color.onAccent : theme.color.ink, fontSize: 15 }}>{value === 'light' ? '明色' : '暗色'}</Text>
      </Pressable>)}
    </View>
  </View>;
}
