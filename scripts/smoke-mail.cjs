'use strict';

const { app, safeStorage } = require('electron');
const { Storage } = require('../src/lib/storage.cjs');
const { Mailer } = require('../src/lib/mailer.cjs');
const { configureElectronDataPaths } = require('../src/lib/electron-paths.cjs');

configureElectronDataPaths(app);

app.whenReady().then(async () => {
  const storage = new Storage({ documentsPath: app.getPath('documents'), safeStorage }).init();
  const mailer = new Mailer({
    getSettings: () => storage.settings,
    getPassword: () => storage.secrets.smtpPassword,
    log: (...args) => storage.log(...args),
  });
  const result = await mailer.test();
  console.log(JSON.stringify({ ok: result.ok, accepted: result.accepted }));
  app.quit();
}).catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error.message }));
  app.exit(1);
});
