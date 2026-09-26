import type { ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { usePathname } from 'expo-router';
import { useTheme, type Theme } from '../ui/theme';
import { useAccountAuth } from './auth-provider';
import { AccountHomePanel } from './screens/home';
import { SplitContext } from './split-context';
import { accountDividerWidth, accountSidebarWidth, canSplitAccount } from './split-width';

/** iPad and wide-window frame: the account list stays permanently visible and the selected sub-page
 *  opens beside it. Narrow windows and portrait split view keep the single-column push stack. */
export function AccountFrame({ children }: { children: ReactNode }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const { width } = useWindowDimensions();
  const { state } = useAccountAuth();
  const pathname = usePathname();
  const wide = canSplitAccount(width);
  const split = wide && state.status === 'authenticated' && !pathname.startsWith('/account/delete/');
  if (!split) return <SplitContext.Provider value={false}>{children}</SplitContext.Provider>;
  return <SplitContext.Provider value={true}>
    <View style={styles.row}>
      <View style={styles.side}><AccountHomePanel mode="sidebar" /></View>
      <View style={styles.divider} />
      <View style={styles.detail}>{children}</View>
    </View>
  </SplitContext.Provider>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  row: { flex: 1, flexDirection: 'row', backgroundColor: theme.color.background },
  side: { width: accountSidebarWidth },
  divider: { width: accountDividerWidth, backgroundColor: theme.color.border },
  detail: { flex: 1 },
});
