import Constants from 'expo-constants';
import { Stack, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAISettings } from '../settings/ai-settings';
import { findProvider } from '../settings/providers';
import { useTheme, useThemePreference, type Theme, type ThemeMode } from '../ui/theme';

export default function SettingsScreen() {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const { mode, setMode } = useThemePreference();
  const settings = useAISettings();
  const router = useRouter();
  const providerName = settings.config ? findProvider(settings.config.baseUrl)?.name ?? '自定义接口' : '未配置';
  return <SafeAreaView style={styles.page} edges={[]}>
    <Stack.Screen options={{ headerShown: true, title: '设置', headerBackTitle: '返回', headerBackButtonDisplayMode: 'minimal', headerShadowVisible: false, headerTintColor: theme.color.ink, headerStyle: { backgroundColor: theme.color.background } }} />
    <ScrollView contentContainerStyle={styles.content}>
      <Pressable accessibilityRole="button" accessibilityLabel={`AI 服务，${providerName}`} testID="settings-ai-service" onPress={() => router.push('/ai-provider')} style={styles.row}>
        <Text style={styles.label}>AI 服务</Text>
        <View style={styles.trailing}><Text numberOfLines={1} style={styles.value}>{!settings.ready ? '正在读取' : settings.storageError ? '需要检查' : providerName}</Text><Text style={styles.chevron}>›</Text></View>
      </Pressable>
      <View style={styles.row}>
        <Text style={styles.label}>外观</Text>
        <View style={styles.segment}>
          {(['light', 'dark'] as ThemeMode[]).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: mode === value }} accessibilityLabel={value === 'light' ? '明色主题' : '暗色主题'} onPress={() => setMode(value)} hitSlop={3} style={[styles.segmentButton, mode === value && styles.segmentSelected]}>
            <Text style={[styles.segmentText, mode === value && styles.segmentSelectedText]}>{value === 'light' ? '明色' : '暗色'}</Text>
          </Pressable>)}
        </View>
      </View>
      <View style={styles.group}>
        <View style={styles.row}><Text style={styles.label}>聊天记录</Text><Text style={styles.value}>重启后清空</Text></View>
        <View style={styles.divider} />
        <View style={styles.row}><Text style={styles.label}>密钥存储</Text><Text style={styles.value}>本机安全存储</Text></View>
        <View style={styles.divider} />
        <View style={styles.row}><Text style={styles.label}>应用版本</Text><Text style={styles.value}>{Constants.expoConfig?.version ?? '开发版本'}</Text></View>
      </View>
    </ScrollView>
  </SafeAreaView>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.color.background },
  content: { padding: 20, paddingTop: 20, paddingBottom: 32, gap: 20 },
  row: { minHeight: 58, paddingHorizontal: 16, paddingVertical: 7, backgroundColor: theme.color.surface, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  group: { backgroundColor: theme.color.surface, borderRadius: 14, overflow: 'hidden' },
  label: { color: theme.color.ink, fontSize: 16 },
  value: { color: theme.color.muted, fontSize: 14, flexShrink: 1 },
  trailing: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  chevron: { color: theme.color.muted, fontSize: 23 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border, marginLeft: 16 },
  segment: { flexDirection: 'row', padding: 3, backgroundColor: theme.color.subtle, borderRadius: 10 },
  segmentButton: { minWidth: 64, minHeight: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  segmentSelected: { backgroundColor: theme.color.accent },
  segmentText: { color: theme.color.muted, fontSize: 14 },
  segmentSelectedText: { color: theme.color.onAccent, fontWeight: '500' },
});
