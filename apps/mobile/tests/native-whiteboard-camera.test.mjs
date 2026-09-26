// Synthetic contract tests for the native whiteboard camera / photo-library adapter in
// apps/mobile/src/whiteboard/native-service.ts.
//
// Every expo module the adapter imports is replaced by a synthetic registerHooks module that
// reads live harness state, so these tests cover the adapter's failure branches without a
// device, a real picker, a real filesystem, or a network. This is synthetic contract coverage
// only: it is NOT real camera or photo-library acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';

// Mirrors of packages/whiteboard/src/protocol.ts (KEY, INDEX_KEY, MAX_IMAGE) and the adapter limits.
const KEY = 'siyue.whiteboard.excalidraw.v2';
const INDEX_KEY = 'siyue.whiteboard.boards.v1';
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_ORIGINAL = 32 * 1024 * 1024;
const MAX_RASTER_PIXELS = 80_000_000;

const DOCUMENT_ROOT = '/private';
const ORIGINALS_ROOT = DOCUMENT_ROOT + '/whiteboard-originals';
const CAMERA_URI = '/synthetic/camera.jpg';
const JPEG_DATA_URL = 'data:image/jpeg;base64,';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The exact ImagePicker.ImagePickerOptions the adapter must pass.
const PICKER_OPTIONS = { mediaTypes: ['images'], allowsEditing: false, quality: 1, exif: false };

function createHarness() {
  return {
    // board storage (expo-sqlite/kv-store)
    store: new Map(),
    getItemCalls: [],
    setItemCalls: [],
    // picker (expo-image-picker)
    cameraPermissionRequests: 0,
    cameraPermission: { granted: true },
    cameraLaunches: [],
    libraryLaunches: [],
    cameraResult: { canceled: true },
    libraryResult: { canceled: true },
    // manipulator (expo-image-manipulator)
    manipulateCalls: [],
    resizeCalls: [],
    saveCalls: [],
    manipulatorOutput: { base64: '/9j/', width: 100, height: 100 },
    removeItemCalls: [],
    // Runs inside renderAsync, before saveAsync; tests use it to abort a lifetime signal mid-raster.
    beforeRender: null,
    // A test-controlled promise renderAsync awaits; lets a test act while the raster is still pending.
    renderGate: null,
    // Runs when the picker is launched, before its result resolves.
    beforeLaunch: null,
    // file system (expo-file-system): map of path -> size in bytes
    documentRoot: DOCUMENT_ROOT,
    files: new Map([[CAMERA_URI, 100]]),
  };
}
const harness = () => globalThis.__siyueHarness;

function listOriginals() {
  return [...harness().files.keys()].filter(path => path.startsWith(ORIGINALS_ROOT + '/')).sort();
}
function listFiles() { return [...harness().files.keys()].sort(); }
function boardWrites() { return harness().setItemCalls; }
// A list may create the empty index; a pick or a refused operation may never write a board body.
function bodyWrites() { return boardWrites().filter(write => write.key !== INDEX_KEY); }
function requestFor(service, session) {
  return (op, payload) => service.request(JSON.stringify({
    version: 1, session, requestId: randomUUID(), op, ...(payload ? { payload } : {}),
  }));
}
async function ask(request, op, payload) { return JSON.parse(await request(op, payload)); }
function startService(session, options) {
  const service = nativeBoardService(session, options);
  return { service, request: requestFor(service, session) };
}
// A picker result holding one image asset; 'fields' overrides the default asset properties.
function assetResult(fields) {
  return {
    canceled: false,
    assets: [{
      uri: CAMERA_URI, type: 'image', mimeType: 'image/jpeg', fileSize: 100, width: 100, height: 100,
      ...(fields || {}),
    }],
  };
}
// A promise the test resolves explicitly; renderAsync suspends on it while a pick is rasterizing.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
// Records every abort listener the adapter adds to and removes from this exact signal instance.
// Node's internal {once: true} auto-removal is not observable here, so a listener left in this Set
// proves the adapter never called removeEventListener itself. The adapter is expected to register
// nothing at all, so 'registrations'/'removals' log each add/remove call regardless of the listener.
function trackListeners(signal) {
  const listeners = new Set();
  const registrations = [];
  const removals = [];
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type, listener, options) => {
    if (type === 'abort') { listeners.add(listener); registrations.push(listener); }
    return add(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === 'abort') { listeners.delete(listener); removals.push(listener); }
    return remove(type, listener, options);
  };
  return { listeners, registrations, removals };
}

const lines = (...parts) => parts.join('\n');
const modules = {
  'expo-sqlite/kv-store': lines(
    'export default {',
    '  getItemSync(key) { const s = globalThis.__siyueHarness; s.getItemCalls.push(key); return s.store.has(key) ? s.store.get(key) : null; },',
    '  setItemSync(key, value) { const s = globalThis.__siyueHarness; s.setItemCalls.push({ key, value }); s.store.set(key, value); },',
    '  removeItemSync(key) { const s = globalThis.__siyueHarness; s.removeItemCalls.push(key); return s.store.delete(key); },',
    '};',
  ),
  'expo-image-picker': lines(
    'export async function requestCameraPermissionsAsync() { const s = globalThis.__siyueHarness; s.cameraPermissionRequests += 1; return s.cameraPermission; }',
    'export async function launchCameraAsync(options) { const s = globalThis.__siyueHarness; s.cameraLaunches.push(options); if (s.beforeLaunch) s.beforeLaunch(); return s.cameraResult; }',
    'export async function launchImageLibraryAsync(options) { const s = globalThis.__siyueHarness; s.libraryLaunches.push(options); return s.libraryResult; }',
  ),
  'expo-image-manipulator': lines(
    'export const SaveFormat = { JPEG: "jpeg" };',
    'export const ImageManipulator = {',
    '  manipulate(uri) {',
    '    const s = globalThis.__siyueHarness; s.manipulateCalls.push(uri);',
    '    const context = {',
    '      resize(arg) { s.resizeCalls.push(arg); return context; },',
    '      async renderAsync() {',
    '        if (s.beforeRender) s.beforeRender();',
    '        if (s.renderGate) await s.renderGate;',
    '        return { saveAsync: async (options) => { s.saveCalls.push(options); return s.manipulatorOutput; } };',
    '      },',
    '    };',
    '    return context;',
    '  },',
    '};',
  ),
  'expo-file-system': lines(
    'const resolve = (parts) => parts.map(part => part && typeof part === "object" && typeof part.path === "string" ? part.path : String(part)).filter(Boolean).join("/");',
    'export const Paths = { get document() { return globalThis.__siyueHarness.documentRoot; } };',
    'export class Directory { constructor(...parts) { this.path = resolve(parts); } create() {} }',
    'export class File {',
    '  constructor(...parts) { this.path = resolve(parts); }',
    '  get exists() { return globalThis.__siyueHarness.files.has(this.path); }',
    '  get size() { return globalThis.__siyueHarness.files.get(this.path) ?? 0; }',
    '  copy(target) { const s = globalThis.__siyueHarness; s.files.set(target.path, this.size); }',
    '  delete() { globalThis.__siyueHarness.files.delete(this.path); }',
    '}',
  ),
  'expo-crypto': 'export { randomUUID } from "node:crypto";',
};
const hook = registerHooks({ resolve(specifier, context, next) {
  const source = modules[specifier];
  if (!source) return next(specifier, context);
  return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
} });
const { nativeBoardService } = await import('../src/whiteboard/native-service.ts');
hook.deregister();

test.beforeEach(() => { globalThis.__siyueHarness = createHarness(); });
test.after(() => { delete globalThis.__siyueHarness; });

test('rejected camera image removes the newly copied private original', async () => {
  harness().cameraResult = assetResult({ width: 9000, height: 9000 });
  const { service, request } = startService('camera-rejected');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'image_too_large');
  assert.deepEqual(listFiles(), [CAMERA_URI]);
  assert.deepEqual(listOriginals(), []);
  service.dispose();
});

test('accepted camera image keeps its private original', async () => {
  harness().cameraResult = assetResult({});
  const { service, request } = startService('camera-accepted');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, true);
  assert.equal(result.value.width, 100);
  assert.equal(listOriginals().length, 1);
  assert.equal(listFiles().length, 2);
  service.dispose();
});

test('camera permission denied fails with permission_denied and copies nothing', async () => {
  harness().cameraPermission = { granted: false };
  const { service, request } = startService('camera-denied');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'permission_denied');
  assert.equal(harness().cameraPermissionRequests, 1);
  assert.deepEqual(harness().cameraLaunches, []);
  assert.deepEqual(listOriginals(), []);
  assert.deepEqual(listFiles(), [CAMERA_URI]);
  assert.deepEqual(bodyWrites(), []);
  service.dispose();
});

test('camera canceled returns cancelled and copies nothing', async () => {
  harness().cameraResult = { canceled: true };
  const { service, request } = startService('camera-cancel');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { cancelled: true });
  assert.equal(harness().cameraLaunches.length, 1);
  assert.deepEqual(listOriginals(), []);
  assert.deepEqual(listFiles(), [CAMERA_URI]);
  assert.deepEqual(bodyWrites(), []);
  service.dispose();
});

test('library canceled returns cancelled without requesting camera permission', async () => {
  harness().libraryResult = { canceled: true };
  const { service, request } = startService('library-cancel');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'library' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { cancelled: true });
  assert.equal(harness().cameraPermissionRequests, 0);
  assert.deepEqual(harness().cameraLaunches, []);
  assert.equal(harness().libraryLaunches.length, 1);
  assert.deepEqual(listOriginals(), []);
  assert.deepEqual(bodyWrites(), []);
  service.dispose();
});

test('oversized camera capture reported by the picker fails with image_too_large', async () => {
  harness().cameraResult = assetResult({ fileSize: MAX_ORIGINAL + 1 });
  const { service, request } = startService('camera-oversized-asset');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'image_too_large');
  assert.deepEqual(listOriginals(), []);
  assert.deepEqual(listFiles(), [CAMERA_URI]);
  assert.deepEqual(harness().manipulateCalls, []);
  service.dispose();
});

test('oversized library asset reported by the picker fails with image_too_large', async () => {
  harness().libraryResult = assetResult({ fileSize: MAX_ORIGINAL + 1 });
  const { service, request } = startService('library-oversized-asset');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'library' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'image_too_large');
  assert.equal(harness().cameraPermissionRequests, 0);
  assert.equal(harness().libraryLaunches.length, 1);
  assert.deepEqual(listOriginals(), []);
  assert.deepEqual(harness().manipulateCalls, []);
  service.dispose();
});

test('oversized original on disk fails with image_too_large and retains no copy', async () => {
  harness().files.set(CAMERA_URI, MAX_ORIGINAL + 1);
  harness().cameraResult = assetResult({});
  const { service, request } = startService('camera-oversized-original');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'image_too_large');
  assert.deepEqual(listOriginals(), []);
  assert.deepEqual(harness().manipulateCalls, []);
  assert.deepEqual(listFiles(), [CAMERA_URI]);
  service.dispose();
});

test('original on disk at exactly the 32 MiB limit is accepted', async () => {
  harness().files.set(CAMERA_URI, MAX_ORIGINAL);
  harness().cameraResult = assetResult({});
  const { service, request } = startService('camera-original-limit');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, true);
  assert.equal(listOriginals().length, 1);
  service.dispose();
});

test('oversized manipulator output fails and deletes the copied camera original', async () => {
  harness().cameraResult = assetResult({});
  harness().manipulatorOutput = {
    base64: 'A'.repeat(Math.ceil(MAX_IMAGE * 4 / 3) + 1), width: 100, height: 100,
  };
  const { service, request } = startService('camera-oversized-output');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'image_too_large');
  assert.equal(harness().saveCalls.length, 1);
  assert.deepEqual(listOriginals(), []);
  assert.deepEqual(listFiles(), [CAMERA_URI]);
  service.dispose();
});

test('stale session before the pick fails with stale_session and copies nothing', async () => {
  const controller = new AbortController();
  controller.abort();
  const { service, request } = startService('camera-stale-early', { lifetimeSignal: controller.signal });
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'stale_session');
  assert.equal(harness().cameraPermissionRequests, 0);
  assert.deepEqual(harness().cameraLaunches, []);
  assert.deepEqual(listOriginals(), []);
  assert.deepEqual(bodyWrites(), []);
  service.dispose();
});

test('stale session while rasterizing deletes the copied camera original', async () => {
  const controller = new AbortController();
  harness().cameraResult = assetResult({});
  harness().beforeRender = () => controller.abort();
  const { service, request } = startService('camera-stale-raster', { lifetimeSignal: controller.signal });
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'stale_session');
  assert.equal(harness().saveCalls.length, 1);
  assert.deepEqual(listOriginals(), []);
  assert.deepEqual(listFiles(), [CAMERA_URI]);
  service.dispose();
});

test('camera picker options and landscape resize argument are exact', async () => {
  harness().cameraResult = assetResult({ width: 4000, height: 3000 });
  harness().manipulatorOutput = { base64: '/9j/landscape', width: 3200, height: 2400 };
  const { service, request } = startService('camera-landscape');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, true);
  assert.deepEqual(harness().cameraLaunches, [PICKER_OPTIONS]);
  assert.deepEqual(harness().resizeCalls, [{ width: 3200 }]);
  assert.deepEqual(harness().manipulateCalls, [CAMERA_URI]);
  // width/height/dataURL come from the manipulator output, not from the 4000x3000 picker asset.
  assert.equal(result.value.width, 3200);
  assert.equal(result.value.height, 2400);
  assert.equal(result.value.file.mimeType, 'image/jpeg');
  assert.equal(result.value.file.dataURL, JPEG_DATA_URL + '/9j/landscape');
  assert.ok(result.value.file.dataURL.startsWith(JPEG_DATA_URL));
  assert.match(result.value.file.id, UUID);
  assert.equal(typeof result.value.file.created, 'number');
  assert.equal(Number.isFinite(result.value.file.created), true);
  service.dispose();
});

test('camera picker keeps the long axis when the capture is portrait', async () => {
  harness().cameraResult = assetResult({ width: 3000, height: 4000 });
  harness().manipulatorOutput = { base64: '/9j/portrait', width: 2400, height: 3200 };
  const { service, request } = startService('camera-portrait');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, true);
  assert.deepEqual(harness().resizeCalls, [{ height: 3200 }]);
  assert.equal(result.value.width, 2400);
  assert.equal(result.value.height, 3200);
  service.dispose();
});

test('camera capture at exactly 3200 px on the long axis is not resized', async () => {
  harness().cameraResult = assetResult({ width: 3200, height: 2000 });
  harness().manipulatorOutput = { base64: '/9j/boundary', width: 3200, height: 2000 };
  const { service, request } = startService('camera-boundary');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, true);
  assert.deepEqual(harness().resizeCalls, []);
  assert.equal(result.value.width, 3200);
  assert.equal(result.value.height, 2000);
  service.dispose();
});

test('library pick uses the same picker options and returns manipulator output', async () => {
  harness().libraryResult = assetResult({ width: 3200, height: 3200 });
  harness().manipulatorOutput = { base64: '/9j/library', width: 1600, height: 1600 };
  const { service, request } = startService('library-options');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'library' });
  assert.equal(result.ok, true);
  assert.deepEqual(harness().libraryLaunches, [PICKER_OPTIONS]);
  assert.equal(harness().cameraPermissionRequests, 0);
  assert.deepEqual(harness().cameraLaunches, []);
  assert.deepEqual(harness().resizeCalls, []);
  assert.equal(result.value.width, 1600);
  assert.equal(result.value.height, 1600);
  assert.equal(result.value.file.mimeType, 'image/jpeg');
  assert.equal(result.value.file.dataURL, JPEG_DATA_URL + '/9j/library');
  assert.match(result.value.file.id, UUID);
  // Only camera captures are copied into the private originals folder.
  assert.deepEqual(listOriginals(), []);
  service.dispose();
});

test('absurd picker geometry fails with image_too_large and retains no copy', async () => {
  const overPixelBudget = Math.ceil(Math.sqrt(MAX_RASTER_PIXELS)) + 1;
  const cases = [
    { width: Number.NaN, height: 100 },
    { width: 0, height: 100 },
    { width: -10, height: 100 },
    { width: 100, height: Number.POSITIVE_INFINITY },
    { width: overPixelBudget, height: overPixelBudget },
  ];
  for (const geometry of cases) {
    const label = JSON.stringify(geometry) + ' (over pixel budget: ' + (overPixelBudget * overPixelBudget > MAX_RASTER_PIXELS) + ')';

    globalThis.__siyueHarness = createHarness();
    harness().cameraResult = assetResult(geometry);
    const camera = startService('camera-geometry');
    assert.equal((await ask(camera.request, 'list', { defaultTitle: '我的白板' })).ok, true);
    const cameraResult = await ask(camera.request, 'pick', { source: 'camera' });
    assert.equal(cameraResult.ok, false, label);
    assert.equal(cameraResult.error, 'image_too_large');
    assert.equal(harness().cameraLaunches.length, 1, label);
    assert.deepEqual(listOriginals(), [], 'camera geometry ' + label);
    assert.deepEqual(listFiles(), [CAMERA_URI], 'camera geometry ' + label);
    assert.deepEqual(bodyWrites(), []);
    camera.service.dispose();

    globalThis.__siyueHarness = createHarness();
    harness().libraryResult = assetResult(geometry);
    const library = startService('library-geometry');
    assert.equal((await ask(library.request, 'list', { defaultTitle: '我的白板' })).ok, true);
    const libraryResult = await ask(library.request, 'pick', { source: 'library' });
    assert.equal(libraryResult.ok, false, label);
    assert.equal(libraryResult.error, 'image_too_large');
    assert.equal(harness().libraryLaunches.length, 1, label);
    assert.deepEqual(listOriginals(), [], 'library geometry ' + label);
    library.service.dispose();
  }
});

test('integration: camera pick then save writes one index row and one board body', async () => {
  harness().cameraResult = assetResult({ width: 4000, height: 3000 });
  harness().manipulatorOutput = { base64: '/9j/integration', width: 3200, height: 2400 };
  const { service, request } = startService('camera-integration');

  const listed = await ask(request, 'list', { defaultTitle: '我的白板' });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.value, { boards: [] });
  const created = await ask(request, 'create', { title: '照片白板', start: 'photo' });
  assert.equal(created.ok, true);
  const boardId = created.value.summary.id;
  const bodyKey = 'siyue.whiteboard.board.' + boardId + '.v2';
  const opened = await ask(request, 'load', { boardId });
  assert.equal(opened.ok, true);
  assert.equal(opened.value.board.revision, 0);
  assert.equal(opened.value.summary.title, '照片白板');
  // The first list creates the index row; create writes the body first, then the index that points
  // at it, so an entry can never reference a body that was not written.
  const opening = boardWrites().map(write => write.key);
  assert.deepEqual(opening, [INDEX_KEY, bodyKey, INDEX_KEY]);

  const picked = await ask(request, 'pick', { source: 'camera' });
  assert.equal(picked.ok, true);
  const file = picked.value.file;
  // A pick must never write board storage.
  assert.deepEqual(boardWrites().map(write => write.key), opening);
  assert.equal(listOriginals().length, 1);

  const pages = [{
    id: 'page-1',
    elements: [{
      id: 'img-1', type: 'image', fileId: file.id, x: 0, y: 0, width: 100, height: 100,
      angle: 0, version: 1, link: null,
    }],
    appState: { viewBackgroundColor: '#fffefa', scrollX: 0, scrollY: 0, zoom: { value: 1 } },
  }];
  const saved = await ask(request, 'save', { boardId, baseRevision: 0, files: { [file.id]: file }, pages });
  assert.equal(saved.ok, true);
  assert.equal(saved.value.revision, 1);
  assert.deepEqual(saved.value.fileIds, [file.id]);
  assert.equal(saved.value.summary.pageCount, 1);

  // The index row is written before the body, and the retired single-board key is never touched.
  assert.deepEqual(boardWrites().map(write => write.key), [...opening, INDEX_KEY, bodyKey]);
  const stored = JSON.parse(harness().store.get(bodyKey));
  assert.equal(stored.revision, 1);
  assert.deepEqual(Object.keys(stored.files), [file.id]);
  assert.equal(harness().store.has(KEY), false);
  service.dispose();
});
+
// Disposal is the service's own lifetime. A pick must observe it directly, not only through the
// post-pick staleness check, otherwise the copied private original is orphaned.
test('dispose during raster deletes the copied camera original', async () => {
  harness().cameraResult = assetResult({});
  const gate = deferred();
  const rendered = deferred();
  harness().renderGate = gate.promise;
  harness().beforeRender = () => rendered.resolve();
  const { service, request } = startService('dispose-during-raster');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const pending = ask(request, 'pick', { source: 'camera' });
  await rendered.promise;
  // The private copy exists while the capture is still rasterizing.
  assert.equal(listOriginals().length, 1);
  service.dispose();
  gate.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'stale_session');
  assert.deepEqual(listOriginals(), []);
  assert.deepEqual(listFiles(), [CAMERA_URI]);
  assert.deepEqual(bodyWrites(), []);
});
+
test('dispose while the picker is open fails with stale_session and copies nothing', async () => {
  const gate = deferred();
  const launched = deferred();
  // The picker stays open until the test resolves its result.
  harness().cameraResult = gate.promise;
  harness().beforeLaunch = () => launched.resolve();
  const { service, request } = startService('dispose-while-picker-open');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const pending = ask(request, 'pick', { source: 'camera' });
  await launched.promise;
  assert.equal(harness().cameraLaunches.length, 1);
  service.dispose();
  gate.resolve(assetResult({}));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'stale_session');
  // The capture was never copied or rasterized, so there is nothing to retain on "disk".
  assert.deepEqual(harness().manipulateCalls, []);
  assert.deepEqual(listOriginals(), []);
  assert.deepEqual(listFiles(), [CAMERA_URI]);
  assert.deepEqual(bodyWrites(), []);
});

test('external lifetimeSignal abort deletes the copy and never registers a listener', async () => {
  const controller = new AbortController();
  const { listeners, registrations, removals } = trackListeners(controller.signal);
  harness().cameraResult = assetResult({});
  const gate = deferred();
  const rendered = deferred();
  harness().renderGate = gate.promise;
  harness().beforeRender = () => rendered.resolve();
  const { service, request } = startService('camera-signal-abort', { lifetimeSignal: controller.signal });
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const pending = ask(request, 'pick', { source: 'camera' });
  await rendered.promise;
  assert.equal(listOriginals().length, 1);
  // The adapter polls the external signal at its await boundaries; it never subscribes to it.
  assert.equal(registrations.length, 0);
  assert.equal(listeners.size, 0);
  controller.abort();
  gate.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'stale_session');
  assert.deepEqual(listOriginals(), []);
  // No registration ever happened, so a long-lived external signal carries nothing to leak.
  assert.equal(registrations.length, 0);
  assert.equal(listeners.size, 0);
  assert.deepEqual(removals, []);
  service.dispose();
  assert.equal(registrations.length, 0);
  assert.equal(listeners.size, 0);
});

test('successful camera pick keeps its original and never registers a listener', async () => {
  const controller = new AbortController();
  const { listeners, registrations, removals } = trackListeners(controller.signal);
  harness().cameraResult = assetResult({});
  const { service, request } = startService('camera-signal-retained', { lifetimeSignal: controller.signal });
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, true);
  // A successful capture deliberately keeps exactly one private original.
  assert.equal(listOriginals().length, 1);
  assert.equal(registrations.length, 0);
  assert.equal(listeners.size, 0);
  assert.deepEqual(removals, []);
  service.dispose();
  assert.equal(registrations.length, 0);
  assert.equal(listeners.size, 0);
});

test('repeated dispose is safe and leaves no copied original behind', async () => {
  const controller = new AbortController();
  const { listeners } = trackListeners(controller.signal);
  harness().cameraResult = assetResult({});
  const gate = deferred();
  const rendered = deferred();
  harness().renderGate = gate.promise;
  harness().beforeRender = () => rendered.resolve();
  const { service, request } = startService('camera-dispose-twice', { lifetimeSignal: controller.signal });
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const pending = ask(request, 'pick', { source: 'camera' });
  await rendered.promise;
  assert.equal(listOriginals().length, 1);
  service.dispose();
  assert.doesNotThrow(() => service.dispose());
  gate.resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'stale_session');
  assert.deepEqual(listOriginals(), []);
  assert.deepEqual(bodyWrites(), []);
  assert.equal(listeners.size, 0);
  assert.doesNotThrow(() => service.dispose());
  assert.equal(listeners.size, 0);
});

test('dispose before the pick starts fails with stale_session and launches no camera', async () => {
  harness().cameraResult = assetResult({});
  const { service, request } = startService('camera-disposed-early');
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  service.dispose();
  const result = await ask(request, 'pick', { source: 'camera' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'stale_session');
  assert.equal(harness().cameraPermissionRequests, 0);
  assert.deepEqual(harness().cameraLaunches, []);
  assert.deepEqual(listOriginals(), []);
  assert.deepEqual(listFiles(), [CAMERA_URI]);
  assert.deepEqual(bodyWrites(), []);
});

const NAMESPACE = '3f1d0f4e-1c2a-4a1c-9f1a-2b3c4d5e6f70';
const SPACE_PREFIX = 'siyue.account.' + NAMESPACE + '.';
const LEGACY_BODY = JSON.stringify({
  schemaVersion: 2, editor: 'excalidraw-0.18.1', id: 'local-whiteboard', revision: 4, activePageId: 'page-1',
  pages: [{ id: 'page-1', elements: [], appState: { viewBackgroundColor: '#fffefa', scrollX: 0, scrollY: 0, zoom: { value: 1 } } }], files: {},
});

test('a legacy board is adopted inside its own account space and the legacy key is left as it was', async () => {
  harness().store.set(SPACE_PREFIX + KEY, LEGACY_BODY);
  const { service, request } = startService('space-migration', { namespace: NAMESPACE });
  const listed = await ask(request, 'list', { defaultTitle: '我的白板' });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.value.boards.map(board => [board.id, board.title, board.pageCount]), [['local-whiteboard', '我的白板', 1]]);
  assert.equal(harness().store.get(SPACE_PREFIX + KEY), LEGACY_BODY);
  assert.equal(harness().store.get(SPACE_PREFIX + 'siyue.whiteboard.board.local-whiteboard.v2'), LEGACY_BODY);
  assert.equal(JSON.parse(harness().store.get(SPACE_PREFIX + INDEX_KEY)).boards.length, 1);
  const opened = await ask(request, 'load', { boardId: 'local-whiteboard' });
  assert.equal(opened.value.board.revision, 4);
  service.dispose();
});

test('create and delete stay inside the account space prefix on the same device', async () => {
  const { service, request } = startService('space-crud', { namespace: NAMESPACE });
  assert.equal((await ask(request, 'list', { defaultTitle: '我的白板' })).ok, true);
  const created = await ask(request, 'create', { title: '数学', start: 'blank' });
  const boardId = created.value.summary.id;
  const bodyKey = SPACE_PREFIX + 'siyue.whiteboard.board.' + boardId + '.v2';
  assert.match(boardId, UUID);
  assert.equal(harness().store.has(bodyKey), true);
  assert.equal(harness().store.has('siyue.whiteboard.board.' + boardId + '.v2'), false);
  assert.deepEqual(JSON.parse(harness().store.get(SPACE_PREFIX + INDEX_KEY)).boards.map(board => board.title), ['数学']);

  const renamed = await ask(request, 'rename', { boardId, title: '周三数学题' });
  assert.equal(renamed.value.summary.title, '周三数学题');
  assert.equal((await ask(request, 'delete', { boardId })).ok, true);
  assert.deepEqual(harness().removeItemCalls, [bodyKey]);
  assert.equal(harness().store.has(bodyKey), false);
  assert.deepEqual(JSON.parse(harness().store.get(SPACE_PREFIX + INDEX_KEY)).boards, []);
  service.dispose();
});
