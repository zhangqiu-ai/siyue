import { useState } from 'react';
import { Button, Column, Switch, TextInput } from '@expo/ui';
import { Redirect, Stack } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeHost } from '../src/ui/native-host';
import { theme } from '../src/ui/theme';

export default function UIPreview() {
  const [gentle, setGentle] = useState(true);
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState('');
  if (!__DEV__) return <Redirect href="/" />;
  return <SafeAreaView style={styles.page} edges={['bottom']}>
    <Stack.Screen options={{ headerShown: true, title: '组件预览', headerBackTitle: '返回', headerTintColor: theme.color.ink, headerStyle: { backgroundColor: theme.color.background } }} />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
      <Text style={styles.eyebrow}>SIYUE · UI FOUNDATION</Text>
      <Text style={styles.title} accessibilityRole="header">从一点温暖开始</Text>
      <Text style={styles.body}>思玥的原生组件试用页。配色与排版是探索基线，交互仅在本页预览。</Text>
      <View style={styles.palette}>{[theme.color.orange, theme.color.yellow, theme.color.sage, theme.color.ink].map(color => <View key={color} accessibilityLabel={color} style={[styles.swatch, { backgroundColor: color }]} />)}</View>
      <View style={styles.card}>
        <Text style={styles.heading} accessibilityRole="header">留一点空间给自己</Text>
        <Text style={styles.body}>试试原生输入、开关和按钮。</Text>
        <NativeHost style={styles.host}>
          <Column spacing={16}>
            <TextInput testID="ui-preview-input" placeholder="今天想做的一件小事" onChangeText={setInput} maxLength={160} textStyle={{ color: theme.color.ink, fontSize: 17 }} style={{ padding: 16, borderRadius: theme.radius.field, borderWidth: 1, borderColor: theme.color.border }} />
            <Switch testID="ui-preview-switch" label="温柔一点的语气" value={gentle} onValueChange={setGentle} />
            <Button testID="ui-preview-submit" label="预览这句话" disabled={!input.trim()} onPress={() => setPreview(`${gentle ? '慢慢来，今天先试试：' : '今天的行动：'}${input.trim()}`)} />
          </Column>
        </NativeHost>
        <Text accessibilityLiveRegion="polite" style={styles.result}>{preview || '输入后点击按钮，看看效果。'}</Text>
      </View>
      <Text style={styles.note}>此页不调用 AI，也不保存目标。正式流程可通过左上角返回继续使用。</Text>
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: theme.color.background },
  content: { padding: theme.space.large, gap: theme.space.medium },
  eyebrow: { color: theme.color.muted, fontSize: 12, letterSpacing: 2 },
  title: { color: theme.color.ink, fontSize: 30, fontWeight: '700' },
  heading: { color: theme.color.ink, fontSize: 21, fontWeight: '600' },
  body: { color: theme.color.muted, fontSize: 16, lineHeight: 25 },
  palette: { flexDirection: 'row', gap: 12, paddingVertical: 8 },
  swatch: { width: 40, height: 40, borderRadius: 20 },
  card: { padding: 20, gap: 16, borderRadius: theme.radius.card, backgroundColor: theme.color.surface },
  host: { width: '100%' },
  result: { color: theme.color.ink, fontSize: 16, lineHeight: 25 },
  note: { color: theme.color.muted, fontSize: 14, lineHeight: 22 },
});
