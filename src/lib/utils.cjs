'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function backupLegacyJsonFile(filePath, targetSchemaVersion = 2) {
  if (!fs.existsSync(filePath)) return null;
  const contents = fs.readFileSync(filePath, 'utf8');
  let versionLabel = 'unreadable';
  try {
    const parsed = JSON.parse(contents);
    const schemaVersion = Number(parsed?.schemaVersion || 0);
    if (schemaVersion >= targetSchemaVersion) return null;
    versionLabel = schemaVersion > 0 ? `v${schemaVersion}` : 'legacy';
  } catch {
    // Preserve malformed legacy data before Storage replaces it with defaults.
  }

  const extension = path.extname(filePath) || '.json';
  const baseName = path.basename(filePath, extension);
  const backupPath = path.join(path.dirname(filePath), `${baseName}.${versionLabel}.backup${extension}`);
  if (fs.existsSync(backupPath)) return backupPath;
  const temporaryPath = `${backupPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(temporaryPath, backupPath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); }
    catch { /* The temporary backup may already have been moved. */ }
    if (fs.existsSync(backupPath)) return backupPath;
    throw error;
  }
  return backupPath;
}

function deepMerge(base, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return structuredClone(base);
  }
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(incoming)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      output[key] &&
      typeof output[key] === 'object' &&
      !Array.isArray(output[key])
    ) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

function normalizeHandle(handle) {
  return String(handle || '').trim().replace(/^@+/, '').replace(/[^a-zA-Z0-9_]/g, '');
}

function parseRecipients(value) {
  const raw = Array.isArray(value) ? value : [value];
  const output = [];
  const seen = new Set();
  for (const group of raw) {
    for (const item of String(group || '').split(/[;,\n]/)) {
      const address = item.trim();
      const key = address.toLowerCase();
      if (!address || seen.has(key)) continue;
      seen.add(key);
      output.push(address);
    }
  }
  return output;
}

function sanitizeSettings(candidate, defaults) {
  const incomingSchemaVersion = Number(candidate?.schemaVersion || 0);
  const merged = deepMerge(defaults, candidate);
  merged.schemaVersion = defaults.schemaVersion;
  merged.x.handle = normalizeHandle(merged.x.handle) || defaults.x.handle;
  const legacyBrowser = String(candidate?.x?.browser || 'firefox').toLowerCase();
  const legacyFirefoxExecutable = legacyBrowser === 'firefox' ? candidate?.x?.browserExecutablePath : '';
  const legacyFirefoxProfile = legacyBrowser === 'firefox' ? candidate?.x?.browserProfilePath : '';
  merged.x.firefoxExecutablePath = String(
    candidate?.x?.firefoxExecutablePath || legacyFirefoxExecutable || '',
  ).trim().slice(0, 1000);
  merged.x.firefoxProfilePath = String(
    candidate?.x?.firefoxProfilePath || legacyFirefoxProfile || '',
  ).trim().slice(0, 2000);
  delete merged.x.browser;
  delete merged.x.browserExecutablePath;
  delete merged.x.browserProfilePath;
  delete merged.x.firefoxProfileMode;
  const requestedPollInterval = incomingSchemaVersion < 4 && Number(candidate?.x?.pollIntervalMinutes) === 5
    ? defaults.x.pollIntervalMinutes
    : merged.x.pollIntervalMinutes;
  merged.x.pollIntervalMinutes = clamp(requestedPollInterval, 5, 30);
  merged.x.fetchLimit = Math.round(clamp(merged.x.fetchLimit, 5, 100));
  merged.x.includeReplies = Boolean(merged.x.includeReplies);
  const replayHours = new Set([0, 1, 3, 6, 12, 24, 72]);
  const startupReplayHours = Math.round(Number(merged.x.startupReplayHours));
  const manualReplayHours = Math.round(Number(merged.x.manualReplayHours));
  merged.x.startupReplayHours = replayHours.has(startupReplayHours) ? startupReplayHours : 0;
  merged.x.manualReplayHours = replayHours.has(manualReplayHours) && manualReplayHours > 0
    ? manualReplayHours
    : defaults.x.manualReplayHours;
  // Reposts are likewise fixed off. Keeping a persisted toggle would widen
  // the timeline without a compatible author/activity watermark.
  delete merged.x.includeRetweets;

  merged.ai.baseUrl = String(merged.ai.baseUrl || defaults.ai.baseUrl).trim().replace(/\/+$/, '');
  merged.ai.model = String(merged.ai.model || defaults.ai.model).trim();
  merged.ai.promptVersion = incomingSchemaVersion < 2
    ? defaults.ai.promptVersion
    : String(merged.ai.promptVersion || defaults.ai.promptVersion).trim();
  merged.ai.thinkingEnabled = Boolean(merged.ai.thinkingEnabled);
  merged.ai.announcedThreshold = clamp(merged.ai.announcedThreshold, 0.5, 1);
  merged.ai.completedThreshold = clamp(merged.ai.completedThreshold, 0.5, 1);
  merged.ai.timeoutSeconds = Math.round(clamp(merged.ai.timeoutSeconds, 10, 120));

  merged.mail.host = String(merged.mail.host || defaults.mail.host).trim();
  merged.mail.port = Math.round(clamp(merged.mail.port, 1, 65535));
  merged.mail.secure = Boolean(merged.mail.secure);
  merged.mail.enabled = Boolean(merged.mail.enabled);
  merged.mail.username = String(merged.mail.username || '').trim();
  merged.mail.from = String(merged.mail.from || '').trim();
  merged.mail.recipients = parseRecipients(merged.mail.recipients).slice(0, 50);
  merged.windowsNotification.enabled = Boolean(merged.windowsNotification.enabled);

  merged.app.monitoringEnabled = Boolean(merged.app.monitoringEnabled);
  merged.app.closeToTray = Boolean(merged.app.closeToTray);
  merged.app.startMinimized = Boolean(merged.app.startMinimized);
  merged.app.acceptedXActionsRisk = Boolean(merged.app.acceptedXActionsRisk);
  return merged;
}

function redact(value) {
  let text = value instanceof Error ? `${value.name}: ${value.message}` : String(value ?? '');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  text = text.replace(/(?:sk-|ds-)[A-Za-z0-9_-]{12,}/g, '[REDACTED_KEY]');
  text = text.replace(/auth_token=[^;\s]+/gi, 'auth_token=[REDACTED]');
  return text.slice(0, 2000);
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function id(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeError(error, fallback = '操作失败') {
  const message = redact(error?.message || error || fallback);
  return message || fallback;
}

function sortTweetIdsAscending(posts) {
  return [...posts].sort((a, b) => {
    const byId = compareTweetIds(a?.id, b?.id);
    return byId || String(a?.timestamp || '').localeCompare(String(b?.timestamp || ''));
  });
}

function compareTweetIds(leftValue, rightValue) {
  const left = String(leftValue ?? '').trim();
  const right = String(rightValue ?? '').trim();
  if (left === right) return 0;
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : 1;
  }
  return left.localeCompare(right);
}

function maxTweetId(postsOrIds) {
  let maximum = null;
  for (const value of postsOrIds || []) {
    const candidate = typeof value === 'object' && value !== null ? value.id : value;
    const normalized = String(candidate ?? '').trim();
    if (!normalized) continue;
    if (maximum === null || compareTweetIds(normalized, maximum) > 0) maximum = normalized;
  }
  return maximum;
}

function sortTweetIdsDescending(posts) {
  return sortTweetIdsAscending(posts).reverse();
}

module.exports = {
  backupLegacyJsonFile,
  clamp,
  compareTweetIds,
  deepMerge,
  escapeHtml,
  hashText,
  id,
  maxTweetId,
  normalizeHandle,
  parseRecipients,
  redact,
  safeError,
  sanitizeSettings,
  sortTweetIdsAscending,
  sortTweetIdsDescending,
};
