'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, Notification, shell } = require('electron');
const {
  APP_USER_MODEL_ID,
  TOAST_ACTIVATOR_CLSID,
  WindowsNotifier,
} = require('../src/lib/windows-notifier.cjs');

const ROOT = path.resolve(__dirname, '..');
const outputPath = path.join(ROOT, 'artifacts', 'windows-notification-smoke.json');
let shortcutPathUsed = null;
let previousShortcut = null;

app.setAppUserModelId(APP_USER_MODEL_ID);
app.setToastActivatorCLSID?.(TOAST_ACTIVATOR_CLSID);

function ensureShortcut() {
  const shortcutPath = path.join(
    app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Tibo Monitor.lnk',
  );
  shortcutPathUsed = shortcutPath;
  previousShortcut = fs.existsSync(shortcutPath) ? fs.readFileSync(shortcutPath) : null;
  fs.mkdirSync(path.dirname(shortcutPath), { recursive: true });
  const options = {
    target: process.execPath,
    cwd: ROOT,
    args: `"${ROOT}"`,
    description: '监控 Tibo 的 X 动态与 GPT 额度重置消息',
    icon: path.join(ROOT, 'assets', 'app-icon.ico'),
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID,
    toastActivatorClsid: TOAST_ACTIVATOR_CLSID,
  };
  const operation = fs.existsSync(shortcutPath) ? 'replace' : 'create';
  if (!shell.writeShortcutLink(shortcutPath, operation, options)) {
    throw new Error('Windows 未能写入通知快捷方式。');
  }
  return shortcutPath;
}

function restoreShortcut() {
  if (!shortcutPathUsed) return;
  if (previousShortcut) {
    fs.writeFileSync(shortcutPathUsed, previousShortcut);
  } else if (fs.existsSync(shortcutPathUsed)) {
    fs.unlinkSync(shortcutPathUsed);
  }
}

app.whenReady().then(async () => {
  const notifier = new WindowsNotifier({
    Notification,
    ensureShortcut,
    icon: path.join(ROOT, 'assets', 'app-icon.png'),
  });
  const result = await notifier.test();
  restoreShortcut();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify({
    ...result,
    supported: notifier.isSupported(),
    checkedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  setTimeout(() => app.quit(), 800);
}).catch((error) => {
  restoreShortcut();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify({
    ok: false,
    message: error.message,
    checkedAt: new Date().toISOString(),
  }, null, 2)}\n`, 'utf8');
  app.exit(1);
});
