// The editor chrome owns no locale state. Each host passes the table for its own locale.
export type BoardLocale = 'zh-CN' | 'en-US';
export type BoardStrings = {
  boardArea: string;
  back: string;
  retry: string;
  rename: string;
  renameLabel: string;
  cancel: string;
  confirm: string;
  dismiss: string;
  /** Title given to the single pre-index board when the library index is first created. */
  migratedBoardTitle: string;
  /** Title of a board the editor itself has to create (first run, or a conflict copy). */
  newBoardTitle: string;
  /** Appended to the original title when local edits are kept beside a board changed elsewhere. */
  copySuffix: string;
  opening: string;
  openFailed: string;
  saved: string;
  saving: string;
  notSaved: string;
  conflictKeptBoth: string;
  page: string;
  pages: string;
  newPage: string;
  deletePage: string;
  deletePageConfirm: string;
  pageCapacity: string;
  insert: string;
  insertCamera: string;
  insertLibrary: string;
  insertBlank: string;
  importing: string;
  imageError: string;
  startCall: string;
};
const zh: BoardStrings = {
  boardArea: '白板编辑',
  back: '返回',
  retry: '重试',
  rename: '重命名白板',
  renameLabel: '白板名称',
  cancel: '取消',
  confirm: '确定',
  dismiss: '关闭',
  migratedBoardTitle: '我的白板',
  newBoardTitle: '新白板',
  copySuffix: '（副本）',
  opening: '正在打开白板…',
  openFailed: '无法打开白板，原件已保留。',
  saved: '已自动保存',
  saving: '正在保存…',
  notSaved: '未能保存 · 点按重试',
  conflictKeptBoth: '这块白板在别处更新过，已保留两份',
  page: '第 {n} 页',
  pages: '页面',
  newPage: '新建页',
  deletePage: '删除当前页',
  deletePageConfirm: '删除当前页？保存后无法撤销删除。',
  pageCapacity: '最多 30 页',
  insert: '插入',
  insertCamera: '拍题',
  insertLibrary: '从相册选图',
  insertBlank: '空白页',
  importing: '正在处理图片…',
  imageError: '图片未导入。请检查权限、图片格式或大小后重试。',
  startCall: '发起家庭通话',
};
const en: BoardStrings = {
  boardArea: 'Whiteboard editor',
  back: 'Back',
  retry: 'Retry',
  rename: 'Rename board',
  renameLabel: 'Board name',
  cancel: 'Cancel',
  confirm: 'OK',
  dismiss: 'Dismiss',
  migratedBoardTitle: 'My whiteboard',
  newBoardTitle: 'New board',
  copySuffix: ' (copy)',
  opening: 'Opening board…',
  openFailed: 'Cannot open the board. The original is kept.',
  saved: 'Saved automatically',
  saving: 'Saving…',
  notSaved: 'Not saved · tap to retry',
  conflictKeptBoth: 'This board changed elsewhere; both versions were kept',
  page: 'Page {n}',
  pages: 'Pages',
  newPage: 'New page',
  deletePage: 'Delete this page',
  deletePageConfirm: 'Delete this page? Deletion cannot be undone after saving.',
  pageCapacity: 'Maximum 30 pages',
  insert: 'Insert',
  insertCamera: 'Photograph a question',
  insertLibrary: 'Choose from library',
  insertBlank: 'Blank page',
  importing: 'Preparing image…',
  imageError: 'Image not imported. Check permission, type or size and retry.',
  startCall: 'Start a family call',
};
const tables: Record<BoardLocale, BoardStrings> = { 'zh-CN': zh, 'en-US': en };
export function boardStrings(locale: BoardLocale): BoardStrings { return tables[locale] ?? en; }
/** `第 2 页` / `Page 2` without handing the host a format string. */
export const pageLabel = (strings: BoardStrings, index: number) => strings.page.replace('{n}', String(index));
