import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, usePathname } from 'expo-router';
import { useAccountAuth } from '../account/auth-provider';
import { useChatStore } from '../chat/use-chat-store';
import { chatTranslate, relativeTime } from '../chat/format';
import { useLocale } from '../i18n';
import { AppIcon, BottomSheet, Button, TextField, useTheme, useToast, type IconName, type Theme } from '../ui';
import { SpaceBadge, useCurrentSpace, useSpaceSwitcher } from './space-switcher';

type Section = 'chat' | 'space' | 'boards' | null;
export function sectionOf(pathname: string): Section {
  if (pathname === '/' || pathname.startsWith('/chat')) return 'chat';
  if (pathname.startsWith('/space')) return 'space';
  if (pathname.startsWith('/boards') || pathname.startsWith('/whiteboard')) return 'boards';
  return null;
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { t, locale } = useLocale();
  const theme = useTheme();
  const s = makeStyles(theme);
  const pathname = usePathname();
  const section = sectionOf(pathname);
  const space = useCurrentSpace();
  const switcher = useSpaceSwitcher();
  const { conversations, store } = useChatStore();
  const { state: auth } = useAccountAuth();
  const toast = useToast();
  const [menu, setMenu] = useState<{ id: string; title: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const go = (path: '/' | '/space' | '/boards' | '/account' | '/settings') => { onNavigate?.(); router.navigate(path); };
  const nav = (key: Section, path: '/' | '/space' | '/boards', icon: IconName, label: string) => {
    const on = section === key;
    return <Pressable key={path} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => go(path)} style={({ pressed }) => [s.nav, on && { backgroundColor: theme.color.focus }, pressed && !on && { backgroundColor: theme.color.subtle }]}>
      <AppIcon name={icon} size={20} color={on ? theme.color.accent : theme.color.muted} />
      <Text style={[s.navText, on && { color: theme.color.onFocus, fontWeight: '600' }]}>{label}</Text>
    </Pressable>;
  };
  const activeId = pathname.startsWith('/chat/') ? pathname.slice(6) : null;
  const tr = chatTranslate(locale);
  const signedIn = auth.status === 'authenticated' || auth.account !== null;
  return <SafeAreaView edges={['top', 'bottom']} style={s.root}>
    <View style={s.top}>
      <Text style={s.brand}>{t('brand')}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={t('chat.new')} onPress={() => go('/')} style={s.icon}><AppIcon name="compose" size={21} /></Pressable>
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel={t('shell.switchSpace') + '，' + space.name} onPress={switcher.open} style={({ pressed }) => [s.space, pressed && { backgroundColor: theme.color.subtle }]}>
      <SpaceBadge label={space.badge} />
      <View style={{ flex: 1 }}><Text style={s.spaceName}>{space.name}</Text><Text style={s.sub} numberOfLines={1}>{space.subtitle}</Text></View>
      <AppIcon name="chevronDown" size={16} color={theme.color.muted} />
    </Pressable>
    {nav('chat', '/', 'chat', t('shell.chat'))}
    {nav('space', '/space', 'target', t('shell.goals'))}
    {nav('boards', '/boards', 'board', t('shell.boards'))}
    <Text style={s.label}>{t('shell.recent')}</Text>
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 12 }}>
      {conversations.length === 0 && <Text style={[s.sub, { paddingHorizontal: 12 }]}>{t('shell.noRecent')}</Text>}
      {conversations.map((conversation) => {
        const on = activeId === conversation.id;
        return <Pressable key={conversation.id} accessibilityRole="button" accessibilityHint={t('chat.more')} onPress={() => { onNavigate?.(); router.navigate({ pathname: '/chat/[id]', params: { id: conversation.id } }); }}
          onLongPress={() => setMenu({ id: conversation.id, title: conversation.title })} style={({ pressed }) => [s.conv, (on || pressed) && { backgroundColor: theme.color.subtle }]}>
          <Text style={s.convTitle} numberOfLines={1}>{conversation.title || t('chat.number', { count: 1 })}</Text>
          <Text style={s.time}>{relativeTime(conversation.updatedAt, Date.now(), tr, locale)}</Text>
        </Pressable>;
      })}
    </ScrollView>
    <View style={s.foot}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('shell.account')} onPress={() => go('/account')} style={s.me}>
        <View style={s.avatar}><AppIcon name="people" size={16} color={theme.color.onAccent} /></View>
        <Text style={s.meText}>{signedIn ? t('shell.account') : t('shell.signedOut')}</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t('shell.settings')} onPress={() => go('/settings')} style={s.icon}><AppIcon name="settings" size={21} /></Pressable>
    </View>
    <BottomSheet visible={menu !== null && renaming === null && !confirmDelete} onClose={() => setMenu(null)} title={menu?.title}>
      <View style={{ gap: 8 }}>
        <Button variant="tonal" icon="edit" label={t('chat.rename')} onPress={() => setRenaming(menu?.title ?? '')} />
        <Button variant="text" label={t('chat.delete')} onPress={() => setConfirmDelete(true)} />
      </View>
    </BottomSheet>
    <BottomSheet visible={renaming !== null} onClose={() => { setRenaming(null); setMenu(null); }} title={t('chat.rename')}>
      <View style={{ gap: 12 }}>
        <TextField label={t('chat.renameLabel')} value={renaming ?? ''} onChangeText={setRenaming} maxLength={80} />
        <Button label={t('chat.save')} disabled={!renaming?.trim()} onPress={() => { if (menu && renaming?.trim()) store.renameConversation(menu.id, renaming.trim()); setRenaming(null); setMenu(null); }} />
      </View>
    </BottomSheet>
    <BottomSheet visible={confirmDelete} onClose={() => { setConfirmDelete(false); setMenu(null); }} title={t('chat.delete')} description={t('chat.deleteBody')}>
      <View style={{ gap: 8 }}>
        <Button variant="dangerFill" label={t('chat.delete')} onPress={() => {
          if (menu) { store.deleteConversation(menu.id); if (activeId === menu.id) router.navigate('/'); toast.show(t('chat.deleted')); }
          setConfirmDelete(false); setMenu(null);
        }} />
        <Button variant="text" label={t('chat.cancel')} onPress={() => { setConfirmDelete(false); setMenu(null); }} />
      </View>
    </BottomSheet>
  </SafeAreaView>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.background, paddingHorizontal: 14 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 6, paddingTop: 8, paddingBottom: 12 },
  brand: { fontSize: 24, lineHeight: 30, fontWeight: '600', color: theme.color.ink },
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  space: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: theme.color.surface, borderRadius: 18, padding: 12, marginBottom: 10 },
  spaceName: { fontSize: 16, lineHeight: 22, color: theme.color.ink },
  sub: { fontSize: 13, lineHeight: 18, color: theme.color.muted },
  nav: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, borderRadius: 14, paddingHorizontal: 12 },
  navText: { fontSize: 16, color: theme.color.ink },
  label: { fontSize: 13, color: theme.color.muted, fontWeight: '500', marginTop: 18, marginBottom: 6, marginHorizontal: 12 },
  conv: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, borderRadius: 12, paddingHorizontal: 12 },
  convTitle: { flex: 1, fontSize: 15, color: theme.color.ink },
  time: { fontSize: 12, color: theme.color.muted },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.color.border, paddingTop: 10 },
  me: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44, paddingHorizontal: 6 },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: theme.color.accent, alignItems: 'center', justifyContent: 'center' },
  meText: { fontSize: 15, color: theme.color.ink },
});
