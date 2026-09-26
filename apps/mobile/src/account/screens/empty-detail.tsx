import { StyleSheet, Text, View } from 'react-native';
import { useLocale } from '../../i18n';
import { accountText } from '../account-messages';
import { useTheme, type Theme } from '../../ui/theme';

/** The wide window's detail pane before a row is chosen; the account list on the left is the choice. */
export function EmptyDetail() {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const { locale } = useLocale();
  return <View style={styles.page}><Text style={styles.text}>{accountText(locale).emptyDetail}</Text></View>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  text: { color: theme.color.muted, fontSize: 16, lineHeight: 24 },
});
