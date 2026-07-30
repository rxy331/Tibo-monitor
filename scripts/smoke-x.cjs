'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, safeStorage } = require('electron');
const { Storage } = require('../src/lib/storage.cjs');
const { XActionsSource } = require('../src/lib/xactions-source.cjs');
const { configureElectronDataPaths } = require('../src/lib/electron-paths.cjs');

configureElectronDataPaths(app);

app.whenReady().then(async () => {
  const keeper = new BrowserWindow({ width: 1, height: 1, show: false });
  const storage = new Storage({ documentsPath: app.getPath('documents'), safeStorage }).init();
  const includeReplies = process.argv.includes('--include-replies');
  if (includeReplies) storage.settings.x.includeReplies = true;
  const source = new XActionsSource({
    profilePath: storage.paths.browserProfile,
    getSettings: () => storage.settings,
    log: (...args) => storage.log(...args),
  });
  try {
    const result = await source.test();
    fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
    const outputName = includeReplies ? 'x-replies-smoke.json' : 'x-smoke.json';
    fs.writeFileSync(path.join(__dirname, '..', 'artifacts', outputName), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(result));
  } finally {
    await source.close();
    keeper.destroy();
  }
  app.quit();
}).catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error.code || null, message: error.message }));
  app.exit(1);
});
