import { zh } from '../i18n/messages';
import { useLocale } from '../i18n';
import { AppIcon } from '../ui/icon';
import Constants from 'expo-constants';
import { Stack, useRouter } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAISettings } from '../settings/ai-settings';
import { findProvider } from '../settings/providers';
import { useTheme, useThemePreference, type Theme, type ThemeMode } from '../ui/theme';

export default function SettingsScreen() {
  const { t, locale, setLocale, preferenceError } = useLocale();
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const styles = makeStyles(theme, fontScale);
  const { mode, setMode } = useThemePreference();
  const settings = useAISettings();
  const router = useRouter();
  const provider = settings.config ? findProvider(settings.config.baseUrl) : undefined;
  const providerName = settings.config ? (provider ? t(`provider.${provider.id}.name` as keyof typeof zh) : t('settings.custom')) : t('settings.unconfigured');
  return <SafeAreaView style={styles.page} edges={['bottom']}>
    <Stack.Screen options={{ headerShown: true, title: t('settings.title'), headerBackTitle: t('common.back'), headerBackButtonDisplayMode: 'minimal', headerShadowVisible: false, headerTintColor: theme.color.ink, headerStyle: { backgroundColor: theme.color.background } }} />
    <ScrollView contentContainerStyle={styles.content}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('settings.aiLabel', { name: providerName })} testID="settings-ai-service" onPress={() => router.push('/ai-provider')} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <Text style={styles.label}>{t('settings.aiService')}</Text>
        <View style={styles.trailing}><Text numberOfLines={fontScale > 1.4 ? undefined : 1} style={[styles.value, styles.serviceValue]}>{!settings.ready ? t('settings.reading') : settings.storageError ? t('settings.check') : providerName}</Text><AppIcon name="chevronRight" size={20} color={theme.color.muted} /></View>
      </Pressable>
      <View style={[styles.row, styles.appearanceRow]}>
        <Text style={styles.label}>{t('settings.appearance')}</Text>
        <View style={styles.segment}>
          {(['light', 'dark'] as ThemeMode[]).map(value => <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: mode === value }} accessibilityLabel={value === 'light' ? t('theme.lightLabel') : t('theme.darkLabel')} onPress={() => setMode(value)} style={({ pressed }) => [styles.segmentButton, mode === value && styles.segmentSelected, pressed && (mode === value ? styles.primaryPressed : styles.pressed)]}>
            <Text style={[styles.segmentText, mode === value && styles.segmentSelectedText]}>{value === 'light' ? t('theme.light') : t('theme.dark')}</Text>
          </Pressable>)}
        </View>
      </View>
      <View style={[styles.row, styles.appearanceRow]}>
        <Text style={styles.label}>{t('locale.title')}</Text>
        <View style={styles.segment}>
          {(['zh-CN', 'en'] as const).map(value => <Pressable key={value} testID={`settings-language-${value}`} accessibilityRole="radio" accessibilityState={{ checked: locale === value }} accessibilityLabel={t(value === 'zh-CN' ? 'locale.zh' : 'locale.en')} onPress={() => setLocale(value)} style={({ pressed }) => [styles.segmentButton, locale === value && styles.segmentSelected, pressed && (locale === value ? styles.primaryPressed : styles.pressed)]}>
            <Text style={[styles.segmentText, locale === value && styles.segmentSelectedText]}>{t(value === 'zh-CN' ? 'locale.zh' : 'locale.en')}</Text>
          </Pressable>)}
        </View>
      </View>
      {preferenceError ? <Text accessibilityRole="alert" style={styles.value}>{preferenceError}</Text> : null}
      <View style={styles.group}>
        <View style={styles.row}><Text style={styles.label}>{t('settings.history')}</Text><Text style={styles.value}>{t('settings.historyNote')}</Text></View>
        <View style={styles.divider} />
        <View style={styles.row}><Text style={styles.label}>{t('settings.keyStorage')}</Text><Text style={styles.value}>{t('settings.localStorage')}</Text></View>
        <View style={styles.divider} />
        <View style={styles.row}><Text style={styles.label}>{t('settings.version')}</Text><Text style={styles.value}>{Constants.expoConfig?.version ?? t('settings.development')}</Text></View>
      </View>
    </ScrollView>
  </SafeAreaView>;
}

const makeStyles = (theme: Theme, fontScale: number) => StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.color.background },
  content: { width: '100%', maxWidth: theme.layout.contentWidth, alignSelf: 'center', padding: 20, paddingTop: 20, paddingBottom: 32, gap: 24 },
  row: { minHeight: 56, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: theme.color.surface, borderRadius: theme.radius.card, flexDirection: fontScale > 1.4 ? 'column' : 'row', alignItems: fontScale > 1.4 ? 'flex-start' : 'center', justifyContent: 'space-between', gap: 12 },
  appearanceRow: { flexWrap: fontScale > 1.4 ? 'nowrap' : 'wrap' },
  group: { backgroundColor: theme.color.surface, borderRadius: theme.radius.card, overflow: 'hidden' },
  label: { color: theme.color.ink, fontSize: 16, lineHeight: 24, flexShrink: fontScale > 1.4 ? 0 : 1 },
  value: { color: theme.color.muted, fontSize: 14, lineHeight: 22, flexShrink: fontScale > 1.4 ? 0 : 1, textAlign: fontScale > 1.4 ? 'left' : 'right' },
  serviceValue: { flexShrink: 1, minWidth: 0 },
  trailing: { alignSelf: fontScale > 1.4 ? 'stretch' : 'auto', minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: fontScale > 1.4 ? 0 : 1 },
  pressed: { backgroundColor: theme.color.subtle },
  primaryPressed: { backgroundColor: theme.color.accentPressed },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border, marginLeft: 16 },
  segment: { alignSelf: fontScale > 1.4 ? 'stretch' : 'auto', flexDirection: fontScale > 1.4 ? 'column' : 'row', padding: 4, flexShrink: fontScale > 1.4 ? 0 : 1, backgroundColor: theme.color.subtle, borderRadius: theme.radius.field },
  segmentButton: { minWidth: 64, flexShrink: fontScale > 1.4 ? 0 : 1, minHeight: 48, padding: 8, alignItems: 'center', justifyContent: 'center', borderRadius: theme.radius.field },
  segmentSelected: { backgroundColor: theme.color.accent },
  segmentText: { color: theme.color.muted, fontSize: 16, lineHeight: 24 },
  segmentSelectedText: { color: theme.color.onAccent, fontWeight: '500' },
});
