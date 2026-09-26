import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme, type Theme } from './theme';

export function Screen({ title, lead, children, footer, scroll = true, maxWidth = 560, testID }: {
  title?: string;
  lead?: string;
  children?: ReactNode;
  footer?: ReactNode;
  scroll?: boolean;
  maxWidth?: number;
  testID?: string;
}) {
  const theme = useTheme();
  const styles = makeStyles(theme, maxWidth);
  const content = <>
    {title ? <Text style={[styles.title, !lead && styles.titleAlone]}>{title}</Text> : null}
    {lead ? <Text style={styles.lead}>{lead}</Text> : null}
    {children}
  </>;
  return <SafeAreaView edges={['bottom']} style={styles.page}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
      {scroll
        ? <ScrollView testID={testID} style={styles.fill} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">{content}</ScrollView>
        : <View style={[styles.content, styles.contentFixed]}>{content}</View>}
      {footer ? <View style={styles.footer}><View style={styles.footerInner}>{footer}</View></View> : null}
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const makeStyles = (theme: Theme, maxWidth: number) => StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.color.background },
  fill: { flex: 1 },
  content: { width: '100%', maxWidth, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 4, paddingBottom: 24 },
  contentFixed: { flex: 1 },
  title: { color: theme.color.ink, fontSize: 30, lineHeight: 38, fontWeight: '600', letterSpacing: -0.3, marginTop: 4, marginBottom: 8 },
  titleAlone: { marginBottom: 24 },
  lead: { color: theme.color.muted, fontSize: 16, lineHeight: 24, marginBottom: 24 },
  footer: { paddingHorizontal: 20, paddingVertical: 12, backgroundColor: theme.color.background },
  footerInner: { width: '100%', maxWidth, alignSelf: 'center', flexDirection: 'column', gap: 10 },
});
