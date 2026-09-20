// Playwright runner integration: real Node processes/files, not browser or native UI acceptance.
import { test, expect } from 'playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const moduleUrl = new URL('../../experiments/video-whiteboard/local-archive.mjs', import.meta.url).href;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XkAAAAASUVORK5CYII=';
const fixture = {
  boardId: 'synthetic-homework',
  title: 'Synthetic question',
  pages: [{ pageId: 'page-1', imageRef: 'question', strokes: [
    { strokeId: 'stroke-1', tool: 'pen', color: '#112233', width: 2, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] },
  ] }],
};

async function inProcess(root, body) {
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
    import { saveArchive, openArchive } from ${JSON.stringify(moduleUrl)};
    const root = process.argv[1];
    const draft = ${JSON.stringify(fixture)};
    const image = Buffer.from(${JSON.stringify(png)}, 'base64');
    draft.attachments = [{ attachmentId: 'question', mediaType: 'image/png', bytes: image }];
    ${body}
  `, root], { timeout: 15_000 });
  return stdout ? JSON.parse(stdout) : null;
}

let root;
test.beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'siyue-board-e2e-')); });
test.afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

test('editable archive survives writer exit, is edited in a second process and reopened in a third', async () => {
  await inProcess(root, 'await saveArchive(root, draft);');
  const edited = await inProcess(root, `
    const original = await openArchive(root, { includeAttachmentBytes: true });
    const pages = structuredClone(original.pages);
    pages[0].strokes[0].points[0].x = 77;
    pages.push({ pageId: 'blank-page', imageRef: null, strokes: [] });
    await saveArchive(root, { ...draft, pages });
    console.log(JSON.stringify({ boardId: original.boardId, originalPoint: original.pages[0].strokes[0].points[0].x }));
  `);
  expect(edited).toEqual({ boardId: fixture.boardId, originalPoint: 10 });
  const reopened = await inProcess(root, `
    const result = await openArchive(root, { includeAttachmentBytes: true });
    console.log(JSON.stringify({ boardId: result.boardId, pages: result.pages,
      image: Buffer.from(result.attachments[0].data).toString('base64') }));
  `);
  expect(reopened.boardId).toBe(fixture.boardId);
  expect(reopened.pages).toHaveLength(2);
  expect(reopened.pages[0].strokes[0].points).toEqual([{ x: 77, y: 20 }, { x: 30, y: 40 }]);
  expect(reopened.pages[1]).toMatchObject({ pageId: 'blank-page', imageRef: null, strokes: [] });
  expect(reopened.image).toBe(png);
});

test('writer crash before commit leaves the previous editable document readable', async () => {
  await inProcess(root, 'await saveArchive(root, draft);');
  await expect(inProcess(root, `
    draft.pages[0].strokes[0].points[0].x = 999;
    await saveArchive(root, draft, { faults: { afterRevisionRenamed: () => process.exit(71) } });
  `)).rejects.toMatchObject({ code: 71 });
  const reopened = await inProcess(root, `
    const result = await openArchive(root);
    console.log(JSON.stringify({ status: result.status, x: result.pages[0].strokes[0].points[0].x }));
  `);
  expect(reopened).toEqual({ status: 'ok', x: 10 });
});
