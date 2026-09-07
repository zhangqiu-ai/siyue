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
import { useTheme, type Theme } from '../ui/theme';

export default function AIProviderScreen() {
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
      setNotice('已取消测试。');
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
        if (!settings.hasKey) throw new Error('请先填写 API 密钥。');
        const saved = await settings.getCredentials();
        if (saved.baseUrl !== endpoint) throw new Error('修改服务地址后，请重新填写密钥再获取模型。');
        secret = saved.apiKey;
      }
      if (sessionSignal.aborted) controller.abort();
      const result = await fetchCompatibleModels({ baseUrl: endpoint, apiKey: secret }, controller.signal, expoFetch);
      if (!mounted.current || modelsController.current !== controller || controller.signal.aborted) return;
      setModels(result); setModel(value => result.includes(value) ? value : ''); setModelQuery(''); setModelPickerOpen(true);
    } catch (error) {
      if (mounted.current && modelsController.current === controller) setNotice(controller.signal.aborted ? '已取消获取。' : error instanceof Error ? error.message : '获取模型失败，请重试。');
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
        setNotice('已保存。');
      }
    } catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : '保存失败，请重试。');
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
        setNotice('已移除本机 AI 配置。');
      }
    } catch (error) {
      if (mounted.current) setNotice(error instanceof Error ? error.message : '移除失败，请重试。');
    } finally {
      if (mounted.current) setBusy(null);
    }
  };
  const test = async () => {
    const controller = new AbortController();
    testController.current = controller;
    setBusy('test');
    setNotice('正在测试已保存的服务…');
    try {
      await settings.testConnection(controller.signal);
      if (mounted.current && testController.current === controller) setNotice('连接成功。');
    } catch (error) {
      if (mounted.current && testController.current === controller) setNotice(error instanceof Error ? error.message : '连接失败，请检查配置后重试。');
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
      Alert.alert('请等待操作完成', busy === 'save' ? '配置正在保存，完成后可继续操作。' : '配置正在移除，完成后可继续操作。');
      return;
    }
    if (!hasUnsavedChanges) { proceed(); return; }
    if (discardPromptOpen.current) return;
    discardPromptOpen.current = true;
    Alert.alert('舍弃未保存的修改？', '已填内容将丢失，已保存的配置不受影响。', [
      { text: '继续编辑', style: 'cancel', onPress: () => { discardPromptOpen.current = false; } },
      { text: '舍弃修改', style: 'default', onPress: () => { discardPromptOpen.current = false; proceed(); } },
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
  const filtered = PROVIDERS.filter(item => `${item.name} ${item.subtitle}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <SafeAreaView style={styles.page} edges={['bottom']}>
    <Stack.Screen options={{ headerShown: true, title: 'AI 服务', headerBackTitle: '设置', headerBackButtonDisplayMode: 'minimal', headerTintColor: theme.color.ink, headerStyle: { backgroundColor: theme.color.background } }} />
    <ScrollView contentContainerStyle={styles.content} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <Pressable accessibilityRole="button" accessibilityLabel="选择 AI 供应商" testID="ai-provider-picker" accessibilityState={{ disabled }} disabled={disabled} onPress={() => { setQuery(''); setPickerOpen(true); }} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <Text style={[styles.rowTitle, styles.flex]}>{provider?.name ?? '选择供应商'}</Text>
        <AppIcon name="chevronRight" size={20} color={theme.color.muted} />
      </Pressable>
      {provider ? <>
        <View style={styles.group}>
          <View style={styles.field}>
            <View style={styles.inline}><Text style={styles.label}>API 密钥</Text><Text style={styles.note}>{settings.hasKey && sameEndpoint ? '已安全保存' : '未配置'}</Text></View>
            <TextInput accessibilityLabel="AI API 密钥" testID="ai-api-key" style={styles.input} value={apiKey} onChangeText={value => { setApiKey(value); setModels([]); setModel(''); }} placeholder={settings.hasKey && sameEndpoint ? '留空保留现有密钥' : '粘贴密钥'} placeholderTextColor={theme.color.muted} selectionColor={theme.color.accent} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none" editable={!disabled} maxLength={512} />
          </View>
          <View style={styles.divider} />
          <View style={styles.field}>
            <View style={styles.inline}>
              <Text style={styles.label}>模型</Text>
              <Pressable accessibilityRole="button" accessibilityLabel="刷新模型列表" accessibilityState={{ disabled: disabled || !baseUrl.trim() || (!apiKey.trim() && !(settings.hasKey && sameEndpoint)), busy: busy === 'models' }} testID="ai-model-refresh" disabled={disabled || !baseUrl.trim() || (!apiKey.trim() && !(settings.hasKey && sameEndpoint))} onPress={() => { void refreshModels(); }} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
                {busy === 'models' ? <ActivityIndicator color={theme.color.ink} /> : <AppIcon name="retry" />}
              </Pressable>
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="选择 AI 模型" testID="ai-model" accessibilityState={{ disabled }} disabled={disabled} onPress={() => { if (models.length) { setModelQuery(''); setModelPickerOpen(true); } else { void refreshModels(); } }} style={({ pressed }) => [styles.inline, pressed && styles.pressed]}>
              <Text style={[styles.input, styles.flex]}>{model || '获取模型'}</Text><AppIcon name="chevronRight" size={20} color={theme.color.muted} />
            </Pressable>
          </View>
          <View style={styles.divider} />
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: addressOpen }} onPress={() => setAddressOpen(value => !value)} style={({ pressed }) => [styles.addressRow, pressed && styles.pressed]}>
            <Text style={styles.label}>接口地址</Text><AppIcon name={addressOpen ? 'chevronDown' : 'chevronRight'} size={20} color={theme.color.muted} />
          </Pressable>
          {addressOpen ? <View style={styles.addressField}>
            <TextInput accessibilityLabel="AI 服务地址" testID="ai-base-url" style={styles.input} value={baseUrl} onChangeText={value => { setBaseUrl(value); setApiKey(''); setModels([]); setModel(''); }} placeholder="https://…/v1" placeholderTextColor={theme.color.muted} selectionColor={theme.color.accent} autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!disabled} maxLength={1000} />
            <Text style={styles.note}>仅 HTTPS，不含 /chat/completions。换地址需重填密钥。</Text>
          </View> : null}
        </View>
        <Text style={styles.footnote}>密钥存于本机安全存储。仅当前会话文字发往 {baseUrl ? (() => { try { return new URL(baseUrl).hostname; } catch { return '所填地址'; } })() : '所填地址'}。</Text>
      </> : <Text style={styles.footnote}>支持 OpenAI 兼容接口。</Text>}
      {settings.storageError ? <Text accessibilityRole="alert" style={styles.status}>{settings.storageError}</Text> : null}
      {!settings.ready ? <Text style={styles.note}>正在读取本机配置…</Text> : null}
      {provider ? <View style={styles.actions}>
        {button(busy === 'save' ? '正在保存…' : '保存', () => { void save(); }, { primary: true, disabled: disabled || !changed || !baseUrl.trim() || !model.trim(), testID: 'ai-save' })}
        <Text style={styles.footnote}>保存或移除会停止回复、清空聊天记录。</Text>
        {busy === 'test' ? button('取消测试', cancelTest, { testID: 'ai-test-cancel' }) : button('测试连接', () => { void test(); }, { disabled: disabled || !settings.config || !settings.hasKey || changed, testID: 'ai-test' })}
        <Text style={styles.footnote}>{changed && settings.config ? '修改后请先保存。' : '测试发送“请只回复 OK”，可能产生费用。'}</Text>
      </View> : null}
      {busy === 'models' ? button('取消获取', () => { cancelModels(); setNotice('已取消获取。'); }, { testID: 'ai-model-cancel' }) : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={styles.status}>{notice}</Text> : null}
      {(settings.config || settings.hasKey || settings.storageError) ? button(busy === 'remove' ? '正在移除…' : '移除配置', () => Alert.alert('移除本机 AI 配置？', '将移除本机配置与密钥，停止回复并清空聊天记录。供应商平台的密钥不会被撤销。', [{ text: '取消', style: 'cancel' }, { text: '移除', style: 'destructive', onPress: () => { void remove(); } }]), { disabled, testID: 'ai-remove' }) : null}
    </ScrollView>
    <Modal visible={modelPickerOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setModelPickerOpen(false)}>
      <SafeAreaView style={styles.page} edges={['top', 'bottom']}>
        <View style={styles.modalContent}>
        <View style={styles.modalHeader}><Text style={styles.heading}>模型</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭模型选择" onPress={() => setModelPickerOpen(false)} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}><AppIcon name="close" /></Pressable></View>
        <TextInput accessibilityLabel="搜索模型" style={styles.search} value={modelQuery} onChangeText={setModelQuery} placeholder="搜索模型" placeholderTextColor={theme.color.muted} autoCorrect={false} clearButtonMode="while-editing" />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.providerList}>
          {models.filter(item => item.toLowerCase().includes(modelQuery.trim().toLowerCase())).map(item => <Pressable key={item} accessibilityRole="button" accessibilityState={{ selected: item === model }} onPress={() => { setModel(item); setModelPickerOpen(false); setNotice(''); }} style={({ pressed }) => [styles.providerRow, pressed && styles.pressed]}>
            <Text style={[styles.rowTitle, styles.flex]}>{item}</Text>{item === model ? <AppIcon name="check" /> : null}
          </Pressable>)}
          {!models.some(item => item.toLowerCase().includes(modelQuery.trim().toLowerCase())) ? <Text style={styles.footnote}>无匹配模型</Text> : null}
        </ScrollView>
        </View>
      </SafeAreaView>
    </Modal>
    <Modal visible={pickerOpen} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPickerOpen(false)}>
      <SafeAreaView style={styles.page} edges={['top', 'bottom']}>
        <View style={styles.modalContent}>
        <View style={styles.modalHeader}><Text style={styles.heading}>供应商</Text><Pressable accessibilityRole="button" accessibilityLabel="关闭供应商选择" onPress={() => setPickerOpen(false)} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}><AppIcon name="close" /></Pressable></View>
        <TextInput accessibilityLabel="搜索供应商" testID="ai-provider-search" style={styles.search} value={query} onChangeText={setQuery} placeholder="搜索供应商" placeholderTextColor={theme.color.muted} autoCorrect={false} clearButtonMode="while-editing" />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.providerList}>
          {filtered.map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: item.id === providerId }} onPress={() => selectProvider(item)} style={({ pressed }) => [styles.providerRow, pressed && styles.pressed]}>
            <View style={styles.flex}><Text style={styles.rowTitle}>{item.name}</Text><Text style={styles.note}>{item.subtitle}</Text></View><AppIcon name={item.id === providerId ? 'check' : 'chevronRight'} size={20} color={theme.color.muted} />
          </Pressable>)}
          {!filtered.length ? <Text style={styles.footnote}>无匹配结果，可清空搜索后自定义。</Text> : null}
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
  status: { color: theme.color.ink, fontSize: 14, lineHeight: 22, padding: 12, marginBottom: 12, borderRadius: 12, backgroundColor: theme.color.subtle },
  modalContent: { flex: 1, width: '100%', maxWidth: theme.layout.contentWidth, alignSelf: 'center' },
  modalHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 16 },
  heading: { color: theme.color.ink, fontSize: 24, lineHeight: 36, flexShrink: 1, fontWeight: '600' },
  closeButton: { minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center' },
  search: { minHeight: 48, margin: 20, padding: 12, borderRadius: theme.radius.field, borderWidth: 1, borderColor: theme.color.controlBorder, color: theme.color.ink, backgroundColor: theme.color.subtle, fontSize: 16, lineHeight: 24 },
  providerList: { paddingHorizontal: 20, paddingBottom: 32 },
  providerRow: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.color.border, paddingVertical: 16 },
});
