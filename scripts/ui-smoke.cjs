'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { DEFAULT_SETTINGS, DEFAULT_STATE } = require('../src/lib/defaults.cjs');

const ROOT = path.resolve(__dirname, '..');

app.whenReady().then(async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.app.monitoringEnabled = true;
  settings.app.acceptedXActionsRisk = true;
  settings.x.pollIntervalMinutes = 60;
  settings.mail = {
    ...settings.mail,
    enabled: true,
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    username: '95•••••••@qq.com',
    recipients: ['first@example.com'],
  };
  const state = structuredClone(DEFAULT_STATE);
  state.aiConnection = {
    status: 'connected',
    checkedAt: '2026-07-28T18:00:00.000Z',
    message: 'DeepSeek 连接正常，模型 deepseek-v4-flash 已完成分类测试。',
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    detected: 'reset_announced',
    confidence: 0.99,
  };
  state.mailConnection = {
    status: 'connected',
    checkedAt: '2026-07-28T18:01:00.000Z',
    message: 'QQ SMTP 连接正常，测试邮件已被 1 位收件人服务器接受。',
    host: 'smtp.qq.com',
    port: 465,
    accepted: 1,
  };
  state.baselineEstablished = true;
  state.seenIds = ['2079000000000000000'];
  state.posts = [{
    post: { id: 'legacy_reply', text: '旧版回复误抓记录', timestamp: '2026-07-19T08:00:00.000Z', url: 'https://x.com/thsottiaux/status/legacy_reply' },
    ignored: true,
    excludedReason: 'reply',
    analysisStatus: 'complete',
  }];
  state.events = [
    {
      id: 'evt_valid_v2',
      postId: 'valid_post',
      type: 'reset_completed',
      confidence: 0.98,
      summary: 'v2 验证通过的历史信号',
      validity: 'valid',
      notificationStatus: 'superseded',
      supersededAt: '2026-07-28T15:27:45.932Z',
      supersededReason: 'classifier_v2_migration',
      createdAt: '2026-07-21T08:00:00.000Z',
    },
    {
      id: 'evt_valid_announced',
      postId: 'announced_post',
      type: 'reset_announced',
      confidence: 0.85,
      summary: 'v2 验证通过的重置预告',
      validity: 'valid',
      notificationStatus: 'sent',
      createdAt: '2026-07-22T08:00:00.000Z',
    },
    {
      id: 'evt_superseded',
      postId: 'legacy_post',
      type: 'reset_announced',
      confidence: 0.91,
      summary: '旧版分类器产生的历史误判',
      validity: 'superseded',
      notificationStatus: 'superseded',
      createdAt: '2026-07-20T08:00:00.000Z',
    },
  ];
  state.legacyAudit = {
    ignoredPostIds: ['legacy_reply'],
    supersededEventIds: ['evt_superseded'],
    discardedNotificationIds: ['mail_superseded'],
  };
  const snapshot = {
    settings,
    state,
    secrets: { hasDeepSeekKey: true, hasSmtpPassword: true },
    dataPath: 'C:\\Users\\Demo\\Documents\\Tibo Monitor',
    runtime: {
      phase: 'running',
      busy: false,
      lastCheckAt: new Date().toISOString(),
      nextCheckAt: new Date(Date.now() + 3 * 60 * 1000).toISOString(),
      lastMessage: '检查完成，没有新动态。',
      lastError: null,
      fetchedCount: 30,
      newCount: 0,
      freshCount: 0,
      newEventCount: 0,
      retriedCount: 2,
      sentCount: 2,
    },
  };
  ipcMain.handle('app:get-state', () => snapshot);
  ipcMain.handle('settings:save', (_event, payload) => {
    snapshot.settings = structuredClone(payload.settings);
    return { ok: true, snapshot };
  });
  for (const channel of ['monitor:toggle', 'app:open-data', 'app:create-shortcut-and-confirm', 'app:open-external']) {
    ipcMain.handle(channel, () => ({ ok: true, snapshot }));
  }
  let monitorCheckCalls = 0;
  ipcMain.handle('monitor:check', () => {
    monitorCheckCalls += 1;
    snapshot.runtime.lastCheckAt = new Date().toISOString();
    if (monitorCheckCalls === 2) {
      Object.assign(snapshot.runtime, {
        lastMessage: '本次检查失败，已保留原水位线。',
        lastError: '模拟 fetch 失败。',
        freshCount: 0,
        newEventCount: 0,
        retriedCount: 3,
        sentCount: 2,
      });
      return { ok: false, message: '模拟 fetch 失败。', freshCount: 0, newEventCount: 0, retriedCount: 0, sentCount: 0 };
    }
    if (monitorCheckCalls === 3) {
      Object.assign(snapshot.runtime, {
        lastMessage: 'Firefox 正在使用所选 profile，本轮已跳过；水位线与通知状态保持不变。',
        lastError: null,
        freshCount: 0,
        newEventCount: 0,
        retriedCount: 4,
        sentCount: 1,
      });
      return { ok: false, skipped: true, code: 'X_FIREFOX_PROFILE_IN_USE', message: '所选 Firefox profile 正在被普通 Firefox 使用。', freshCount: 0, newEventCount: 0, retriedCount: 0, sentCount: 0 };
    }
    Object.assign(snapshot.runtime, {
      lastMessage: '检查完成，没有新动态；补发 2 封历史提醒。',
      lastError: null,
      freshCount: 0,
      newEventCount: 0,
      retriedCount: 2,
      sentCount: 2,
    });
    return {
      ok: true,
      message: snapshot.runtime.lastMessage,
      fetched: 30,
      fresh: 0,
      freshCount: 0,
      newEventCount: 0,
      retriedCount: 2,
      sentCount: 2,
    };
  });
  const recommendedFirefoxPath = 'C:\\Users\\Demo\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles\\m8u30j1c.default-release';
  ipcMain.handle('x:list-firefox-profiles', async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    const base = 'C:\\Users\\Demo\\AppData\\Roaming\\Mozilla\\Firefox\\Profiles';
    const recommendedPath = recommendedFirefoxPath;
    return {
      ok: true,
      profiles: [
        { name: 'default-release', path: recommendedPath, isInstallDefault: true, isDefault: true },
        { name: 'work', path: `${base}\\5kk2work.profile`, isInstallDefault: false, isDefault: false },
      ],
      recommendedPath,
      recommendedName: 'default-release',
      reason: 'install-default',
    };
  });
  ipcMain.handle('x:login', () => ({ ok: true, browser: 'Mozilla Firefox', message: '已打开所选日常浏览器资料。' }));
  ipcMain.handle('x:choose-firefox-executable', () => ({ ok: true, path: 'D:\\Software\\Firefox\\firefox.exe', label: 'Mozilla Firefox' }));
  let xTestCalls = 0;
  ipcMain.handle('x:test', async () => {
    xTestCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (xTestCalls === 3) return { ok: false, code: 'X_FIREFOX_PROFILE_IN_USE', message: '所选 Firefox profile 正在被普通 Firefox 使用。' };
    if (xTestCalls === 4) return { ok: false, code: 'X_FIREFOX_PROFILE_NOT_FOUND', message: '保存的 Firefox profile 不存在。' };
    if (xTestCalls === 5) return { ok: false, code: 'X_FIREFOX_PROFILE_AMBIGUOUS', message: '检测到多个 Firefox profile，无法确定默认项。' };
    snapshot.settings.x.firefoxProfilePath = recommendedFirefoxPath;
    return { ok: true, handle: '@thsottiaux', browser: 'Mozilla Firefox', profile: { name: 'default-release', path: recommendedFirefoxPath }, count: 5, newestAt: new Date().toISOString(), message: '登录有效，已自动找到可用 Firefox 资料并读取 5 条最近动态。' };
  });
  let aiTestCalls = 0;
  ipcMain.handle('ai:test', async () => {
    aiTestCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (aiTestCalls === 2) return { ok: false, message: '模拟 DeepSeek 连接失败。' };
    return { ok: true, model: 'deepseek-v4-flash', detected: 'reset_announced', confidence: 0.95 };
  });
  ipcMain.handle('mail:test', () => ({ ok: true, accepted: 1, messageId: 'test-only' }));

  const window = new BrowserWindow({
    width: 1220,
    height: 800,
    show: false,
    backgroundColor: '#061523',
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  await window.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await new Promise((resolve) => setTimeout(resolve, 700));
  const outputDir = path.join(ROOT, 'artifacts');
  fs.mkdirSync(outputDir, { recursive: true });
  const output = path.join(outputDir, 'ui-smoke.png');
  fs.writeFileSync(output, (await window.capturePage()).toPNG());
  window.showInactive();
  await window.webContents.executeJavaScript(`
    document.querySelectorAll('.page').forEach((node) => node.classList.toggle('active', node.id === 'page-settings'));
    document.querySelectorAll('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.page === 'settings'));
    document.querySelector('#page-eyebrow').textContent = 'LOCAL CONFIGURATION';
    document.querySelector('#page-title').textContent = '设置';
    document.querySelector('.main').scrollTop = 0;
  `);
  const legacyInteraction = false ? await window.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const profileSelect = document.querySelector('#firefox-profile');
    const filtersRemoved = !document.querySelector('#include-replies')
      && !document.querySelector('#include-retweets')
      && !document.querySelector('#settings-form').textContent.includes('包含回复')
      && !document.querySelector('#settings-form').textContent.includes('包含纯转推')
      && document.querySelector('.reply-policy-note').textContent.includes('回复与纯转推始终排除')
      && document.querySelector('.reply-policy-note').textContent.includes('每轮只分析最近30分钟原创帖');
    const legacyPollIntervalClamped = document.querySelector('#poll-interval').value === '30'
      && document.querySelector('#poll-interval').min === '1'
      && document.querySelector('#poll-interval').max === '30'
      && document.querySelector('#metric-interval').textContent.includes('30 分钟');
    const initialPollRetryCopy = document.querySelector('#poll-result-message').textContent === '无新帖，补发 2 封历史提醒；新信号 0 条，历史重试 2 封。'
      && document.querySelector('#poll-fresh-count').textContent === '0'
      && document.querySelector('#poll-event-count').textContent === '0'
      && document.querySelector('#poll-retried-count').textContent === '2'
      && document.querySelector('#poll-sent-count').textContent === '2';
    const validMigrationVisible = document.querySelectorAll('.alert-item').length === 2
      && [...document.querySelectorAll('.alert-item')].some((item) => item.textContent.includes('v2 验证通过的历史信号') && item.textContent.includes('旧版邮件已停止重试'))
      && [...document.querySelectorAll('.alert-item')].some((item) => item.textContent.includes('v2 验证通过的重置预告') && item.textContent.includes('邮件已发送'))
      && !document.querySelector('#alerts-list').textContent.includes('旧版分类器产生的历史误判')
      && document.querySelector('#alert-count').textContent === '2 条有效'
      && !document.querySelector('#alerts-audit-summary').hidden
      && document.querySelector('#alerts-audit-summary').textContent.includes('已隐藏 1 条旧版误判')
      && document.querySelector('#alerts-audit-summary').textContent.includes('不会重发');
    const excludedPostHidden = !document.querySelector('.feed-item')
      && !document.querySelector('#activity-audit-summary').hidden
      && document.querySelector('#activity-audit-summary').textContent.includes('已隐藏 1 条')
      && document.querySelector('#metric-posts').textContent === '0';
    const profileLabel = profileSelect.selectedOptions[0]?.textContent || '';
    const profilesLoaded = profileSelect.options.length === 2 && profileSelect.value.endsWith('m8u30j1c.default-release');
    const profileCopy = profileLabel.includes('default-release（默认）') && profileLabel.includes('m8u30j1c.default-release');
    const existingDefault = document.querySelector('#firefox-profile-mode-existing').checked
      && !document.querySelector('#firefox-existing-panel').hidden
      && document.querySelector('#isolated-login-details').hidden;
    const xCardRect = document.querySelector('#x-settings-card').getBoundingClientRect();
    const aiCardRect = document.querySelector('#ai-url').closest('.settings-card').getBoundingClientRect();
    const settingsColumnsAligned = Math.abs(xCardRect.top - aiCardRect.top) < 2 && aiCardRect.left > xCardRect.right && aiCardRect.height > 200;
    document.querySelector('#refresh-firefox-profiles').click();
    await wait(30);
    const profileRefreshLocksAll = document.querySelector('#refresh-firefox-profiles').disabled
      && document.querySelector('#firefox-profile').disabled
      && document.querySelector('#firefox-profile-mode-existing').disabled
      && document.querySelector('#firefox-profile-mode-isolated').disabled
      && document.querySelector('#test-x').disabled
      && document.querySelector('#quick-test-x').disabled
      && document.querySelector('#check-now').disabled
      && document.querySelector('#activity-refresh').disabled;
    await wait(130);
    const refreshed = profileSelect.options.length === 2 && profileSelect.value.endsWith('m8u30j1c.default-release');

    document.querySelector('#firefox-profile-mode-isolated').click();
    await wait(30);
    const isolatedVisible = document.querySelector('#firefox-existing-panel').hidden
      && !document.querySelector('#isolated-login-details').hidden
      && document.querySelector('#isolated-login-details').open
      && document.querySelector('#firefox-existing-actions').hidden;
    const savedBeforeUnsavedTest = await window.tibo.getState();
    document.querySelector('#quick-test-x').click();
    await wait(80);
    const unsavedModeUsesSavedSettings = savedBeforeUnsavedTest.settings.x.firefoxProfileMode === 'existing'
      && document.querySelector('#x-test-status').dataset.state === 'loading'
      && document.querySelector('#x-test-status-title').textContent === '正在测试 Firefox 登录'
      && document.querySelector('#x-test-status-message').textContent.includes('普通 Firefox');
    await wait(500);
    const firefoxOption = [...document.querySelector('#x-browser').options].some((item) => item.value === 'firefox');
    document.querySelector('#choose-x-browser-executable').click();
    await wait(80);
    const chosen = document.querySelector('#x-browser-executable').value.endsWith('firefox.exe') && document.querySelector('#x-browser').value === 'firefox';
    const clearReady = !document.querySelector('#clear-x-browser-executable').disabled;
    document.querySelector('#clear-x-browser-executable').click();
    const cleared = document.querySelector('#x-browser-executable').value === '' && document.querySelector('#x-browser').value === 'auto' && document.querySelector('#clear-x-browser-executable').disabled;
    const isolatedStatusBeforeRefresh = [document.querySelector('#x-test-status').dataset.state, document.querySelector('#x-test-status-title').textContent, document.querySelector('#x-test-status-message').textContent].join('|');
    await loadFirefoxProfiles({ announce: true });
    const isolatedProfileRefreshPreservesStatus = [document.querySelector('#x-test-status').dataset.state, document.querySelector('#x-test-status-title').textContent, document.querySelector('#x-test-status-message').textContent].join('|') === isolatedStatusBeforeRefresh
      && profileSelect.options.length === 1
      && profileSelect.value === '';

    document.querySelector('#firefox-profile-mode-existing').click();
    await wait(160);
    const existingRestored = !document.querySelector('#firefox-existing-panel').hidden
      && document.querySelector('#isolated-login-details').hidden
      && !document.querySelector('#firefox-existing-actions').hidden
      && profileSelect.value.endsWith('m8u30j1c.default-release');
    document.querySelector('#poll-interval').value = '60';
    document.querySelector('#test-x').click();
    await wait(80);
    const loading = document.querySelector('#x-test-status').dataset.state === 'loading' && document.querySelector('#overview-x-test-status').dataset.state === 'loading';
    const locked = document.querySelector('#open-x-login').disabled
      && document.querySelector('#quick-test-x').disabled
      && document.querySelector('#refresh-firefox-profiles').disabled
      && document.querySelector('#firefox-profile-mode-existing').disabled;
    await wait(500);
    const success = document.querySelector('#x-test-status').dataset.state === 'success' && document.querySelector('#overview-x-test-status').dataset.state === 'success';
    const detail = document.querySelector('#x-test-status-message').textContent;
    const overviewDetail = document.querySelector('#overview-x-test-status-message').textContent;
    const saved = await window.tibo.getState();
    const forcedFirefox = saved.settings.x.firefoxProfileMode === 'existing'
      && saved.settings.x.browser === 'firefox'
      && saved.settings.x.firefoxProfilePath.endsWith('m8u30j1c.default-release')
      && !Object.hasOwn(saved.settings.x, 'includeReplies')
      && !Object.hasOwn(saved.settings.x, 'includeRetweets');
    const pollIntervalClampedOnSave = saved.settings.x.pollIntervalMinutes === 30
      && document.querySelector('#poll-interval').value === '30';

    document.querySelector('#quick-test-x').click();
    await wait(450);
    const profileInUse = document.querySelector('#x-test-status').dataset.state === 'waiting'
      && document.querySelector('#overview-x-test-status').dataset.state === 'waiting'
      && document.querySelector('#x-test-status-title').textContent === '请先关闭普通 Firefox'
      && !document.querySelector('#x-test-status-title').textContent.includes('验证失败');

    document.querySelector('#quick-test-x').click();
    await wait(450);
    const profileNotFound = document.querySelector('#x-test-status').dataset.state === 'error'
      && document.querySelector('#overview-x-test-status').dataset.state === 'error'
      && document.querySelector('#x-test-status-title').textContent === '未找到 Firefox 登录资料';

    document.querySelector('#quick-test-x').click();
    await wait(450);
    const profileAmbiguous = document.querySelector('#x-test-status').dataset.state === 'waiting'
      && document.querySelector('#overview-x-test-status').dataset.state === 'waiting'
      && document.querySelector('#x-test-status-title').textContent === '需要选择 Firefox 登录资料';

    document.querySelector('#quick-test-x').click();
    await wait(450);
    const xRecovered = document.querySelector('#x-test-status').dataset.state === 'success' && document.querySelector('#overview-x-test-status').dataset.state === 'success';
    document.querySelector('#check-now').click();
    await wait(60);
    const pollRetryResult = document.querySelector('#poll-result-message').textContent === '无新帖，补发 2 封历史提醒；新信号 0 条，历史重试 2 封。'
      && document.querySelector('#x-test-status-message').textContent.includes('补发 2 封历史提醒')
      && !document.querySelector('#x-test-status-message').textContent.includes('新提醒');

    document.querySelector('#check-now').click();
    await wait(80);
    const failedPollUsesRuntimeCounts = document.querySelector('#poll-fresh-count').textContent === '0'
      && document.querySelector('#poll-event-count').textContent === '0'
      && document.querySelector('#poll-retried-count').textContent === '3'
      && document.querySelector('#poll-sent-count').textContent === '2'
      && document.querySelector('#poll-result-message').textContent.includes('历史重试 3 封');

    document.querySelector('#check-now').click();
    await wait(80);
    const busyPollUsesRuntimeCounts = document.querySelector('#x-test-status').dataset.state === 'waiting'
      && document.querySelector('#x-test-status-title').textContent === '请先关闭普通 Firefox'
      && document.querySelector('#poll-fresh-count').textContent === '0'
      && document.querySelector('#poll-event-count').textContent === '0'
      && document.querySelector('#poll-retried-count').textContent === '4'
      && document.querySelector('#poll-sent-count').textContent === '1';

    const timerFailureSnapshot = structuredClone(await window.tibo.getState());
    Object.assign(timerFailureSnapshot.runtime, {
      lastCheckAt: new Date().toISOString(),
      lastMessage: '定时检查失败，已保留原水位线。',
      lastError: '模拟定时 fetch 失败。',
      freshCount: 0,
      newEventCount: 0,
      retriedCount: 5,
      sentCount: 0,
    });
    render(timerFailureSnapshot, { fillSettings: false });
    const timedFailureUsesRuntimeCounts = document.querySelector('#poll-fresh-count').textContent === '0'
      && document.querySelector('#poll-event-count').textContent === '0'
      && document.querySelector('#poll-retried-count').textContent === '5'
      && document.querySelector('#poll-sent-count').textContent === '0';

    document.querySelector('#quick-test-ai').click();
    await wait(60);
    const aiLoading = document.querySelector('#ai-test-status').dataset.state === 'loading' && document.querySelector('#overview-ai-test-status').dataset.state === 'loading';
    await wait(220);
    const aiSuccess = document.querySelector('#ai-test-status').dataset.state === 'success' && document.querySelector('#overview-ai-test-status').dataset.state === 'success';
    document.querySelector('#quick-test-ai').click();
    await wait(240);
    const aiError = document.querySelector('#ai-test-status').dataset.state === 'error' && document.querySelector('#overview-ai-test-status').dataset.state === 'error';
    document.querySelector('#quick-test-ai').click();
    await wait(240);
    const aiRecovered = document.querySelector('#ai-test-status').dataset.state === 'success' && document.querySelector('#overview-ai-test-status').dataset.state === 'success';

    return { filtersRemoved, legacyPollIntervalClamped, initialPollRetryCopy, validMigrationVisible, excludedPostHidden, profilesLoaded, profileCopy, existingDefault, settingsColumnsAligned, layoutRects: { x: [xCardRect.left, xCardRect.top, xCardRect.right, xCardRect.height], ai: [aiCardRect.left, aiCardRect.top, aiCardRect.right, aiCardRect.height] }, profileRefreshLocksAll, refreshed, isolatedVisible, unsavedModeUsesSavedSettings, firefoxOption, chosen, clearReady, cleared, isolatedProfileRefreshPreservesStatus, existingRestored, loading, locked, success, detail, overviewDetail, forcedFirefox, pollIntervalClampedOnSave, profileInUse, profileNotFound, profileAmbiguous, xRecovered, pollRetryResult, failedPollUsesRuntimeCounts, busyPollUsesRuntimeCounts, timedFailureUsesRuntimeCounts, aiLoading, aiSuccess, aiError, aiRecovered };
  })()`) : {};
  void legacyInteraction;
  const interaction = await window.webContents.executeJavaScript(`(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const firefoxOnly = !document.querySelector('#x-browser')
      && !document.querySelector('#browser-profile')
      && !document.querySelector('[name="firefox-profile-mode"]')
      && !document.querySelector('#isolated-login-details')
      && !document.querySelector('#isolated-open-x-login')
      && !document.querySelector('#isolated-test-x')
      && !document.querySelector('#x-settings-card').textContent.includes('Google Chrome')
      && !document.querySelector('#x-settings-card').textContent.includes('Microsoft Edge')
      && document.querySelector('#x-settings-card').textContent.includes('无需手动选择');
    const profilesLoaded = document.querySelector('#browser-profile-hint').textContent.includes('已检测到 2 个 Firefox 资料');
    const aiRestored = document.querySelector('#ai-test-status').dataset.state === 'success'
      && document.querySelector('#ai-test-status-message').textContent.includes('deepseek-v4-flash');
    const mailRestored = document.querySelector('#mail-test-status').dataset.state === 'success'
      && document.querySelector('#mail-test-status-message').textContent.includes('QQ SMTP 连接正常');
    document.querySelector('#accept-risk').click();
    const riskGuard = !document.querySelector('#risk-required-hint').hidden
      && document.querySelector('#test-x').disabled
      && document.querySelector('#x-test-status-title').textContent.includes('请先勾选');
    document.querySelector('#accept-risk').click();
    document.querySelector('#refresh-firefox-profiles').click();
    await wait(30);
    const profileRefreshLocksAll = document.querySelector('#refresh-firefox-profiles').disabled
      && document.querySelector('#test-x').disabled
      && document.querySelector('#quick-test-x').disabled;
    await wait(140);
    const initialRecipients = [...document.querySelectorAll('.recipient-chip')].map((node) => node.textContent).join('|');
    document.querySelector('#smtp-recipient-input').value = 'second@example.com';
    document.querySelector('#add-smtp-recipient').click();
    document.querySelector('#smtp-recipient-input').value = 'SECOND@example.com';
    document.querySelector('#add-smtp-recipient').click();
    const recipientsAdded = document.querySelectorAll('.recipient-chip').length === 2
      && document.querySelector('#smtp-recipient-list').textContent.includes('second@example.com');
    document.querySelector('.recipient-remove').click();
    const recipientRemoved = document.querySelectorAll('.recipient-chip').length === 1
      && !document.querySelector('#smtp-recipient-list').textContent.includes('first@example.com');
    document.querySelector('#poll-interval').value = '60';
    document.querySelector('#test-x').click();
    await wait(80);
    const loading = document.querySelector('#x-test-status').dataset.state === 'loading'
      && document.querySelector('#overview-x-test-status').dataset.state === 'loading';
    await wait(450);
    const success = document.querySelector('#x-test-status').dataset.state === 'success'
      && document.querySelector('#x-test-status-message').textContent.includes('临时资料快照已删除');
    const saved = await window.tibo.getState();
    const savedDirect = saved.settings.x.firefoxProfilePath.endsWith('m8u30j1c.default-release')
      && !Object.hasOwn(saved.settings.x, 'browser')
      && !Object.hasOwn(saved.settings.x, 'browserExecutablePath')
      && !Object.hasOwn(saved.settings.x, 'browserProfilePath')
      && !Object.hasOwn(saved.settings.x, 'firefoxProfileMode')
      && Object.hasOwn(saved.settings.x, 'firefoxExecutablePath');
    const savedRecipients = Array.isArray(saved.settings.mail.recipients)
      && saved.settings.mail.recipients.length === 1
      && saved.settings.mail.recipients[0] === 'second@example.com';
    const pollIntervalClampedOnSave = saved.settings.x.pollIntervalMinutes === 30;
    const filtersRemoved = !document.querySelector('#include-replies') && !document.querySelector('#include-retweets');
    const riskPromptVisible = document.querySelector('#risk-required-hint').hidden
      && document.querySelector('.risk-box.prominent').textContent.includes('必须先勾选');
    const saveBar = document.querySelector('.save-bar');
    const saveBarDoesNotOverlay = getComputedStyle(saveBar).position === 'static';
    const xCardRect = document.querySelector('#x-settings-card').getBoundingClientRect();
    const aiCardRect = document.querySelector('#ai-url').closest('.settings-card').getBoundingClientRect();
    const settingsColumnsAligned = Math.abs(xCardRect.top - aiCardRect.top) < 2 && aiCardRect.left > xCardRect.right;
    return { firefoxOnly, profilesLoaded, aiRestored, mailRestored, riskGuard, profileRefreshLocksAll, initialRecipients: initialRecipients.includes('first@example.com'), recipientsAdded, recipientRemoved, loading, success, savedDirect, savedRecipients, pollIntervalClampedOnSave, filtersRemoved, riskPromptVisible, saveBarDoesNotOverlay, settingsColumnsAligned };
  })()`);
  const required = ['firefoxOnly', 'profilesLoaded', 'aiRestored', 'mailRestored', 'riskGuard', 'profileRefreshLocksAll', 'initialRecipients', 'recipientsAdded', 'recipientRemoved', 'loading', 'success', 'savedDirect', 'savedRecipients', 'pollIntervalClampedOnSave', 'filtersRemoved', 'riskPromptVisible', 'saveBarDoesNotOverlay', 'settingsColumnsAligned'];
  if (required.some((key) => !interaction[key])) {
    throw new Error('UI interaction smoke failed: ' + JSON.stringify(interaction));
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  const settingsOutput = path.join(outputDir, 'ui-settings.png');
  fs.writeFileSync(settingsOutput, (await window.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('.recipient-editor')?.scrollIntoView({ block: 'center' })`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const mailSettingsOutput = path.join(outputDir, 'ui-settings-mail.png');
  fs.writeFileSync(mailSettingsOutput, (await window.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`
    document.querySelectorAll('.page').forEach((node) => node.classList.toggle('active', node.id === 'page-alerts'));
    document.querySelectorAll('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.page === 'alerts'));
    document.querySelector('#page-eyebrow').textContent = 'NOTIFICATION HISTORY';
    document.querySelector('#page-title').textContent = '预警历史';
    document.querySelector('.main').scrollTop = 0;
  `);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const alertsOutput = path.join(outputDir, 'ui-alerts.png');
  fs.writeFileSync(alertsOutput, (await window.capturePage()).toPNG());
  window.hide();
  console.log(`${output}\n${settingsOutput}\n${mailSettingsOutput}\n${alertsOutput}`);
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
