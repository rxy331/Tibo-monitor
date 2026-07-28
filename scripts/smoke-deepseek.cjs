'use strict';

const { app, safeStorage } = require('electron');
const { Storage } = require('../src/lib/storage.cjs');
const { DeepSeekClient } = require('../src/lib/deepseek.cjs');
const { configureElectronDataPaths } = require('../src/lib/electron-paths.cjs');

configureElectronDataPaths(app);

app.whenReady().then(async () => {
  const storage = new Storage({ documentsPath: app.getPath('documents'), safeStorage }).init();
  const client = new DeepSeekClient({
    getSettings: () => storage.settings,
    getApiKey: () => storage.secrets.deepseekApiKey,
    log: (...args) => storage.log(...args),
  });
  const result = await client.test();
  console.log(JSON.stringify(result));
  app.quit();
}).catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error.message }));
  app.exit(1);
});
