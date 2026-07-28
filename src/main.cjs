'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  safeStorage,
  shell,
  Tray,
} = require('electron');
const { Storage } = require('./lib/storage.cjs');
const { DEFAULT_SETTINGS, DEFAULT_STATE } = require('./lib/defaults.cjs');
const { FIREFOX_LABEL, XActionsSource, isFirefoxExecutable } = require('./lib/xactions-source.cjs');
const { listFirefoxProfiles } = require('./lib/firefox-profiles.cjs');
const { DeepSeekClient } = require('./lib/deepseek.cjs');
const { Mailer } = require('./lib/mailer.cjs');
const { MonitorService, rebaseSettingsSnapshot } = require('./lib/monitor.cjs');
const { backupLegacyJsonFile, safeError, sanitizeSettings } = require('./lib/utils.cjs');
const { configureElectronDataPaths } = require('./lib/electron-paths.cjs');

configureElectronDataPaths(app);

const diagnosticSmoke = process.argv.includes('--diagnostic-smoke');
const diagnosticPath = path.join(app.getPath('documents'), 'Tibo Monitor', 'startup-diagnostic.json');

function writeStartupDiagnostic(payload) {
  fs.mkdirSync(path.dirname(diagnosticPath), { recursive: true });
  fs.writeFileSync(diagnosticPath, JSON.stringify({
    checkedAt: new Date().toISOString(),
    version: app.getVersion(),
    userData: app.getPath('userData'),
    ...payload,
  }, null, 2), 'utf8');
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

let mainWindow = null;
let tray = null;
let storage = null;
let source = null;
let monitor = null;
let isQuitting = false;
let quitCleanupInProgress = false;
let quitCleanupComplete = false;

const assetPath = (name) => path.join(__dirname, '..', 'assets', name);
const firefoxAppDataPath = () => path.join(app.getPath('appData'), 'Mozilla', 'Firefox');
const rendererEntryPath = path.resolve(__dirname, 'renderer', 'index.html');

function comparableLocalPath(value) {
  const normalized = path.normalize(path.resolve(value));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isTrustedRendererUrl(value) {
  try {
    const candidate = new URL(String(value || ''));
    if (candidate.protocol !== 'file:' || candidate.search || candidate.hash) return false;
    return comparableLocalPath(fileURLToPath(candidate)) === comparableLocalPath(rendererEntryPath);
  } catch {
    return false;
  }
}

function publicBrowserProfile(profile = {}) {
  return {
    id: String(profile.id || ''),
    name: String(profile.name || ''),
    path: String(profile.path || ''),
    isRelative: Boolean(profile.isRelative),
    isDefault: Boolean(profile.isDefault),
    isInstallDefault: Boolean(profile.isInstallDefault),
    installIds: Array.isArray(profile.installIds) ? profile.installIds.map(String) : [],
    exists: Boolean(profile.exists),
    registered: Boolean(profile.registered),
    rootPath: String(profile.rootPath || ''),
    profileDirectory: String(profile.profileDirectory || ''),
  };
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 1040,
    minHeight: 690,
    show: false,
    backgroundColor: '#061523',
    icon: assetPath('app-icon.png'),
    title: 'Tibo Monitor',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.loadFile(rendererEntryPath);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const targetUrl = event.url || (typeof navigationUrl === 'string' ? navigationUrl : navigationUrl?.url);
    if (!isTrustedRendererUrl(targetUrl)) {
      event.preventDefault();
      storage?.log('warn', 'Blocked renderer navigation away from the local application entry.');
    }
  });
  mainWindow.once('ready-to-show', () => {
    if (!storage.settings.app.startMinimized) mainWindow.show();
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting && storage?.settings.app.closeToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  let trayImage = nativeImage.createFromPath(assetPath('app-icon.png'));
  if (!trayImage.isEmpty()) trayImage = trayImage.resize({ width: 20, height: 20 });
  tray = new Tray(trayImage);
  tray.setToolTip('Tibo Monitor');
  const rebuild = () => {
    const enabled = storage.settings.app.monitoringEnabled;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Tibo Monitor', click: showWindow },
      {
        label: '立即检查',
        click: async () => {
          try {
            const result = await monitor.checkNow('tray');
            if (result.code === 'X_RISK_NOT_ACCEPTED') {
              await dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: '需要确认风险',
                message: result.message,
              });
            }
          } catch (error) {
            storage.log('error', `Tray manual check failed: ${safeError(error)}`);
          }
        },
      },
      { type: 'separator' },
      {
        label: enabled ? '暂停监控' : '开始监控',
        click: async () => {
          try {
            await monitor.setEnabled(!enabled);
          } catch (error) {
            storage.log('warn', `Tray monitor toggle rejected: ${safeError(error)}`);
            if (error.code === 'X_RISK_NOT_ACCEPTED') {
              await dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: '需要确认风险',
                message: safeError(error),
              });
            }
          } finally {
            rebuild();
          }
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit(); } },
    ]));
  };
  rebuild();
  monitor.on('update', rebuild);
  tray.on('double-click', showWindow);
}

function createShortcut() {
  const shortcutPath = path.join(app.getPath('desktop'), 'Tibo Monitor.lnk');
  const portableExecutable = String(process.env.PORTABLE_EXECUTABLE_FILE || '').trim();
  const portableTarget = portableExecutable ? path.resolve(portableExecutable) : null;
  const target = app.isPackaged && portableTarget && fs.existsSync(portableTarget)
    ? portableTarget
    : process.execPath;
  const options = {
    target,
    cwd: app.isPackaged ? path.dirname(target) : app.getAppPath(),
    description: '监控 Tibo 的 X 动态与 GPT 额度重置消息',
    icon: app.isPackaged ? target : assetPath('app-icon.ico'),
    iconIndex: 0,
    ...(app.isPackaged ? {} : { args: `"${app.getAppPath()}"` }),
  };
  const operation = fs.existsSync(shortcutPath) ? 'replace' : 'create';
  const ok = shell.writeShortcutLink(shortcutPath, operation, options);
  if (!ok) throw new Error('Windows 未能创建桌面快捷方式。');
  return { ok: true, path: shortcutPath };
}

function registerIpc(ai, mailer) {
  let settingsSaveQueue = Promise.resolve();
  const enqueueSettingsSave = (task) => {
    const queued = settingsSaveQueue.then(task, task);
    settingsSaveQueue = queued.then(() => undefined, () => undefined);
    return queued;
  };

  const trustedHandle = (channel, handler) => {
    ipcMain.handle(channel, (event, ...args) => {
      let senderUrl = '';
      try {
        senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || '';
      } catch {
        // A destroyed or detached frame is not a trusted application sender.
      }
      if (!isTrustedRendererUrl(senderUrl)) {
        storage?.log('warn', `Blocked IPC ${channel} from an untrusted renderer.`);
        throw Object.assign(new Error('已拒绝非本地应用界面的请求。'), { code: 'IPC_UNTRUSTED_SENDER' });
      }
      return handler(event, ...args);
    });
  };

  const saveXConnection = (patch, { markChecked = true } = {}) => {
    const now = new Date().toISOString();
    storage.state.xConnection = {
      ...storage.state.xConnection,
      handle: `@${storage.settings.x.handle}`,
      ...(markChecked ? { checkedAt: now } : {}),
      ...patch,
    };
    storage.saveState();
    monitor.emitUpdate();
  };

  const saveAiConnection = (patch) => {
    storage.state.aiConnection = {
      ...storage.state.aiConnection,
      checkedAt: new Date().toISOString(),
      model: storage.settings.ai.model,
      baseUrl: storage.settings.ai.baseUrl,
      ...patch,
    };
    storage.saveState();
    monitor.emitUpdate();
  };

  const saveMailConnection = (patch) => {
    storage.state.mailConnection = {
      ...storage.state.mailConnection,
      checkedAt: new Date().toISOString(),
      host: storage.settings.mail.host,
      port: storage.settings.mail.port,
      ...patch,
    };
    storage.saveState();
    monitor.emitUpdate();
  };

  trustedHandle('app:get-state', () => monitor.snapshot());

  trustedHandle('settings:save', (_event, payload = {}) => {
    const request = structuredClone(payload || {});
    const baseSettings = structuredClone(storage.settings);
    return enqueueSettingsSave(async () => {
      try {
        const requestedSettings = sanitizeSettings(request.settings || baseSettings, DEFAULT_SETTINGS);
        const nextSettings = sanitizeSettings(
          rebaseSettingsSnapshot(storage.settings, baseSettings, requestedSettings),
          DEFAULT_SETTINGS,
        );
        const previousHandle = storage.settings.x.handle;
        const previousFirefoxExecutablePath = storage.settings.x.firefoxExecutablePath;
        const previousFirefoxProfilePath = storage.settings.x.firefoxProfilePath;
        const previousAiBaseUrl = storage.settings.ai.baseUrl;
        const previousAiModel = storage.settings.ai.model;
        const previousMail = structuredClone(storage.settings.mail);
        const handleChanged = previousHandle !== nextSettings.x.handle;
        const xSourceChanged = handleChanged ||
          previousFirefoxExecutablePath !== nextSettings.x.firefoxExecutablePath ||
          previousFirefoxProfilePath !== nextSettings.x.firefoxProfilePath;

        await monitor.waitForIdle();
        if (xSourceChanged) await source.close();
        storage.saveSettings(nextSettings);
        const secretPatch = {};
        const clear = [];
        if (request.deepseekApiKey) secretPatch.deepseekApiKey = String(request.deepseekApiKey);
        if (request.smtpPassword) secretPatch.smtpPassword = String(request.smtpPassword);
        if (request.clearDeepSeekKey) clear.push('deepseekApiKey');
        if (request.clearSmtpPassword) clear.push('smtpPassword');
        if (Object.keys(secretPatch).length || clear.length) storage.saveSecrets(secretPatch, clear);
        const aiConnectionChanged = previousAiBaseUrl !== storage.settings.ai.baseUrl ||
          previousAiModel !== storage.settings.ai.model ||
          Object.hasOwn(secretPatch, 'deepseekApiKey') ||
          clear.includes('deepseekApiKey');
        if (aiConnectionChanged) {
          storage.state.aiConnection = {
            status: 'unverified',
            checkedAt: null,
            message: 'DeepSeek 配置或 API Key 已更改，请重新测试连接。',
            model: storage.settings.ai.model,
            baseUrl: storage.settings.ai.baseUrl,
            detected: null,
            confidence: null,
          };
          storage.saveState();
        }
        const mailConnectionChanged = ['host', 'port', 'secure', 'username', 'from'].some(
          (key) => previousMail[key] !== storage.settings.mail[key],
        ) || JSON.stringify(previousMail.recipients || []) !== JSON.stringify(storage.settings.mail.recipients || []) ||
          Object.hasOwn(secretPatch, 'smtpPassword') || clear.includes('smtpPassword');
        if (mailConnectionChanged) {
          storage.state.mailConnection = {
            status: 'unverified',
            checkedAt: null,
            message: 'QQ SMTP 配置、收件人或授权码已更改，请重新发送测试邮件。',
            host: storage.settings.mail.host,
            port: storage.settings.mail.port,
            accepted: 0,
          };
          storage.saveState();
        }
        if (handleChanged) {
          monitor.resetForHandleChange(previousHandle, storage.settings.x.handle);
        }
        if (xSourceChanged) {
          storage.state.xConnection = {
            ...storage.state.xConnection,
            status: 'unverified',
            checkedAt: null,
            openedAt: null,
            message: '目标账号、Firefox 程序或 Firefox profile 设置已更改，请重新验证连接。',
            errorCode: null,
            handle: `@${storage.settings.x.handle}`,
            browser: null,
            count: 0,
            newestAt: null,
          };
          storage.saveState();
        }
        const startResult = monitor.start({ immediate: false });
        return {
          ok: true,
          snapshot: monitor.snapshot(),
          ...(startResult?.ok === false ? { warning: startResult.message, code: startResult.code } : {}),
        };
      } catch (error) {
        return { ok: false, message: safeError(error), code: error.code || null };
      }
    });
  });

  trustedHandle('monitor:toggle', async (_event, enabled) => {
    try {
      return { ok: true, snapshot: await monitor.setEnabled(Boolean(enabled)) };
    } catch (error) {
      return { ok: false, message: safeError(error), code: error.code || null };
    }
  });

  trustedHandle('monitor:check', async () => monitor.checkNow('manual'));
  trustedHandle('ai:test', async () => {
    try {
      const result = await ai.test();
      saveAiConnection({
        status: 'connected',
        message: `DeepSeek 连接正常，模型 ${result.model} 已完成分类测试。`,
        detected: result.detected,
        confidence: result.confidence,
      });
      return result;
    } catch (error) {
      const message = safeError(error);
      saveAiConnection({ status: 'error', message, detected: null, confidence: null });
      return { ok: false, message };
    }
  });
  trustedHandle('mail:test', async () => {
    try {
      const result = await mailer.test();
      saveMailConnection({
        status: 'connected',
        message: `QQ SMTP 连接正常，测试邮件已被 ${result.accepted || 0} 位收件人服务器接受。`,
        accepted: result.accepted || 0,
      });
      return result;
    } catch (error) {
      const message = safeError(error);
      saveMailConnection({ status: 'error', message, accepted: 0 });
      return { ok: false, message };
    }
  });
  trustedHandle('x:choose-firefox-executable', async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: '选择 Mozilla Firefox 程序',
        properties: ['openFile'],
        filters: [{ name: 'Mozilla Firefox', extensions: ['exe'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
      const executablePath = path.resolve(result.filePaths[0]);
      const stat = fs.statSync(executablePath);
      if (!stat.isFile() || path.extname(executablePath).toLowerCase() !== '.exe' || !isFirefoxExecutable(executablePath)) {
        throw new Error('请选择 Mozilla Firefox 的 firefox.exe。');
      }
      return { ok: true, path: executablePath, label: FIREFOX_LABEL };
    } catch (error) {
      return { ok: false, message: safeError(error) };
    }
  });
  trustedHandle('x:list-firefox-profiles', () => {
    const options = {
      firefoxAppDataPath: firefoxAppDataPath(),
      savedPath: storage.settings.x.firefoxProfilePath || '',
      tiboProfilePath: path.join(storage.paths.browserProfile, 'firefox'),
    };
    try {
      const discovery = listFirefoxProfiles(options);
      const profiles = (discovery.profiles || []).map(publicBrowserProfile);
      return {
        ok: true,
        profiles,
        recommendedPath: String(discovery.recommendedPath || ''),
        recommendedName: String(discovery.recommendedName || ''),
        reason: String(discovery.reason || ''),
      };
    } catch (error) {
      return {
        ok: false,
        profiles: [],
        recommendedPath: '',
        recommendedName: '',
        reason: safeError(error),
      };
    }
  });
  trustedHandle('x:test', async () => {
    try {
      if (!storage.settings.app.acceptedXActionsRisk) {
        throw Object.assign(new Error('请先在设置中确认已了解 XActions 网页抓取风险。'), { code: 'X_RISK_NOT_ACCEPTED' });
      }
      const result = await source.test();
      if (result.profile?.path && result.profile.path !== storage.settings.x.firefoxProfilePath) {
        storage.saveSettings({
          ...storage.settings,
          x: { ...storage.settings.x, firefoxProfilePath: result.profile.path },
        });
      }
      saveXConnection({
        status: 'connected',
        openedAt: null,
        message: result.message,
        errorCode: null,
        browser: result.browser,
        count: result.count,
        newestAt: result.newestAt,
      });
      return result;
    } catch (error) {
      const waitingForWindow = ['X_LOGIN_IN_PROGRESS', 'X_LOGIN_WINDOW_STILL_OPEN'].includes(error.code);
      const profileInUse = ['X_FIREFOX_PROFILE_IN_USE', 'X_BROWSER_PROFILE_COPY_FAILED'].includes(error.code);
      const loginRequired = ['X_AUTH_REQUIRED', 'X_CHALLENGE_REQUIRED'].includes(error.code);
      saveXConnection({
        status: profileInUse ? 'waiting_profile' : waitingForWindow ? 'waiting_login' : loginRequired ? 'login_required' : 'error',
        message: safeError(error),
        errorCode: error.code || 'X_UNKNOWN',
      }, { markChecked: !waitingForWindow && !profileInUse });
      return { ok: false, message: safeError(error), code: error.code || null };
    }
  });
  trustedHandle('x:login', async () => {
    try {
      if (!storage.settings.app.acceptedXActionsRisk) throw new Error('请先确认已了解 XActions 网页抓取风险。');
      const result = await source.openLogin();
      saveXConnection({
        status: 'waiting_login',
        checkedAt: null,
        openedAt: new Date().toISOString(),
        message: result.message,
        errorCode: null,
        browser: result.browser,
      }, { markChecked: false });
      return result;
    } catch (error) {
      const waitingForWindow = error.code === 'X_LOGIN_WINDOW_STILL_OPEN';
      const profileInUse = error.code === 'X_FIREFOX_PROFILE_IN_USE';
      saveXConnection({
        status: profileInUse ? 'waiting_profile' : waitingForWindow ? 'waiting_login' : 'error',
        message: safeError(error),
        errorCode: error.code || 'X_UNKNOWN',
      }, { markChecked: !waitingForWindow && !profileInUse });
      return { ok: false, message: safeError(error), code: error.code || null };
    }
  });
  trustedHandle('app:open-data', async () => {
    const error = await shell.openPath(storage.root);
    return error ? { ok: false, message: error } : { ok: true };
  });
  trustedHandle('app:create-shortcut', () => {
    try { return createShortcut(); }
    catch (error) { return { ok: false, message: safeError(error) }; }
  });
  trustedHandle('app:open-external', async (_event, url) => {
    try {
      const parsed = new URL(String(url));
      if (parsed.protocol !== 'https:') throw new Error('仅允许打开 HTTPS 链接。');
      await shell.openExternal(parsed.toString());
      return { ok: true };
    } catch (error) {
      return { ok: false, message: safeError(error) };
    }
  });
  trustedHandle('app:create-shortcut-and-confirm', async () => {
    try {
      const result = createShortcut();
      dialog.showMessageBox(mainWindow, { type: 'info', title: '快捷方式已创建', message: '已在桌面创建 Tibo Monitor 快捷方式。' });
      return result;
    } catch (error) {
      return { ok: false, message: safeError(error) };
    }
  });
}

async function bootstrap() {
  const documentsPath = app.getPath('documents');
  const storageRoot = path.join(documentsPath, 'Tibo Monitor');
  backupLegacyJsonFile(path.join(storageRoot, 'settings.json'), DEFAULT_SETTINGS.schemaVersion);
  backupLegacyJsonFile(path.join(storageRoot, 'state.json'), DEFAULT_STATE.schemaVersion);
  storage = new Storage({ documentsPath, safeStorage }).init();
  if (diagnosticSmoke) {
    const secrets = storage.secretPresence();
    writeStartupDiagnostic({
      ok: true,
      hasDeepSeekKey: secrets.hasDeepSeekKey,
      hasSmtpPassword: secrets.hasSmtpPassword,
      warning: secrets.warning,
    });
    app.quit();
    return;
  }
  source = new XActionsSource({
    profilePath: storage.paths.browserProfile,
    firefoxAppDataPath: firefoxAppDataPath(),
    getSettings: () => storage.settings,
    log: (...args) => storage.log(...args),
  });
  const ai = new DeepSeekClient({
    getSettings: () => storage.settings,
    getApiKey: () => storage.secrets.deepseekApiKey,
    log: (...args) => storage.log(...args),
  });
  const mailer = new Mailer({
    getSettings: () => storage.settings,
    getPassword: () => storage.secrets.smtpPassword,
    log: (...args) => storage.log(...args),
  });
  monitor = new MonitorService({ storage, source, ai, mailer });
  monitor.on('update', (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monitor:update', snapshot);
  });
  registerIpc(ai, mailer);
  createWindow();
  createTray();
  monitor.start({ immediate: true });
  powerMonitor.on('resume', () => {
    if (storage.settings.app.monitoringEnabled) monitor.checkNow('resume');
  });
}

async function prepareMonitorForQuit() {
  if (quitCleanupInProgress || quitCleanupComplete) return;
  quitCleanupInProgress = true;
  while (!quitCleanupComplete) {
    try {
      if (monitor) await monitor.close();
      quitCleanupComplete = true;
      if (monitor) monitor.__closed = true;
      app.quit();
      return;
    } catch (error) {
      storage?.log('error', `Monitor shutdown blocked: ${safeError(error)}`);
      const ownedProcessCloseFailed = error.code === 'X_FIREFOX_PROCESS_CLOSE_FAILED';
      const options = {
        type: 'warning',
        title: ownedProcessCloseFailed ? 'Tibo Monitor 的 Firefox 尚未关闭' : 'Tibo Monitor 尚未安全关闭',
        message: safeError(error),
        detail: ownedProcessCloseFailed
          ? '软件只会重试关闭由 Tibo Monitor 自己启动的隐藏 Firefox，不会终止你的普通 Firefox。请选择重试，或暂不退出并稍后再试。'
          : '部分后台工作尚未安全结束。请选择重试，或暂不退出。',
        buttons: ['重试安全退出', '暂不退出'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      };
      const result = mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      if (result.response === 0) continue;
      monitor?.cancelClose();
      isQuitting = false;
      quitCleanupInProgress = false;
      showWindow();
      return;
    }
  }
}

function interceptQuitUntilMonitorCloses(event) {
  isQuitting = true;
  if (!monitor || quitCleanupComplete) return;
  event.preventDefault();
  void prepareMonitorForQuit();
}

app.on('second-instance', showWindow);
app.whenReady().then(bootstrap).catch((error) => {
  if (diagnosticSmoke) {
    try { writeStartupDiagnostic({ ok: false, error: safeError(error) }); }
    catch { /* The regular error path below remains available. */ }
  }
  dialog.showErrorBox('Tibo Monitor 启动失败', safeError(error));
  app.quit();
});
app.on('before-quit', interceptQuitUntilMonitorCloses);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});
app.on('will-quit', interceptQuitUntilMonitorCloses);
