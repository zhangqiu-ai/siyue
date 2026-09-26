import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { scopeKey, useWorkspace } from '../account/workspace-provider';
import { useLocale } from '../i18n';
import { AppIcon, BottomSheet, Button, useTheme, useToast, type Theme } from '../ui';

export type SpaceInfo = { key: string; kind: 'local' | 'account'; name: string; subtitle: string; badge: string };

/** The spaces this device can actually show right now. Family spaces appear only once the workspace exposes them. */
export function useCurrentSpace(): SpaceInfo {
  const { state } = useWorkspace();
  const { t } = useLocale();
  const account = state.scope?.kind === 'account';
  const name = account ? t('shell.accountSpace') : t('shell.localSpace');
  return { key: scopeKey(state), kind: account ? 'account' : 'local', name, subtitle: account ? t('shell.accountSub') : t('shell.localSub'), badge: [...name][0] ?? '·' };
}

const Context = createContext<{ open: () => void }>({ open: () => {} });
export const useSpaceSwitcher = () => useContext(Context);

export function SpaceBadge({ label, size = 40 }: { label: string; size?: number }) {
  const theme = useTheme();
  return <View style={{ width: size, height: size, borderRadius: size * 0.3, backgroundColor: theme.color.focus, alignItems: 'center', justifyContent: 'center' }}>
    <Text style={{ fontSize: size * 0.42, fontWeight: '600', color: theme.color.onFocus }}>{label}</Text>
  </View>;
}

export function SpaceSwitcherProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const { host, state } = useWorkspace();
  const { t } = useLocale();
  const theme = useTheme();
  const s = makeStyles(theme);
  const toast = useToast();
  const current = useCurrentSpace();
  const value = useMemo(() => ({ open: () => { setFailed(false); setVisible(true); } }), []);
  const createAccountSpace = async () => {
    if (!host) return;
    setBusy(true); setFailed(false);
    try {
      await host.createAccountSpace(state.revision);
      setVisible(false);
      toast.show(t('shell.switched', { name: t('shell.accountSpace') }));
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return <Context.Provider value={value}>
    {children}
    <BottomSheet visible={visible} onClose={() => { if (!busy) setVisible(false); }} title={t('shell.switchSpace')} description={t('shell.switchNote')}>
      <View style={{ gap: 4 }}>
        <View style={s.row} accessibilityRole="radio" accessibilityState={{ checked: true }}>
          <SpaceBadge label={current.badge} />
          <View style={{ flex: 1 }}><Text style={s.title}>{current.name}</Text><Text style={s.sub}>{current.subtitle}</Text></View>
          <AppIcon name="check" size={20} color={theme.color.accent} />
        </View>
        {state.canCreate && <View style={{ gap: 8, paddingVertical: 8 }}>
          <Button variant="tonal" icon="plus" label={t('shell.createAccountSpace')} loading={busy} onPress={() => void createAccountSpace()} />
          <Text style={s.sub}>{t('shell.createAccountSpaceBody')}</Text>
        </View>}
        {failed && <Text accessibilityRole="alert" style={[s.sub, { color: theme.color.error }]}>{t('shell.switchFailed')}</Text>}
        <Pressable accessibilityRole="button" style={s.row} onPress={() => toast.show(t('shell.familySoon'))}>
          <View style={s.plus}><AppIcon name="plus" size={20} color={theme.color.accent} /></View>
          <Text style={[s.title, { flex: 1 }]}>{t('shell.createFamily')}</Text>
        </Pressable>
      </View>
    </BottomSheet>
  </Context.Provider>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 60, paddingVertical: 8 },
  title: { fontSize: 16, lineHeight: 22, color: theme.color.ink },
  sub: { fontSize: 13, lineHeight: 18, color: theme.color.muted },
  plus: { width: 40, height: 40, borderRadius: 12, backgroundColor: theme.color.subtle, alignItems: 'center', justifyContent: 'center' },
});
