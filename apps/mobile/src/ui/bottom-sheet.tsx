import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import type { ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme, type Theme } from './theme';

// Mirrors the prototype scrim; the palette has no token for it yet.
const scrim = { light: 'rgba(24,32,26,0.34)', dark: 'rgba(0,0,0,0.5)' };
const wideWidth = 700;

export function BottomSheet({ visible, onClose, title, description, children }: { visible: boolean; onClose: () => void; title?: string; description?: string; children?: ReactNode }) {
  const theme = useTheme();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const wide = width >= wideWidth;
  const styles = makeStyles(theme, insets.bottom, wide, height * 0.85);
  return <Modal visible={visible} transparent statusBarTranslucent animationType={wide ? 'fade' : 'slide'} onRequestClose={onClose}>
    <View style={styles.page}>
      <Pressable accessibilityRole="button" onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: theme.mode === 'dark' ? scrim.dark : scrim.light }]} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} pointerEvents="box-none" style={styles.positioner}>
        <View accessibilityViewIsModal accessibilityLabel={title} style={styles.sheet}>
          {wide ? null : <View style={styles.grabber} />}
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetContent}>
            {title ? <Text style={styles.title}>{title}</Text> : null}
            {description ? <Text style={styles.description}>{description}</Text> : null}
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </View>
  </Modal>;
}

const makeStyles = (theme: Theme, bottom: number, wide: boolean, maxHeight: number) => StyleSheet.create({
  page: { flex: 1 },
  positioner: { flex: 1, justifyContent: wide ? 'center' : 'flex-end', alignItems: wide ? 'center' : 'stretch' },
  sheet: {
    width: wide ? 460 : undefined,
    maxHeight,
    backgroundColor: theme.color.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderRadius: wide ? 24 : undefined,
    paddingHorizontal: wide ? 24 : 20,
    paddingTop: wide ? 24 : 10,
    paddingBottom: wide ? 24 : 12 + bottom,
  },
  sheetContent: { paddingBottom: 4 },
  grabber: { width: 36, height: 5, borderRadius: 3, backgroundColor: theme.color.border, alignSelf: 'center', marginBottom: 16 },
  title: { color: theme.color.ink, fontSize: 22, lineHeight: 28, fontWeight: '600', marginTop: 4, marginBottom: 6 },
  description: { color: theme.color.muted, fontSize: 15, lineHeight: 22, marginBottom: 18 },
});
