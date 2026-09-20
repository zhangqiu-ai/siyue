// 思玥独立本机测试白板核心（试用）：单机画板的数据结构与纯函数操作。
// 边界：不含账号、共享与 RTC；此 schema 只服务本机测试画板，不作为正式协作协议。
// 只依赖 ECMAScript 标准能力，不导入 React Native、Node API 或第三方模块。

export type Point = { x: number; y: number };
export type Stroke = { id: string; color: string; width: number; points: Point[] };
export type BoardPage = { id: string; background: 'blank' | 'exercise'; strokes: Stroke[] };
export type BoardDocument = { schemaVersion: 1; pages: BoardPage[] };

export const BOARD_WIDTH = 1000;
export const BOARD_HEIGHT = 1400;

const SCHEMA_VERSION = 1;
const MAX_PAGES = 10;
const MAX_STROKES = 400;
const MAX_POINTS_PER_STROKE = 600;
const MAX_POINTS = 20000;
const MIN_WIDTH = 1;
const MAX_WIDTH = 30;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export class BoardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardError';
  }
}

function fail(message: string): never {
  throw new BoardError(message);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const assertOnlyKeys = (value: Record<string, unknown>, allowed: readonly string[], where: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${where}存在未知字段 ${key}`);
  }
};

const assertId = (value: unknown, where: string): string =>
  typeof value === 'string' && ID_PATTERN.test(value) ? value : fail(`${where}的 id 非法`);

const toPoint = (value: unknown, where: string): Point => {
  if (!isRecord(value)) fail(`${where}必须是坐标对象`);
  assertOnlyKeys(value, ['x', 'y'], where);
  const { x, y } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) fail(`${where}坐标必须是有限数值`);
  if (x < 0 || x > BOARD_WIDTH || y < 0 || y > BOARD_HEIGHT) {
    fail(`${where}坐标超出 ${BOARD_WIDTH}x${BOARD_HEIGHT} 画布`);
  }
  return { x, y };
};

const toStroke = (value: unknown, where: string): Stroke => {
  if (!isRecord(value)) fail(`${where}必须是对象`);
  assertOnlyKeys(value, ['id', 'color', 'width', 'points'], where);
  const id = assertId(value.id, where);
  const color = value.color;
  if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) fail(`${where}的 color 必须是 #RRGGBB`);
  const width = value.width;
  if (!isFiniteNumber(width) || width < MIN_WIDTH || width > MAX_WIDTH) {
    fail(`${where}的 width 必须在 ${MIN_WIDTH}..${MAX_WIDTH}`);
  }
  const points = value.points;
  if (!isArray(points)) fail(`${where}的 points 必须是数组`);
  if (points.length < 1 || points.length > MAX_POINTS_PER_STROKE) {
    fail(`${where}的点数必须在 1..${MAX_POINTS_PER_STROKE}`);
  }
  return {
    id,
    color,
    width,
    points: points.map((item, index) => toPoint(item, `${where}第 ${index + 1} 个点`)),
  };
};

// 单一入口：校验并复制为规范化文档；任何越界、未知字段、重复 ID 都直接拒绝，不截断。
const toDocument = (value: unknown): BoardDocument => {
  if (!isRecord(value)) fail('白板文档必须是对象');
  assertOnlyKeys(value, ['schemaVersion', 'pages'], '白板文档');
  if (value.schemaVersion !== SCHEMA_VERSION) fail(`不支持的白板 schemaVersion ${String(value.schemaVersion)}`);
  const rawPages = value.pages;
  if (!isArray(rawPages)) fail('pages 必须是数组');
  if (rawPages.length < 1 || rawPages.length > MAX_PAGES) fail(`页数必须在 1..${MAX_PAGES}`);
  const pageIds = new Set<string>();
  const strokeIds = new Set<string>();
  let strokeTotal = 0;
  let pointTotal = 0;
  const pages: BoardPage[] = [];
  for (const rawPage of rawPages) {
    const where = `第 ${pages.length + 1} 页`;
    if (!isRecord(rawPage)) fail(`${where}必须是对象`);
    assertOnlyKeys(rawPage, ['id', 'background', 'strokes'], where);
    const id = assertId(rawPage.id, where);
    if (pageIds.has(id)) fail(`重复的页 id ${id}`);
    pageIds.add(id);
    const background = rawPage.background;
    if (background !== 'blank' && background !== 'exercise') fail(`${where}的 background 必须是 blank 或 exercise`);
    const rawStrokes = rawPage.strokes;
    if (!isArray(rawStrokes)) fail(`${where}的 strokes 必须是数组`);
    const strokes: Stroke[] = [];
    for (const rawStroke of rawStrokes) {
      const stroke = toStroke(rawStroke, `${where}第 ${strokes.length + 1} 笔`);
      if (strokeIds.has(stroke.id)) fail(`重复的笔 id ${stroke.id}`);
      strokeIds.add(stroke.id);
      strokeTotal += 1;
      pointTotal += stroke.points.length;
      if (strokeTotal > MAX_STROKES) fail(`总笔数不能超过 ${MAX_STROKES}`);
      if (pointTotal > MAX_POINTS) fail(`总点数不能超过 ${MAX_POINTS}`);
      strokes.push(stroke);
    }
    pages.push({ id, background, strokes });
  }
  return { schemaVersion: SCHEMA_VERSION, pages };
};

// 本机试用：时间戳加随机后缀足够避免同一文档内的碰撞，且不引入外部依赖。
const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const distanceToSegment = (point: Point, start: Point, end: Point): number => {
  const spanX = end.x - start.x;
  const spanY = end.y - start.y;
  const lengthSquared = spanX * spanX + spanY * spanY;
  const offsetX = point.x - start.x;
  const offsetY = point.y - start.y;
  const raw = lengthSquared === 0 ? 0 : (offsetX * spanX + offsetY * spanY) / lengthSquared;
  const ratio = Math.min(1, Math.max(0, raw));
  return Math.hypot(offsetX - ratio * spanX, offsetY - ratio * spanY);
};

// 命中判定用相邻采样点之间的线段距离；只比对采样点会漏掉长直线中段。
const distanceToStroke = (stroke: Stroke, point: Point): number => {
  let best = Number.POSITIVE_INFINITY;
  let previous: Point | undefined;
  for (const current of stroke.points) {
    best = Math.min(best, distanceToSegment(point, previous ?? current, current));
    if (best === 0) break;
    previous = current;
  }
  return best;
};

export const createBoard = (): BoardDocument => ({
  schemaVersion: SCHEMA_VERSION,
  pages: [{ id: newId('page'), background: 'blank', strokes: [] }],
});

export const parseBoard = (raw: string): BoardDocument => {
  if (typeof raw !== 'string') fail('parseBoard 需要字符串输入');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('白板数据不是合法 JSON');
  }
  return toDocument(parsed);
};

export const serializeBoard = (doc: BoardDocument): string => JSON.stringify(toDocument(doc));

export const appendStroke = (doc: BoardDocument, pageId: string, stroke: Stroke): BoardDocument => {
  const current = toDocument(doc);
  if (!current.pages.some((page) => page.id === pageId)) fail(`找不到页 ${pageId}`);
  const added = toStroke(stroke, '新增笔');
  return toDocument({
    ...current,
    pages: current.pages.map((page) => (page.id === pageId ? { ...page, strokes: [...page.strokes, added] } : page)),
  });
};

export const eraseAt = (doc: BoardDocument, pageId: string, point: Point, radius: number): BoardDocument => {
  const current = toDocument(doc);
  const target = toPoint(point, '擦除点');
  if (!isFiniteNumber(radius) || radius <= 0 || radius > BOARD_WIDTH) fail(`擦除半径必须在 0..${BOARD_WIDTH} 之内`);
  if (!current.pages.some((page) => page.id === pageId)) fail(`找不到页 ${pageId}`);
  return toDocument({
    ...current,
    pages: current.pages.map((page) =>
      page.id === pageId
        ? { ...page, strokes: page.strokes.filter((stroke) => distanceToStroke(stroke, target) > radius) }
        : page,
    ),
  });
};

export const addPage = (doc: BoardDocument, background: BoardPage['background']): BoardDocument => {
  const current = toDocument(doc);
  if (background !== 'blank' && background !== 'exercise') fail('background 必须是 blank 或 exercise');
  let id = newId('page');
  while (current.pages.some((page) => page.id === id)) id = newId('page');
  return toDocument({ ...current, pages: [...current.pages, { id, background, strokes: [] }] });
};
