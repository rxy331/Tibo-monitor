'use strict';

const { safeError } = require('./utils.cjs');

const APP_USER_MODEL_ID = 'local.tibo.monitor';
const TOAST_ACTIVATOR_CLSID = '{7D2867DB-2826-4D19-8BB5-A1C05D8B96D1}';

function notificationCopy(event, post, test = false) {
  if (test) {
    return {
      title: 'Tibo Monitor 测试通知',
      body: 'Windows 通知通道工作正常。点击此通知可打开 Tibo Monitor。',
    };
  }
  const title = event.type === 'reset_completed'
    ? 'Tibo：GPT 额度可能已重置'
    : event.type === 'reset_announced'
      ? 'Tibo：可能准备重置 GPT 额度'
      : 'Tibo Monitor 检测到新信号';
  const summary = String(event.summary || event.reason || post?.text || '').trim();
  const confidence = Number.isFinite(Number(event.confidence))
    ? `置信度 ${Math.round(Number(event.confidence) * 100)}%`
    : '';
  return {
    title,
    body: [summary.slice(0, 240), confidence].filter(Boolean).join('\n'),
  };
}

class WindowsNotifier {
  constructor({
    Notification,
    ensureShortcut = async () => {},
    showWindow = () => {},
    icon = null,
    log = () => {},
  }) {
    this.Notification = Notification;
    this.ensureShortcut = ensureShortcut;
    this.showWindow = showWindow;
    this.icon = icon;
    this.log = log;
    this.active = new Set();
  }

  isSupported() {
    return Boolean(this.Notification?.isSupported?.());
  }

  async show(event = {}, post = {}, { test = false } = {}) {
    if (!this.isSupported()) {
      throw Object.assign(new Error('当前 Windows 环境不支持 Electron 系统通知。'), {
        code: 'WINDOWS_NOTIFICATION_UNSUPPORTED',
      });
    }
    await this.ensureShortcut();
    const copy = notificationCopy(event, post, test);
    const notification = new this.Notification({
      title: copy.title,
      body: copy.body,
      silent: false,
      timeoutType: 'default',
      ...(this.icon ? { icon: this.icon } : {}),
    });
    this.active.add(notification);
    notification.once?.('click', () => this.showWindow());
    notification.once?.('close', () => this.active.delete(notification));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          this.active.delete(notification);
          reject(error);
        } else {
          resolve({ ok: true, shown: true, title: copy.title });
        }
      };
      notification.once?.('show', () => finish());
      notification.once?.('failed', (_event, error) => finish(
        Object.assign(new Error(safeError(error, 'Windows 通知显示失败。')), {
          code: 'WINDOWS_NOTIFICATION_FAILED',
        }),
      ));
      const timer = setTimeout(() => finish(), 2500);
      try {
        notification.show();
      } catch (error) {
        this.log('warn', `Windows notification failed: ${safeError(error)}`);
        finish(error);
      }
    });
  }

  test() {
    return this.show({}, {}, { test: true });
  }
}

module.exports = {
  APP_USER_MODEL_ID,
  TOAST_ACTIVATOR_CLSID,
  WindowsNotifier,
  notificationCopy,
};
