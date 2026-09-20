import { test as base, expect } from 'playwright/test';
import { _electron } from 'playwright';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'apps/desktop/package.json'));

export const test = base.extend({
  desktop: async ({}, use, testInfo) => {
    const dataDir = testInfo.outputPath('user-data');
    await mkdir(dataDir, { recursive: true });
    let application;
    let page;
    let launch = 0;
    const errors = [];
    const traces = [];
    const runtime = [];
    async function close() {
      if (!application) return;
      const current = application;
      application = undefined;
      const trace = testInfo.outputPath(`trace-${launch}.zip`);
      try {
        await current.context().tracing.stop({ path: trace });
        traces.push(trace);
      } finally {
        await current.close();
      }
    }
    async function start() {
      launch += 1;
      const env = { ...process.env, SIYUE_DATA_DIR: dataDir, SIYUE_RENDERER_URL: '' };
      delete env.ELECTRON_RUN_AS_NODE;
      application = await _electron.launch({
        executablePath: require('electron'), args: [path.join(root, 'apps/desktop')],
        cwd: root, env, chromiumSandbox: true, timeout: 30_000,
      });
      await application.context().route(/^https?:\/\//, (route) => route.abort());
      await application.context().tracing.start({ screenshots: true, snapshots: true });
      page = await application.firstWindow();
      page.on('pageerror', (error) => errors.push(error.message));
      await expect(page.locator('.local-badge')).toHaveText(/离线可用|Available offline/);
      runtime.push(await application.evaluate(() => ({ versions: process.versions, platform: process.platform, arch: process.arch })));
    }
    const desktop = {
      get page() { return page; },
      get dataDir() { return dataDir; },
      async chooseImage(file) {
        await application.evaluate(({ dialog }, chosen) => { dialog.showOpenDialog = async () => ({ canceled: !chosen, filePaths: chosen ? [chosen] : [] }); }, file);
      },
      async resize(width, height) {
        await application.evaluate(({ BrowserWindow }, size) => { const win=BrowserWindow.getAllWindows()[0]; win.setMinimumSize(300,400); win.setContentSize(size.width,size.height); }, {width,height});
      },
      async restart() { await close(); await start(); },
      async snapshot() {
        const reply = await page.evaluate(() => window.siyueDesktop.invoke({
          requestId: crypto.randomUUID(), method: 'snapshot', args: [],
        }));
        expect(reply.ok).toBe(true);
        return reply.value;
      },
    };
    try {
      await start();
      await use(desktop);
      expect(errors, 'renderer runtime errors').toEqual([]);
    } finally {
      const failed = testInfo.status !== testInfo.expectedStatus || errors.length > 0;
      if (failed && page && !page.isClosed()) {
        const screenshot = await page.screenshot().catch(() => null);
        if (screenshot) await testInfo.attach('failure', { body: screenshot, contentType: 'image/png' });
        else await testInfo.attach('screenshot-unavailable', { body: 'Window closed or screenshot capture failed.', contentType: 'text/plain' });
      }
      let closeError;
      try { await close(); } catch (error) { closeError = error; }
      const report = { test: testInfo.title, status: testInfo.status, runtime, errors, launches: launch,
        scope: 'Electron renderer + IPC + local SQLite; not native mobile', dataDir, closeError: closeError?.message };
      await writeFile(testInfo.outputPath('result.json'), JSON.stringify(report, null, 2));
      if (failed || closeError) for (const trace of traces) await testInfo.attach(path.basename(trace), { path: trace, contentType: 'application/zip' });
      if (closeError) throw closeError;
      // Every test gets its own synthetic DB. Keep it and traces locally for diagnosis; never clear user data.
    }
  },
});
export { expect };
