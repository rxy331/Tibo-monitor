'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: 4,
  x: {
    handle: 'thsottiaux',
    firefoxExecutablePath: '',
    firefoxProfilePath: '',
    pollIntervalMinutes: 15,
    fetchLimit: 30,
  },
  ai: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    thinkingEnabled: false,
    announcedThreshold: 0.75,
    completedThreshold: 0.8,
    timeoutSeconds: 30,
    promptVersion: 'reset-classifier-v2',
  },
  mail: {
    enabled: false,
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    username: '',
    from: '',
    recipients: [],
    announcedSubject: '[Tibo Monitor] Tibo 可能准备重置 GPT 额度',
    completedSubject: '[Tibo Monitor] GPT 额度可能已重置',
  },
  app: {
    monitoringEnabled: false,
    closeToTray: true,
    startMinimized: false,
    acceptedXActionsRisk: false,
  },
});

const DEFAULT_STATE = Object.freeze({
  schemaVersion: 2,
  classifierVersion: 2,
  baselineEstablished: false,
  baselineCutoffId: null,
  highWaterId: null,
  seenIds: [],
  posts: [],
  events: [],
  notifications: [],
  legacyAudit: null,
  pollRuns: [],
  xConnection: {
    status: 'unverified',
    checkedAt: null,
    openedAt: null,
    message: '尚未验证现有 Firefox 资料的 X 登录。',
    errorCode: null,
    handle: null,
    browser: null,
    count: 0,
    newestAt: null,
  },
  aiConnection: {
    status: 'unverified',
    checkedAt: null,
    message: 'DeepSeek 尚未测试。',
    model: null,
    baseUrl: null,
    detected: null,
    confidence: null,
  },
  mailConnection: {
    status: 'unverified',
    checkedAt: null,
    message: 'QQ SMTP 尚未测试。',
    host: null,
    port: null,
    accepted: 0,
  },
  lifecycle: {
    status: 'idle',
    cycle: 0,
    expectedAt: null,
    completedAt: null,
  },
});

module.exports = { DEFAULT_SETTINGS, DEFAULT_STATE };
