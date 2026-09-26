import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { AppIcon } from '../ui/icon';
import { Screen } from '../ui/screen';
import { useTheme, type Theme } from '../ui/theme';
import { useLocale } from '../i18n';
import { accountText } from './account-messages';
import { useSplitDetail } from './split-context';

/** The account header: only a 44pt circular control, as the approved design keeps the large title in
 *  the page body. In the wide window's detail pane the account list is already the way back, so no
 *  control is rendered there. */
export function AccountNav({ kind = 'back', onPress, right, accessibilityLabel }: {
  kind?: 'back' | 'close' | 'none';
  onPress?: () => void;
  right?: ReactNode;
  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const { locale } = useLocale();
  const text = accountText(locale);
  const split = useSplitDetail();
  const shown = split && kind === 'back' ? 'none' : kind;
  const label = accessibilityLabel ?? (shown === 'close' ? text.close : text.back);
  return <View style={styles.row}>
    {shown === 'none' ? <View style={styles.spacer} /> : <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={shown === 'close' ? 'account-close' : 'account-back'}
      onPress={onPress ?? (() => { if (router.canGoBack()) router.back(); })}
      style={({ pressed }) => [styles.button, pressed && { backgroundColor: theme.color.subtle }]}
    ><AppIcon name={shown === 'close' ? 'close' : 'back'} size={20} color={theme.color.ink} /></Pressable>}
    {right ? <View style={styles.right}>{right}</View> : null}
  </View>;
}

/** One account page: the header row stays outside the scroll area and the body uses the shared screen
 *  frame, so every account route keeps the same title, lead and footer placement. */
export function AccountPage({ title, lead, children, footer, scroll = true, maxWidth = 560, nav = 'back', onNavBack, navRight, testID }: {
  title?: string;
  lead?: string;
  children?: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
  maxWidth?: number;
  nav?: 'back' | 'close' | 'none';
  onNavBack?: () => void;
  navRight?: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <View style={styles.page}>
    <AccountNav kind={nav} onPress={onNavBack} right={navRight} />
    <Screen title={title} lead={lead} footer={footer} scroll={scroll} maxWidth={maxWidth} testID={testID}>{children}</Screen>
  </View>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.color.background },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44, paddingHorizontal: 8, paddingTop: 4 },
  spacer: { width: 44, height: 44 },
  button: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  right: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 8 },
});
