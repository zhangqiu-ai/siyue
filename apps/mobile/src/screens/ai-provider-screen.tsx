import { zh } from '../i18n/messages';
import { useLocale } from '../i18n';
import { AppIcon } from '../ui/icon';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Stack, useFocusEffect, useNavigation } from 'expo-router';
import { usePreventRemove } from 'expo-router/react-navigation';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { normalizeBaseUrl } from '../chat/compatible-transport';
import { fetchCompatibleModels } from '../settings/model-catalog';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAISettings } from '../settings/ai-settings';
import { PROVIDERS, findProvider, type ProviderPreset } from '../settings/providers';
import { aiProviderStatusTone, type AIProviderStatusTone } from '../settings/ai-provider-status';
import { useTheme, type Theme } from '../ui/theme';

export default function AIProviderScreen() {
  const { t, errorText: translateError } = useLocale();
  const theme = useTheme();
  const styles = makeStyles(theme);
  const settings = useAISettings();
  const navigation = useNavigation();
  const discardPromptOpen = useRef(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelQuery, setModelQuery] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [addressOpen, setAddressOpen] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | 'test' | 'models' | null>(null);
  const [notice, setNotice] = useState('');
  const testController = useRef<AbortController | null>(null);
  const modelsController = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!settings.ready) return;
    setModels([]);
    setBaseUrl(settings.config?.baseUrl ?? '');
    setModel(settings.config?.model ?? '');
    setProviderId(settings.config ? findProvider(settings.config.baseUrl)?.id ?? 'custom' : '');
    setAddressOpen(Boolean(settings.config && !findProvider(settings.config.baseUrl)));
  }, [settings.ready, settings.config]);
  const cancelTest = useCallback(() => {
    if (!testController.current) return;
    testController.current.abort();
    testController.current = null;
    if (mounted.current) {
      setBusy(null);
      setNotice('ai.cancelledTest');
    }
  }, []);
  const cancelModels = useCallback(() => {
    modelsController.current?.abort();
    modelsController.current = null;
    if (mounted.current) setBusy(value => value === 'models' ? null : value);
  }, []);
  useFocusEffect(useCallback(() => () => { cancelTest(); cancelModels(); }, [cancelTest, cancelModels]));

  const refreshModels = async () => {
    const controller = new AbortController();
    modelsController.current = controller;
    const sessionSignal = settings.getSessionSignal();
    const abort = () => controller.abort();
    sessionSignal.addEventListener('abort', abort, { once: true });
    setBusy('models'); setNotice('');
    try {
      const endpoint = normalizeBaseUrl(baseUrl);
      let secret = apiKey.trim();
      if (!secret) {
        if (!settings.hasKey) throw new Error('ai.needKey');
        const saved = await settings.getCredentials();
        if (saved.baseUrl !== endpoint) throw new Error('ai.changedEndpoint');
        secret = saved.apiKey;
      }
      if (sessionSignal.aborted) controller.abort();
      const result = await fetchCompatibleModels({ baseUrl: endpoint, apiKey: secret }, controller.signal, expoFetch);
      if (!mounted.current || modelsController.current !== controller || controller.signal.aborted) return;
      setModels(result); setModel(value => result.includes(value) ? value : ''); setModelQuery(''); setModelPickerOpen(true);
    } catch (error) {
      if (mounted.current && modelsController.current === controller) setNotice(controller.signal.aborted ? 'ai.cancelledModels' : error instanceof Error ? error.message : 'ai.modelsFailed');
    } finally {
      sessionSignal.removeEventListener('abort', abort);
      if (mounted.current && modelsController.current === controller) { modelsController.current = null; setBusy(null); }
    }
  };

  const save = async () => {
    setBusy('save');
    setNotice('');
    try {
      await settings.save({ baseUrl, model, apiKey });
      if (mounted.current) {
        setApiKey('');
        setNotice('ai.saved');
      }
    } catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : 'ai.saveFailed');
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const remove = async () => {
    setBusy('remove');
    setNotice('');
    try {
      await settings.remove();
      if (mounted.current) {
        setApiKey('');
        setNotice('ai.removed');
      }
    } catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : 'ai.removeFailed');
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const test = async () => {
    const controller = new AbortController();
    testController.current = controller;
    setBusy('test');
    setNotice('ai.testing');
    try {
      await settings.testConnection(controller.signal);
      if (mounted.current && testController.current === controller) setNotice('ai.connected');
    } catch (error) {
      if (mounted.current && testController.current === controller) setNotice(error instanceof Error ? error.message : 'ai.connectionFailed');
    } finally {
      if (mounted.current && testController.current === controller) {
        testController.current = null;
        setBusy(null);
      }
    }
  };
  const disabled = !settings.ready || busy !== null;
  const changed = baseUrl.trim().replace(/\/+$/, '') !== (settings.config?.baseUrl ?? '') || model.trim() !== (settings.config?.model ?? '') || apiKey !== '';
  const savedProviderId = settings.config ? findProvider(settings.config.baseUrl)?.id ?? 'custom' : '';
  const hasUnsavedChanges = settings.ready && (baseUrl !== (settings.config?.baseUrl ?? '') || model !== (settings.config?.model ?? '') || apiKey !== '' || providerId !== savedProviderId);
  const writing = busy === 'save' || busy === 'remove';
  const confirmDiscard = (proceed: () => void) => {
    if (writing) {
      Alert.alert(t('ai.waitTitle'), busy === 'save' ? t('ai.waitSave') : t('ai.waitRemove'));
      return;
    }
    if (!hasUnsavedChanges) { proceed(); return; }
    if (discardPromptOpen.current) return;
    discardPromptOpen.current = true;
    Alert.alert(t('ai.discardTitle'), t('ai.discardBody'), [
      { text: t('ai.keepEditing'), style: 'cancel', onPress: () => { discardPromptOpen.current = false; } },
      { text: t('ai.discard'), style: 'default', onPress: () => { discardPromptOpen.current = false; proceed(); } },
    ], { cancelable: true, onDismiss: () => { discardPromptOpen.current = false; } });
  };
  usePreventRemove(hasUnsavedChanges || writing, ({ data }) => {
    confirmDiscard(() => navigation.dispatch(data.action));
  });
  const button = (label: string, onPress: () => void, options: { primary?: boolean; disabled?: boolean; testID?: string } = {}) => (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: options.disabled ?? false }} disabled={options.disabled} testID={options.testID} onPress={onPress} style={({ pressed }) => [styles.button, options.primary && styles.primaryButton, options.disabled && styles.dimmed, pressed && (options.primary ? styles.primaryPressed : styles.pressed)]}>
      <Text style={[styles.buttonText, options.primary && styles.primaryButtonText]}>{label}</Text>
    </Pressable>
  );

  const provider = PROVIDERS.find(item => item.id === providerId);
  const sameEndpoint = baseUrl.trim().replace(/\/+$/, '') === settings.config?.baseUrl;
  const selectProvider = (preset: ProviderPreset) => {
    if (preset.id === providerId) { setPickerOpen(false); return; }
    confirmDiscard(() => {
      setProviderId(preset.id); setBaseUrl(preset.baseUrl); setModel(''); setModels([]);
      setApiKey(''); setNotice(''); setAddressOpen(preset.id === 'custom'); setPickerOpen(false);
    });
  };
  const providerText = (item: ProviderPreset, field: 'name' | 'subtitle') => t(`provider.${item.id}.${field}` as keyof typeof zh);
  const filtered = PROVIDERS.filter(item => `${providerText(item, 'name')} ${providerText(item, 'subtitle')} ${item.name} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const status = (message: string, tone: AIProviderStatusTone) => {
    const color = tone === 'error' ? theme.color.error : tone === 'success' ? theme.color.accent : theme.color.ink;
    return <View accessibilityRole={tone === 'error' ? 'alert' : undefined} accessibilityLiveRegion="polite" style={styles.status}>
      <AppIcon name={tone === 'error' ? 'warning' : tone === 'success' ? 'success' : 'info'} color={color} size={20} />
      <Text style={[styles.statusText, {color}]}>{message}</Text>
    </View>;
  };
  return <SafeAreaView style={styles.page} edges={['bottom']}>
    <Stack.Screen options={{ headerShown: true, title: t('settings.aiService'), headerBackTitle: t('common.back'), headerBackButtonDisplayMode: 'minimal', headerTintColor: theme.color.ink, headerStyle: { backgroundColor: theme.color.background } }} />
    <ScrollView contentContainerStyle={styles.content} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <Pressable accessibilityRole="button" accessibilityLabel={t('ai.selectProviderLabel')} testID="ai-provider-picker" accessibilityState={{ disabled }} disabled={disabled} onPress={() => { setQuery(''); setPickerOpen(true); }} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <Text style={[styles.rowTitle, styles.flex]}>{provider ? providerText(provider, 'name') : t('ai.selectProvider')}</Text>
        <AppIcon name="chevronRight" size={20} color={theme.color.muted} />
      </Pressable>
      {provider ? <>
        <View style={styles.group}>
          <View style={styles.field}>
            <View style={styles.inline}><Text style={styles.label}>{t('ai.key')}</Text><Text style={styles.note}>{settings.hasKey && sameEndpoint ? t('ai.keySaved') : t('settings.unconfigured')}</Text></View>
            <TextInput accessibilityLabel={t('ai.keyLabel')} testID="ai-api-key" style={styles.input} value={apiKey} onChangeText={value => { setApiKey(value); setModels([]); setModel(''); }} placeholder={settings.hasKey && sameEndpoint ? t('ai.keepKey') : t('ai.pasteKey')} placeholderTextColor={theme.color.muted} selectionColor={theme.color.accent} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none" editable={!disabled} maxLength={512} />
          </View>
          <View style={styles.divider} />
          <View style={styles.field}>
            <View style={styles.inline}>
              <Text style={styles.label}>{t('ai.model')}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={t('ai.refreshModels')} accessibilityState={{ disabled: disabled || !baseUrl.trim() || (!apiKey.trim() && !(settings.hasKey && sameEndpoint)), busy: busy === 'models' }} testID="ai-model-refresh" disabled={disabled || !baseUrl.trim() || (!apiKey.trim() && !(settings.hasKey && sameEndpoint))} onPress={() => { void refreshModels(); }} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
                {busy === 'models' ? <ActivityIndicator color={theme.color.ink} /> : <AppIcon name="retry" />}
              </Pressable>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel={t('ai.selectModel')} testID="ai-model" accessibilityState={{ disabled }} disabled={disabled} onPress={() => { if (models.length) { setModelQuery(''); setModelPickerOpen(true); } else { void refreshModels(); } }} style={({ pressed }) => [styles.inline, pressed && styles.pressed]}>
              <Text style={[styles.input, styles.flex]}>{model || t('ai.fetchModels')}</Text><AppIcon name="chevronRight" size={20} color={theme.color.muted} />
            </Pressable>
          </View>
          <View style={styles.divider} />
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: addressOpen }} onPress={() => setAddressOpen(value => !value)} style={({ pressed }) => [styles.addressRow, pressed && styles.pressed]}>
            <Text style={styles.label}>{t('ai.endpoint')}</Text><AppIcon name={addressOpen ? 'chevronDown' : 'chevronRight'} size={20} color={theme.color.muted} />
          </Pressable>
          {addressOpen ? <View style={styles.addressField}>
            <TextInput accessibilityLabel={t('ai.endpointLabel')} testID="ai-base-url" style={styles.input} value={baseUrl} onChangeText={value => { setBaseUrl(value); setApiKey(''); setModels([]); setModel(''); }} placeholder="https://…/v1" placeholderTextColor={theme.color.muted} selectionColor={theme.color.accent} autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!disabled} maxLength={1000} />
            <Text style={styles.note}>{t('ai.endpointNote')}</Text>
          </View> : null}
        </View>
        <Text style={styles.footnote}>{t('ai.privacy', { host: baseUrl ? (() => { try { return new URL(baseUrl).hostname; } catch { return t('ai.enteredAddress'); } })() : t('ai.enteredAddress') })}</Text>
      </> : <Text style={styles.footnote}>{t('ai.compatible')}</Text>}
      {settings.storageError ? status(translateError(settings.storageError), 'error') : null}
      {!settings.ready ? <Text style={styles.note}>{t('ai.loading')}</Text> : null}
      {provider ? <View style={styles.actions}>
        {button(busy === 'save' ? t('ai.saving') : t('common.save'), () => { void save(); }, { primary: true, disabled: disabled || !changed || !baseUrl.trim() || !model.trim(), testID: 'ai-save' })}
        <Text style={styles.footnote}>{t('ai.saveWarning')}</Text>
        {busy === 'test' ? button(t('ai.cancelTest'), cancelTest, { testID: 'ai-test-cancel' }) : button(t('ai.test'), () => { void test(); }, { disabled: disabled || !settings.config || !settings.hasKey || changed, testID: 'ai-test' })}
        <Text style={styles.footnote}>{changed && settings.config ? t('ai.saveFirst') : t('ai.testWarning')}</Text>
      </View> : null}
      {busy === 'models' ? button(t('ai.cancelFetch'), () => { cancelModels(); setNotice('ai.cancelledModels'); }, { testID: 'ai-model-cancel' }) : null}
      {notice ? status(Object.hasOwn(zh, notice) ? t(notice as keyof typeof zh) : translateError(notice), aiProviderStatusTone(notice)) : null}
      {(settings.config || settings.hasKey || settings.storageError) ? button(busy === 'remove' ? t('ai.removing') : t('ai.removeConfig'), () => Alert.alert(t('ai.removeTitle'), t('ai.removeBody'), [{ text: t('common.cancel'), style: 'cancel' }, { text: t('common.remove'), style: 'destructive', onPress: () => { void remove(); } }]), { disabled, testID: 'ai-remove' }) : null}
    </ScrollView>
    <Modal visible={modelPickerOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setModelPickerOpen(false)}>
      <SafeAreaView style={styles.page} edges={['top', 'bottom']}>
        <View style={styles.modalContent}>
        <View style={styles.modalHeader}><Text style={styles.heading}>{t('ai.model')}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('ai.closeModels')} onPress={() => setModelPickerOpen(false)} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}><AppIcon name="close" /></Pressable></View>
        <TextInput selectionColor={theme.color.accent} accessibilityLabel={t('ai.searchModels')} style={styles.search} value={modelQuery} onChangeText={setModelQuery} placeholder={t('ai.searchModels')} placeholderTextColor={theme.color.muted} autoCorrect={false} clearButtonMode="while-editing" />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.providerList}>
          {models.filter(item => item.toLowerCase().includes(modelQuery.trim().toLowerCase())).map(item => <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: item === model }} onPress={() => { setModel(item); setModelPickerOpen(false); setNotice(''); }} style={({ pressed }) => [styles.providerRow, pressed && styles.pressed]}>
            <Text style={[styles.rowTitle, styles.flex]}>{item}</Text>{item === model ? <AppIcon name="check" /> : null}
          </Pressable>)}
          {!models.some(item => item.toLowerCase().includes(modelQuery.trim().toLowerCase())) ? <Text style={styles.footnote}>{t('ai.noModels')}</Text> : null}
        </ScrollView>
        </View>
      </SafeAreaView>
    </Modal>
    <Modal visible={pickerOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPickerOpen(false)}>
      <SafeAreaView style={styles.page} edges={['top', 'bottom']}>
        <View style={styles.modalContent}>
        <View style={styles.modalHeader}><Text style={styles.heading}>{t('ai.providers')}</Text><Pressable accessibilityRole="button" accessibilityLabel={t('ai.closeProviders')} onPress={() => setPickerOpen(false)} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}><AppIcon name="close" /></Pressable></View>
        <TextInput selectionColor={theme.color.accent} accessibilityLabel={t('ai.searchProviders')} testID="ai-provider-search" style={styles.search} value={query} onChangeText={setQuery} placeholder={t('ai.searchProviders')} placeholderTextColor={theme.color.muted} autoCorrect={false} clearButtonMode="while-editing" />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.providerList}>
          {filtered.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: item.id === providerId }} onPress={() => selectProvider(item)} style={({ pressed }) => [styles.providerRow, pressed && styles.pressed]}>
            <View style={styles.flex}><Text style={styles.rowTitle}>{providerText(item, 'name')}</Text><Text style={styles.note}>{providerText(item, 'subtitle')}</Text></View><AppIcon name={item.id === providerId ? 'check' : 'chevronRight'} size={20} color={theme.color.muted} />
          </Pressable>)}
          {!filtered.length ? <Text style={styles.footnote}>{t('ai.noProviders')}</Text> : null}
        </ScrollView>
        </View>
      </SafeAreaView>
    </Modal>
  </SafeAreaView>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.color.background },
  content: { width: '100%', maxWidth: theme.layout.contentWidth, alignSelf: 'center', padding: 20, paddingTop: 16, paddingBottom: 32 },
  row: { minHeight: 56, padding: 16, backgroundColor: theme.color.surface, borderRadius: theme.radius.card, flexDirection: 'row', alignItems: 'center', gap: 12 },
  flex: { flex: 1, gap: 4 },
  rowTitle: { color: theme.color.ink, fontSize: 16, lineHeight: 24, fontWeight: '500' },
  group: { marginTop: 24, backgroundColor: theme.color.surface, borderRadius: theme.radius.card, overflow: 'hidden' },
  field: { padding: 16, gap: 8 },
  inline: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  note: { color: theme.color.muted, fontSize: 13, lineHeight: 20, flexShrink: 1 },
  label: { color: theme.color.ink, fontSize: 16, lineHeight: 24, flexShrink: 1, fontWeight: '500' },
  input: { minHeight: 48, paddingVertical: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: theme.color.controlBorder, borderRadius: theme.radius.field, color: theme.color.ink, fontSize: 16, lineHeight: 24 },
  divider: { marginLeft: 16, height: StyleSheet.hairlineWidth, backgroundColor: theme.color.border },
  addressRow: { minHeight: 56, paddingVertical: 12, gap: 12, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  addressField: { paddingHorizontal: 16, paddingBottom: 16, gap: 8 },
  footnote: { color: theme.color.muted, fontSize: 14, lineHeight: 22, paddingHorizontal: 4, marginTop: 8 },
  actions: { gap: 4, marginTop: 24, marginBottom: 16 },
  button: { minHeight: 48, padding: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: theme.color.surface },
  primaryButton: { backgroundColor: theme.color.accent },
  buttonText: { color: theme.color.ink, fontSize: 16, lineHeight: 24, fontWeight: '500', textAlign: 'center' },
  primaryButtonText: { color: theme.color.onAccent },
  pressed: { backgroundColor: theme.color.subtle },
  primaryPressed: { backgroundColor: theme.color.accentPressed },
  dimmed: { opacity: 0.4 },
  status: { padding: 12, marginBottom: 12, borderRadius: 12, backgroundColor: theme.color.subtle, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  statusText: { flex: 1, fontSize: 14, lineHeight: 22 },
  modalContent: { flex: 1, width: '100%', maxWidth: theme.layout.contentWidth, alignSelf: 'center' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 16 },
  heading: { color: theme.color.ink, fontSize: 24, lineHeight: 36, flexShrink: 1, fontWeight: '600' },
  closeButton: { minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center' },
  search: { minHeight: 48, margin: 20, padding: 12, borderRadius: theme.radius.field, borderWidth: 1, borderColor: theme.color.controlBorder, color: theme.color.ink, backgroundColor: theme.color.subtle, fontSize: 16, lineHeight: 24 },
  providerList: { paddingHorizontal: 20, paddingBottom: 32 },
  providerRow: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.border, paddingVertical: 16 },
});
