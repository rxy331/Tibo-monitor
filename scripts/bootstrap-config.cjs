'use strict';

const { app, safeStorage } = require('electron');
const { Storage } = require('../src/lib/storage.cjs');
const { configureElectronDataPaths } = require('../src/lib/electron-paths.cjs');

configureElectronDataPaths(app);

app.whenReady().then(() => {
  const storage = new Storage({ documentsPath: app.getPath('documents'), safeStorage }).init();
  const secretPatch = {};
  if (process.env.TIBO_BOOTSTRAP_DEEPSEEK_KEY) secretPatch.deepseekApiKey = process.env.TIBO_BOOTSTRAP_DEEPSEEK_KEY;
  if (process.env.TIBO_BOOTSTRAP_SMTP_PASSWORD) secretPatch.smtpPassword = process.env.TIBO_BOOTSTRAP_SMTP_PASSWORD;
  if (Object.keys(secretPatch).length) storage.saveSecrets(secretPatch);

  const mailAddress = String(process.env.TIBO_BOOTSTRAP_MAIL_ADDRESS || '').trim();
  if (mailAddress) {
    storage.settings.mail = {
      ...storage.settings.mail,
      enabled: true,
      host: 'smtp.qq.com',
      port: 465,
      secure: true,
      username: mailAddress,
      from: mailAddress,
      recipients: String(process.env.TIBO_BOOTSTRAP_MAIL_RECIPIENTS || mailAddress).trim(),
    };
    storage.saveSettings(storage.settings);
  }
  console.log(JSON.stringify({
    ok: true,
    dataPath: storage.root,
    ...storage.secretPresence(),
    mailConfigured: Boolean(storage.settings.mail.host && storage.settings.mail.recipients),
  }));
  app.quit();
}).catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error.message }));
  app.exit(1);
});
