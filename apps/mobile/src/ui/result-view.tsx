import { StyleSheet, Text, View } from 'react-native';
import { AppIcon, type IconName } from './icon';
import { useTheme, type Theme } from './theme';

export function ResultView({ icon = 'success', title, body }: { icon?: IconName; title: string; body?: string }) {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return <View style={styles.page}>
    <View style={styles.ring}><AppIcon name={icon} size={38} color={theme.color.accent} /></View>
    <Text style={styles.title}>{title}</Text>
    {body ? <Text style={styles.body}>{body}</Text> : null}
  </View>;
}

const makeStyles = (theme: Theme) => StyleSheet.create({
  page: { alignItems: 'center', paddingTop: 80 },
  ring: { width: 84, height: 84, borderRadius: 42, backgroundColor: theme.color.focus, alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  title: { color: theme.color.ink, fontSize: 26, lineHeight: 34, fontWeight: '600', textAlign: 'center', marginBottom: 10 },
  body: { color: theme.color.muted, fontSize: 16, lineHeight: 24, textAlign: 'center', maxWidth: 300 },
});
