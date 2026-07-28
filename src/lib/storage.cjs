'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_SETTINGS, DEFAULT_STATE } = require('./defaults.cjs');
const { deepMerge, redact, sanitizeSettings } = require('./utils.cjs');

class Storage {
  constructor({ documentsPath, safeStorage }) {
    this.safeStorage = safeStorage;
    this.root = path.join(documentsPath, 'Tibo Monitor');
    this.paths = {
      settings: path.join(this.root, 'settings.json'),
      state: path.join(this.root, 'state.json'),
      secrets: path.join(this.root, 'secrets.dat'),
      logs: path.join(this.root, 'logs'),
      browserProfile: path.join(this.root, 'browser-profile'),
      exports: path.join(this.root, 'exports'),
    };
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.state = structuredClone(DEFAULT_STATE);
    this.secrets = {};
    this.secretsWarning = null;
  }

  init() {
    for (const dir of [this.root, this.paths.logs, this.paths.exports]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.settings = sanitizeSettings(this.readJson(this.paths.settings, DEFAULT_SETTINGS), DEFAULT_SETTINGS);
    this.state = deepMerge(DEFAULT_STATE, this.readJson(this.paths.state, DEFAULT_STATE));
    this.secrets = this.readSecrets();
    if (this.secretsWarning) this.log('warn', this.secretsWarning);
    this.saveSettings(this.settings);
    this.saveState(this.state);
    this.pruneLogs();
    return this;
  }

  readJson(filePath, fallback) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return structuredClone(fallback);
    }
  }

  atomicWrite(filePath, data) {
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, data, { encoding: 'utf8' });
    fs.renameSync(tempPath, filePath);
  }

  saveSettings(nextSettings) {
    this.settings = sanitizeSettings(nextSettings, DEFAULT_SETTINGS);
    this.atomicWrite(this.paths.settings, `${JSON.stringify(this.settings, null, 2)}\n`);
    return this.settings;
  }

  saveState(nextState = this.state) {
    this.state = nextState;
    this.state.seenIds = [...new Set(this.state.seenIds.map(String))].slice(0, 500);
    this.state.posts = this.state.posts.slice(0, 500);
    this.state.events = this.state.events.slice(0, 300);
    this.state.notifications = this.state.notifications.slice(0, 300);
    this.state.pollRuns = this.state.pollRuns.slice(0, 200);
    this.atomicWrite(this.paths.state, `${JSON.stringify(this.state, null, 2)}\n`);
    return this.state;
  }

  readSecrets() {
    if (!fs.existsSync(this.paths.secrets)) return {};
    if (!this.safeStorage.isEncryptionAvailable()) {
      this.secretsWarning = 'Windows 安全存储暂不可用。本次启动不会加载 API Key 或 SMTP 授权码。';
      return {};
    }
    try {
      const encoded = fs.readFileSync(this.paths.secrets, 'utf8').trim();
      if (!encoded) return {};
      const plain = this.safeStorage.decryptString(Buffer.from(encoded, 'base64'));
      return JSON.parse(plain);
    } catch (error) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(this.root, `secrets.unreadable.${stamp}.dat`);
      let backupMessage = '';
      try {
        fs.renameSync(this.paths.secrets, backupPath);
        backupMessage = `旧文件已保留为 ${path.basename(backupPath)}。`;
      } catch (backupError) {
        backupMessage = `旧文件备份失败：${redact(backupError.message)}`;
      }
      this.secretsWarning = `原加密密钥文件无法解密，已忽略其中的密钥。${backupMessage}`;
      return {};
    }
  }

  saveSecrets(patch = {}, clear = []) {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('Windows 安全存储暂不可用，无法保存密钥。');
    }
    for (const key of clear) delete this.secrets[key];
    for (const [key, value] of Object.entries(patch)) {
      if (typeof value === 'string' && value.length > 0) this.secrets[key] = value;
    }
    const encrypted = this.safeStorage.encryptString(JSON.stringify(this.secrets));
    this.atomicWrite(this.paths.secrets, encrypted.toString('base64'));
    this.secretsWarning = null;
    return this.secretPresence();
  }

  secretPresence() {
    return {
      hasDeepSeekKey: Boolean(this.secrets.deepseekApiKey),
      hasSmtpPassword: Boolean(this.secrets.smtpPassword),
      warning: this.secretsWarning,
    };
  }

  getPublicSnapshot() {
    return {
      settings: structuredClone(this.settings),
      state: structuredClone(this.state),
      secrets: this.secretPresence(),
      dataPath: this.root,
    };
  }

  log(level, message, metadata = null) {
    const day = new Date().toISOString().slice(0, 10);
    const line = JSON.stringify({
      at: new Date().toISOString(),
      level,
      message: redact(message),
      ...(metadata ? { metadata: JSON.parse(JSON.stringify(metadata, (_, value) => typeof value === 'string' ? redact(value) : value)) } : {}),
    });
    fs.appendFileSync(path.join(this.paths.logs, `${day}.log`), `${line}\n`, 'utf8');
  }

  pruneLogs() {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(this.paths.logs)) {
      const filePath = path.join(this.paths.logs, name);
      try {
        if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
      } catch {
        // A locked log can be retried on the next launch.
      }
    }
  }
}

module.exports = { Storage };
