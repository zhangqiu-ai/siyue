import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Image, PanResponder, Pressable, ScrollView, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useNavigation, usePreventRemove } from 'expo-router/react-navigation';
import Storage from 'expo-sqlite/kv-store';
import { useLocale, type MessageKey } from '../i18n';
import { useTheme } from '../ui/theme';
import { AppIcon } from '../ui/icon';
import { addPage, appendStroke, BOARD_HEIGHT, BOARD_WIDTH, createBoard, eraseAt, type BoardDocument, type Point, type Stroke } from '../whiteboard/model';
import { loadBoard, saveBoard } from '../whiteboard/storage';

const colors: { inkColor: string; label: MessageKey }[] = [
  { inkColor: '#25352B', label: 'board.black' }, { inkColor: '#476B53', label: 'board.green' },
  { inkColor: '#A33E32', label: 'board.red' }, { inkColor: '#285DA5', label: 'board.blue' },
];
const widths: { size: number; label: MessageKey }[] = [
  { size: 4, label: 'board.thin' }, { size: 8, label: 'board.medium' }, { size: 16, label: 'board.thick' },
];

const Ink = memo(function Ink({ stroke, scale }: { stroke: Stroke; scale: number }) {
  const width = Math.max(1, stroke.width * scale);
  return <>{stroke.points.map((point, index) => {
    const previous = stroke.points[index - 1] ?? point;
    const dx = (point.x - previous.x) * scale, dy = (point.y - previous.y) * scale;
    const length = Math.hypot(dx, dy);
    return <View key={index} style={{ position: 'absolute', left: (point.x + previous.x) * scale / 2 - (length + width) / 2,
      top: (point.y + previous.y) * scale / 2 - width / 2, width: length + width, height: width,
      backgroundColor: stroke.color, borderRadius: width / 2, transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }] }} />;
  })}</>;
});

export default function WhiteboardScreen() {
  const theme = useTheme(), { t } = useLocale(), router = useRouter(), navigation = useNavigation();
  const [initial] = useState(() => {
    try { return { document: loadBoard(Storage), failed: false }; }
    catch { return { document: createBoard(), failed: true }; }
  });
  const [document, setDocument] = useState(initial.document);
  const current = useRef(document);
  const [readFailed, setReadFailed] = useState(initial.failed);
  const [pageIndex, setPageIndex] = useState(0);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const [color, setColor] = useState(colors[0]!.inkColor), [penWidth, setPenWidth] = useState(8);
  const [active, setActive] = useState<Stroke | null>(null);
  const activeRef = useRef<Stroke | null>(null), gestureStart = useRef<BoardDocument | null>(null);
  const gestureCancelled = useRef(false), drawing = useRef(false);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const scale = Math.min(area.width / BOARD_WIDTH, area.height / BOARD_HEIGHT);
  const [saved, setSaved] = useState(JSON.stringify(initial.document));
  const [saveNotice, setSaveNotice] = useState(false);
  const [error, setError] = useState<'board.saveError' | 'board.limit' | null>(null);
  const history = useRef<BoardDocument[]>([]), future = useRef<BoardDocument[]>([]);
  const dirty = JSON.stringify(document) !== saved;
  const page = document.pages[Math.min(pageIndex, document.pages.length - 1)]!;
  const pageId = page.id;
  const update = useCallback((next: BoardDocument) => { current.current = next; setDocument(next); }, []);
  const commit = useCallback((next: BoardDocument, previous = current.current) => {
    if (next === previous) return;
    history.current = [...history.current.slice(-29), previous]; future.current = [];
    update(next); setSaveNotice(false); setError(null);
  }, [update]);
  usePreventRemove(dirty, ({ data }) => {
    Alert.alert(t('ai.discardTitle'), t('board.leave'), [
      { text: t('ai.keepEditing'), style: 'cancel' },
      { text: t('ai.discard'), style: 'destructive', onPress: () => navigation.dispatch(data.action) },
    ]);
  });
  const cancelGesture = useCallback(() => {
    if (gestureStart.current) update(gestureStart.current);
    drawing.current = false; activeRef.current = null; gestureStart.current = null;
    setActive(null);
  }, [update]);
  // Resizing cancels only the in-flight gesture; completed strokes remain in document coordinates.
  useEffect(() => { cancelGesture(); }, [scale, cancelGesture]);
  const pointAt = (event: GestureResponderEvent): Point => ({
    x: Math.max(0, Math.min(BOARD_WIDTH, event.nativeEvent.locationX / scale)),
    y: Math.max(0, Math.min(BOARD_HEIGHT, event.nativeEvent.locationY / scale)),
  });
  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: event => !readFailed && scale > 0 && event.nativeEvent.touches.length === 1,
    onMoveShouldSetPanResponder: () => false,
    onPanResponderGrant: event => {
      drawing.current = true; gestureCancelled.current = false; gestureStart.current = current.current;
      setError(null); setSaveNotice(false);
      const point = pointAt(event);
      if (tool === 'eraser') { update(eraseAt(current.current, pageId, point, 24)); return; }
      const stroke: Stroke = { id: `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`, color, width: penWidth, points: [point] };
      activeRef.current = stroke; setActive(stroke);
    },
    onPanResponderMove: event => {
      if (event.nativeEvent.touches.length !== 1) { gestureCancelled.current = true; cancelGesture(); return; }
      if (gestureCancelled.current || !drawing.current) return;
      const point = pointAt(event);
      if (tool === 'eraser') { update(eraseAt(current.current, pageId, point, 24)); return; }
      const stroke = activeRef.current;
      if (!stroke) return;
      const previous = stroke.points[stroke.points.length - 1]!;
      if (Math.hypot(previous.x - point.x, previous.y - point.y) < 4) return;
      if (stroke.points.length >= 599) { gestureCancelled.current = true; cancelGesture(); setError('board.limit'); return; }
      const next = { ...stroke, points: [...stroke.points, point] };
      activeRef.current = next; setActive(next);
    },
    onPanResponderRelease: event => {
      if (!drawing.current || gestureCancelled.current) return;
      const before = gestureStart.current;
      try {
        if (tool === 'eraser') {
          const next = eraseAt(current.current, pageId, pointAt(event), 24);
          if (before) commit(next, before);
        } else if (activeRef.current) {
          const stroke = activeRef.current;
          const next = { ...stroke, points: [...stroke.points, pointAt(event)] };
          commit(appendStroke(current.current, pageId, next));
        }
      } catch { if (before) update(before); setError('board.limit'); }
      drawing.current = false; activeRef.current = null; gestureStart.current = null; setActive(null);
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderTerminate: cancelGesture,
  }), [tool, color, penWidth, pageId, scale, readFailed, update, commit, cancelGesture]);

  const save = () => {
    if (drawing.current || readFailed) return;
    try { saveBoard(Storage, current.current); setSaved(JSON.stringify(current.current)); setSaveNotice(true); setError(null); }
    catch { setError('board.saveError'); setSaveNotice(false); }
  };
  const retryRead = () => {
    try { const loaded = loadBoard(Storage); update(loaded); setSaved(JSON.stringify(loaded)); setReadFailed(false); }
    catch { setReadFailed(true); }
  };
  const undo = () => {
    if (drawing.current) return;
    const previous = history.current.pop(); if (!previous) return;
    future.current.push(current.current); update(previous); setPageIndex(index => Math.min(index, previous.pages.length - 1)); setSaveNotice(false); setError(null);
  };
  const redo = () => {
    if (drawing.current) return;
    const next = future.current.pop(); if (!next) return;
    history.current.push(current.current); update(next); setPageIndex(index => Math.min(index, next.pages.length - 1)); setSaveNotice(false); setError(null);
  };
  const newPage = (background: 'blank' | 'exercise') => {
    if (drawing.current) return;
    try { const next = addPage(current.current, background); commit(next); setPageIndex(next.pages.length - 1); }
    catch { setError('board.limit'); }
  };
  const button = (key: MessageKey, action: () => void, options: { selected?: boolean; disabled?: boolean; id?: string } = {}) =>
    <Pressable key={key} testID={options.id} accessibilityRole="button" accessibilityLabel={t(key)}
      accessibilityState={{ selected: options.selected, disabled: options.disabled }} disabled={options.disabled}
      onPress={action} style={({ pressed }) => [styles.button, { opacity: options.disabled ? 0.4 : 1,
        backgroundColor: options.selected ? theme.color.accent : pressed ? theme.color.subtle : theme.color.surface,
        borderColor: options.selected ? theme.color.accent : theme.color.controlBorder }]}>
      <Text style={{ fontSize: 14, color: options.selected ? theme.color.onAccent : theme.color.ink }}>{t(key)}</Text>
    </Pressable>;

  return <SafeAreaView style={{ flex: 1, backgroundColor: theme.color.background }}>
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel={t('common.back')} testID="whiteboard-back" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} style={styles.back}><AppIcon name="back" /></Pressable>
      <Text style={{ flex: 1, fontSize: 21, fontWeight: '600', color: theme.color.ink }}>{t('board.title')}</Text>
      {button('board.save', save, { id: 'whiteboard-save', disabled: readFailed, selected: dirty })}
    </View>
    <Text style={[styles.notice, { color: theme.color.muted }]}>{t('board.local')}</Text>
    {readFailed ? <View style={{ padding: 24, gap: 16 }}>
      <Text accessibilityRole="alert" style={{ color: theme.color.error, fontSize: 17 }}>{t('board.loadError')}</Text>
      {button('board.retry', retryRead)}
    </View> : <>
      <View style={{ maxHeight: '33%' }}>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 16, gap: 8, paddingBottom: 8 }}>
          <View accessibilityLabel={t('board.tools')} style={styles.row}>
            {button('board.pen', () => setTool('pen'), { selected: tool === 'pen', id: 'whiteboard-pen' })}
            {button('board.eraser', () => setTool('eraser'), { selected: tool === 'eraser', id: 'whiteboard-eraser' })}
            {button('board.undo', undo, { disabled: !history.current.length, id: 'whiteboard-undo' })}
            {button('board.redo', redo, { disabled: !future.current.length, id: 'whiteboard-redo' })}
          </View>
          <View style={styles.row}>
            {colors.map(item => <Pressable key={item.inkColor} accessibilityRole="button" accessibilityLabel={t(item.label)} accessibilityState={{ selected: color === item.inkColor && tool === 'pen' }}
              onPress={() => { setColor(item.inkColor); setTool('pen'); }} style={[styles.color, { borderColor: color === item.inkColor ? theme.color.selectedBorder : theme.color.border, backgroundColor: theme.color.surface }]}>
              <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: item.inkColor, alignItems: 'center', justifyContent: 'center' }}>{color === item.inkColor && <AppIcon name="check" size={16} color="#FFFFFF" />}</View>
            </Pressable>)}
            {widths.map(item => button(item.label, () => { setPenWidth(item.size); setTool('pen'); }, { selected: penWidth === item.size }))}
          </View>
        </ScrollView>
      </View>
      <View style={{ paddingHorizontal: 16, minHeight: 26 }}>
        <Text testID="whiteboard-status" style={{ fontSize: 13, color: theme.color.muted }}>{t('board.count', { page: pageIndex + 1, total: document.pages.length, count: page.strokes.length })}</Text>
        <Text testID="whiteboard-save-status" accessibilityLiveRegion="polite" style={{ fontSize: 13, color: error ? theme.color.error : theme.color.muted }}>
          {error ? t(error) : dirty ? t('board.dirty') : saveNotice ? t('board.saved') : page.background === 'exercise' ? t('board.sampleHint') : ' '}
        </Text>
      </View>
      <View style={{ flex: 1, minHeight: 80, margin: 12, alignItems: 'center', justifyContent: 'center' }} onLayout={event => setArea({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}>
        {scale > 0 && <View testID="whiteboard-canvas" accessible accessibilityLabel={t('board.canvas')}
          {...responder.panHandlers} style={{ width: BOARD_WIDTH * scale, height: BOARD_HEIGHT * scale, backgroundColor: '#FFFEFA', overflow: 'hidden', borderWidth: 1, borderColor: theme.color.controlBorder }}>
          <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
            {page.background === 'exercise' && <Image source={require('../../assets/whiteboard/exercise.png')} resizeMode="stretch" style={{ position: 'absolute', width: '100%', height: '100%' }} />}
            {page.strokes.map(stroke => <Ink key={stroke.id} stroke={stroke} scale={scale} />)}
            {active && <Ink stroke={active} scale={scale} />}
          </View>
        </View>}
      </View>
      <View style={{ paddingHorizontal: 16, paddingBottom: 8, gap: 6 }}>
        <ScrollView horizontal accessibilityLabel={t('board.pages')} contentContainerStyle={{ gap: 8 }} style={{ maxHeight: 56 }}>
          {document.pages.map((item, index) => <Pressable key={item.id} testID={`whiteboard-page-${index + 1}`} accessibilityRole="button" accessibilityLabel={t('board.page', { number: index + 1 })} accessibilityState={{ selected: index === pageIndex }} onPress={() => { if (!drawing.current) setPageIndex(index); }}
            style={[styles.button, { backgroundColor: index === pageIndex ? theme.color.accent : theme.color.surface, borderColor: theme.color.controlBorder }]}><Text style={{ color: index === pageIndex ? theme.color.onAccent : theme.color.ink }}>{index + 1}</Text></Pressable>)}
        </ScrollView>
        <View style={styles.row}>
          {button('board.blank', () => newPage('blank'), { disabled: document.pages.length >= 10, id: 'whiteboard-add-blank' })}
          {button('board.exercise', () => newPage('exercise'), { disabled: document.pages.length >= 10, id: 'whiteboard-add-exercise' })}
        </View>
      </View>
    </>}
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  header: { paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  back: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  notice: { fontSize: 13, paddingHorizontal: 16, paddingVertical: 8 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  button: { minHeight: 48, minWidth: 48, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center' },
  color: { width: 48, height: 48, borderRadius: 24, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});
