import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.eyebrow}>SIYUE · 思玥</Text>
      <Text style={styles.title}>今天，想往哪里成长？</Text>
      <Text style={styles.body}>
        AI-first personal growth. The first slice will turn a goal into an editable, confirmable action plan.
      </Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 28, gap: 12 },
  eyebrow: { fontSize: 13, letterSpacing: 1.6, opacity: 0.55 },
  title: { fontSize: 34, lineHeight: 42, fontWeight: '700' },
  body: { fontSize: 16, lineHeight: 25, opacity: 0.68 },
});
