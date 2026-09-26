// Browser coverage for the editor chrome. The page under test is packages/whiteboard/tests/fixture
// built with the Electron app's vite binary, so the whiteboard package still owns no bundler.
import { test, expect } from 'playwright/test';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const run = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const workspace = path.join(packageRoot, 'node_modules', '.editor-fixture');
const build = path.join(workspace, 'build');
const require = createRequire(path.join(packageRoot, 'package.json'));
const fonts = path.join(path.dirname(require.resolve('@excalidraw/excalidraw')), 'fonts');
const vite = path.join(repoRoot, 'apps', 'desktop', 'node_modules', '.bin', 'vite');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
let server;
let origin = '';

const read = page => page.evaluate(() => window.__fixture.snapshot());
const setOptions = (page, options) => page.evaluate(next => Object.assign(window.__fixture.state.options, next), options);
const lastSave = async page => (await read(page)).saves.at(-1);
const savedCounts = async page => (await lastSave(page)).count;

async function draw(page, { dx = 48, dy = 52 } = {}) {
  await page.locator('.page-shell.on label').filter({ has: page.locator('[data-testid="toolbar-freedraw"]') }).click();
  const box = await page.locator('.page-shell.on canvas.interactive').boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3 + dx, box.y + box.height * 0.4 + dy, { steps: 12 });
  await page.mouse.up();
}
async function openPages(page) {
  await page.getByRole('button', { name: '页面' }).click();
  return page.getByRole('dialog', { name: '页面' });
}

test.beforeAll(async () => {
  await rm(workspace, { recursive: true, force: true });
  await run(vite, ['build', '--config', path.join(packageRoot, 'tests', 'fixture', 'vite.config.mjs'), '--outDir', build, '--emptyOutDir', '--logLevel', 'warn'], { cwd: packageRoot, maxBuffer: 64 * 1024 * 1024 });
  server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = pathname.startsWith('/excalidraw/fonts/')
      ? path.join(fonts, pathname.slice('/excalidraw/fonts/'.length))
      : path.join(build, pathname === '/' ? 'index.html' : pathname);
    try {
      const data = await readFile(file);
      response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = 'http://127.0.0.1:' + server.address().port + '/';
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.EXCALIDRAW_ASSET_PATH = '/excalidraw/'; });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(origin);
  await expect(page.getByRole('button', { name: /已自动保存/ })).toBeVisible();
});

test('opens the newest board full bleed with autosave chrome, no save button and no blocking shell', async ({ page }) => {
  const fixtures = await read(page);
  expect(fixtures.ops.slice(0, 3)).toEqual(['list', 'create', 'load']);
  expect(fixtures.boards.map(board => board.title)).toEqual(['新白板']);
  await expect(page.getByRole('button', { name: '返回' })).toBeVisible();
  await expect(page.getByRole('button', { name: '插入' })).toBeVisible();
  await expect(page.getByRole('button', { name: '页面' })).toHaveText('1/1');
  // The explicit save button and the full-screen save overlay are gone.
  await expect(page.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  await expect(page.locator('.blocking')).toHaveCount(0);
  // No host supplied a call flow, so the call entry stays hidden instead of pretending.
  await expect(page.getByRole('button', { name: '发起家庭通话' })).toHaveCount(0);
  const canvas = await page.locator('.page-shell.on canvas.interactive').boundingBox();
  expect(canvas.width).toBeGreaterThan(1000);
  expect(canvas.height).toBeGreaterThan(700);
});

test('phone-sized canvas keeps the document bar above the drawing tools', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const top = await page.locator('.wb-top').boundingBox();
  const tool = await page.locator('.page-shell.on label').filter({ has: page.locator('[data-testid="toolbar-freedraw"]') }).boundingBox();
  expect(top.y + top.height).toBeLessThan(tool.y);
  await draw(page);
  await expect.poll(async () => (await read(page)).boards[0].count).toEqual([1]);
});

test('drawing autosaves with a board thumbnail while the status line stays in the title', async ({ page }) => {
  await draw(page);
  await expect.poll(async () => (await read(page)).saves.length).toBeGreaterThan(0);
  const save = await lastSave(page);
  expect(save.count).toEqual([1]);
  expect(save.thumbnail).toBe(true);
  await expect(page.getByRole('button', { name: /已自动保存/ })).toBeVisible();
  await expect(page.locator('.blocking')).toHaveCount(0);
});

test('the page sheet adds and deletes a page and keeps the other page content', async ({ page }) => {
  await draw(page);
  await expect.poll(async () => (await read(page)).saves.length).toBeGreaterThan(0);
  expect(await savedCounts(page)).toEqual([1]);

  (await openPages(page)).getByRole('button', { name: '新建页' }).click();
  await expect(page.getByRole('button', { name: '页面' })).toHaveText('2/2');
  await draw(page, { dx: 60, dy: 64 });
  await expect.poll(async () => savedCounts(page)).toEqual([1, 1]);

  const sheet = await openPages(page);
  await expect(sheet.getByRole('button', { name: '新建页' })).toBeVisible();
  await sheet.getByRole('button', { name: '删除当前页' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '删除当前页' }).click();
  await expect(page.getByRole('button', { name: '页面' })).toHaveText('1/1');
  await expect.poll(async () => (await savedCounts(page)).length).toBe(1);
  expect(await savedCounts(page)).toEqual([1]);
});

test('switching pages keeps the undo history of each page', async ({ page }) => {
  await draw(page);
  await expect.poll(async () => (await read(page)).saves.length).toBeGreaterThan(0);
  (await openPages(page)).getByRole('button', { name: '新建页' }).click();
  await expect(page.getByRole('button', { name: '页面' })).toHaveText('2/2');
  await draw(page, { dx: 60, dy: 64 });
  await expect.poll(async () => savedCounts(page)).toEqual([1, 1]);

  (await openPages(page)).getByRole('button', { name: '第 1 页' }).click();
  await expect(page.getByRole('button', { name: '页面' })).toHaveText('1/2');
  await page.locator('.page-shell.on [data-testid="button-undo"]').click();
  // Only the first page loses its stroke: page two keeps both its ink and its own history.
  await expect.poll(async () => savedCounts(page)).toEqual([0, 1]);
});

test('the insert sheet offers the camera only when the host has one', async ({ page }) => {
  await page.getByRole('button', { name: '插入' }).click();
  const sheet = page.getByRole('dialog', { name: '插入' });
  await expect(sheet.getByRole('button', { name: '从相册选图' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: '空白页' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: '拍题' })).toHaveCount(0);

  await page.evaluate(() => window.__fixture.mount({ camera: true }));
  await expect(page.getByRole('button', { name: /已自动保存/ })).toBeVisible();
  await page.getByRole('button', { name: '插入' }).click();
  const withCamera = page.getByRole('dialog', { name: '插入' });
  await expect(withCamera.getByRole('button', { name: '拍题' })).toBeVisible();
  await withCamera.getByRole('button', { name: '拍题' }).click();
  await page.getByRole('button', { name: '插入' }).click();
  await page.getByRole('dialog', { name: '插入' }).getByRole('button', { name: '从相册选图' }).click();
  await expect.poll(async () => (await read(page)).picks).toEqual(['camera', 'library']);
});

test('a photo start picks before creating and saves the image on the new board', async ({ page }) => {
  await page.evaluate(() => window.__fixture.mount({ startWith: 'photo', camera: true }));
  await expect.poll(async () => (await read(page)).boards.length).toBe(2);
  await expect.poll(async () => (await read(page)).boards.find(board => board.id === 'board-2')?.count).toEqual([1]);
  const fixture = await read(page);
  expect(fixture.ops.slice(-5)).toEqual(['list', 'pick', 'create', 'load', 'save']);
  expect(fixture.picks).toEqual(['camera']);
  expect(fixture.saves.at(-1).files).toEqual(['file-1']);
});

test('a library image can start a new board without opening the camera', async ({ page }) => {
  await page.evaluate(() => window.__fixture.mount({ startWith: 'library' }));
  await expect.poll(async () => (await read(page)).boards.find(board => board.id === 'board-2')?.count).toEqual([1]);
  const fixture = await read(page);
  expect(fixture.picks).toEqual(['library']);
  expect(fixture.ops.slice(-5)).toEqual(['list', 'pick', 'create', 'load', 'save']);
});

test('canceling a photo start leaves the library without creating an empty board', async ({ page }) => {
  await page.evaluate(() => window.__fixture.mount({ startWith: 'photo', camera: true, pickCancels: true }));
  await expect.poll(async () => (await read(page)).exits).toBe(1);
  const fixture = await read(page);
  expect(fixture.ops.slice(-3)).toEqual(['list', 'pick', 'exit']);
  expect(fixture.boards.length).toBe(1);
});

test('a board changed elsewhere keeps both versions instead of naming the maintainer', async ({ page }) => {
  await draw(page);
  await expect.poll(async () => (await read(page)).saves.length).toBeGreaterThan(0);
  await setOptions(page, { conflictOnce: true });
  await draw(page, { dx: 70, dy: 40 });

  await expect(page.getByRole('status')).toContainText('这块白板在别处更新过，已保留两份');
  const fixtures = await read(page);
  expect(fixtures.creates).toEqual(['新白板', '新白板（副本）']);
  expect(fixtures.boards.find(board => board.title === '新白板').revision).toBe(1);
  const copy = fixtures.boards.find(board => board.title === '新白板（副本）');
  expect(copy.revision).toBe(1);
  expect(copy.count).toEqual([2]);
  expect(fixtures.saves.at(-1)).toMatchObject({ boardId: copy.id, baseRevision: 0, revision: 1 });
  await expect(page.getByRole('button', { name: /新白板（副本）/ })).toBeVisible();
  // The copy is the active document now: its own edits save there, not into the board of the other device.
  await draw(page, { dx: 30, dy: 90 });
  await expect.poll(async () => (await lastSave(page)).boardId).toBe(copy.id);
  await expect(page.locator('body')).not.toContainText('维护者');
});

test('a failed save shows retry in the title without covering the canvas, and tapping it retries', async ({ page }) => {
  await draw(page);
  await expect.poll(async () => (await read(page)).saves.length).toBeGreaterThan(0);
  await setOptions(page, { saveFails: 1 });
  await draw(page, { dx: 70, dy: 40 });

  const retry = page.getByRole('button', { name: /未能保存 · 点按重试/ });
  await expect(retry).toBeVisible();
  await expect(page.locator('.blocking')).toHaveCount(0);
  const canvas = await page.locator('.page-shell.on canvas.interactive').boundingBox();
  expect(canvas.height).toBeGreaterThan(700);

  await retry.click();
  await expect(page.getByRole('button', { name: /已自动保存/ })).toBeVisible();
  expect((await read(page)).boards[0].count).toEqual([2]);
});

test('leaving flushes the newest revision before the host is told the editor exited', async ({ page }) => {
  await draw(page);
  // No debounce wait: the back button must flush first and exit second.
  await page.getByRole('button', { name: '返回' }).click();
  await expect.poll(async () => (await read(page)).exits).toBe(1);
  const fixtures = await read(page);
  expect(fixtures.ops.slice(-2)).toEqual(['save', 'exit']);
  expect(fixtures.boards[0].count).toEqual([1]);
});
