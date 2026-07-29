'use strict';

const EventEmitter = require('node:events');
const { DEFAULT_STATE } = require('./defaults.cjs');
const {
  compareTweetIds,
  hashText,
  id,
  maxTweetId,
  normalizeHandle,
  safeError,
  sortTweetIdsAscending,
  sortTweetIdsDescending,
} = require('./utils.cjs');

const X_RISK_NOT_ACCEPTED_MESSAGE = '请先在设置中确认已了解 XActions 网页抓取风险。';
const CLASSIFIER_VERSION = 2;
const RECENT_POST_WINDOW_MS = 30 * 60 * 1000;
const FUTURE_POST_TOLERANCE_MS = 2 * 60 * 1000;
const SAME_TYPE_SUPPRESSION_WINDOW_MS = 60 * 60 * 1000;
const ANALYSIS_RETRY_MINUTES = [1, 5, 15, 60];
const RETRYABLE_NOTIFICATION_STATUSES = new Set(['pending', 'failed', 'error', 'sending']);
const HISTORICAL_NOTIFICATION_STATUSES = new Set([
  ...RETRYABLE_NOTIFICATION_STATUSES,
  'waiting_for_mail_config',
]);

function postAuthorHandle(post) {
  const declared = normalizeHandle(post?.authorHandle || post?.author || post?.username || '');
  if (declared) return declared.toLowerCase();
  try {
    const pathname = new URL(String(post?.url || '')).pathname;
    return normalizeHandle(pathname.match(/^\/([^/]+)\/status\/\d+/)?.[1] || '').toLowerCase();
  } catch {
    return '';
  }
}

function isTargetAuthoredPost(post, handle) {
  const target = normalizeHandle(handle).toLowerCase();
  return Boolean(target) && postAuthorHandle(post) === target && !post?.isRetweet;
}

function normalizeObservedHighWaterId(value) {
  const normalized = String(value ?? '').trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

function normalizeFetchResult(result) {
  if (Array.isArray(result)) {
    return {
      posts: result,
      observedHighWaterId: normalizeObservedHighWaterId(result.observedHighWaterId),
    };
  }
  if (!result || typeof result !== 'object') {
    return { posts: [], observedHighWaterId: null };
  }
  return {
    posts: Array.isArray(result.posts) ? result.posts : [],
    observedHighWaterId: normalizeObservedHighWaterId(result.observedHighWaterId),
  };
}

function isPostWithinMonitoringWindow(post, now = Date.now()) {
  const timestamp = Date.parse(post?.timestamp);
  return Number.isFinite(timestamp) &&
    timestamp >= now - RECENT_POST_WINDOW_MS &&
    timestamp <= now + FUTURE_POST_TOLERANCE_MS;
}

function postIsResetCandidate(post) {
  const text = String(post?.text || '').toLowerCase();
  const hasLimitSubject = /\b(?:usage|limits?|quotas?|credits?)\b|(?:用量限制|使用限制|额度|限额|配额)/i.test(text);
  const hasResetAction = /\b(?:reset(?:s|ted|ting)?|restore(?:d|s|ing)?|replenish(?:ed|es|ing)?|refill(?:ed|s|ing)?|top[ -]?up)\b|(?:重置|恢复|补充|补发)/i.test(text);
  return hasLimitSubject && hasResetAction;
}

function findingHasCurrentEvidence(post, finding) {
  const text = String(post?.text || '').toLocaleLowerCase();
  const evidence = Array.isArray(finding?.evidence)
    ? finding.evidence.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  return evidence.length > 0 && evidence.every((item) => text.includes(item.toLocaleLowerCase()));
}

function isMailAuthError(error) {
  const detail = `${error?.code || ''} ${error?.responseCode || ''} ${error?.message || error || ''}`;
  return /\bEAUTH\b|\b535\b|invalid login|authentication failed|login fail/i.test(detail);
}

function postRecordAscending(left, right) {
  const byId = compareTweetIds(left?.post?.id, right?.post?.id);
  return byId || String(left?.post?.timestamp || '').localeCompare(String(right?.post?.timestamp || ''));
}

function postRecordDescending(left, right) {
  return -postRecordAscending(left, right);
}

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneSettingValue(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function rebaseSettingsSnapshot(current, base, requested) {
  if (isPlainObject(current) && isPlainObject(base) && isPlainObject(requested)) {
    const output = structuredClone(current);
    for (const [key, requestedValue] of Object.entries(requested)) {
      if (!Object.hasOwn(base, key)) {
        output[key] = cloneSettingValue(requestedValue);
        continue;
      }
      output[key] = rebaseSettingsSnapshot(current[key], base[key], requestedValue);
    }
    return output;
  }
  return Object.is(requested, base) ? cloneSettingValue(current) : cloneSettingValue(requested);
}

class MonitorService extends EventEmitter {
  constructor({ storage, source, ai, mailer, now = () => Date.now() }) {
    super();
    this.storage = storage;
    this.source = source;
    this.ai = ai;
    this.mailer = mailer;
    this.now = now;
    this.timer = null;
    this.busy = false;
    this.idleWaiters = [];
    this.closing = false;
    this.closePromise = null;
    this.mailAuthCircuitOpen = false;
    this.status = {
      phase: 'paused',
      busy: false,
      lastCheckAt: null,
      nextCheckAt: null,
      lastMessage: '等待启动监控',
      lastError: null,
      fetchedCount: 0,
      newCount: 0,
      newEventCount: 0,
      retriedCount: 0,
      sentCount: 0,
      outOfWindowCount: 0,
    };
    this.migrateStateV2();
  }

  migrateStateV2() {
    const state = this.storage.state;
    if (Number(state.schemaVersion || 0) >= 2 && Number(state.classifierVersion || 0) >= CLASSIFIER_VERSION) {
      return false;
    }

    const migratedAt = new Date().toISOString();
    const originalPosts = [...(state.posts || [])];
    const originalEvents = [...(state.events || [])];
    const originalNotifications = [...(state.notifications || [])];
    const validEvents = [];
    const supersededEventIds = [];
    for (const event of originalEvents) {
      const record = originalPosts.find((item) => item?.post?.id === event.postId);
      const valid = Boolean(record) &&
        isTargetAuthoredPost(record.post, this.storage.settings.x.handle) &&
        postIsResetCandidate(record.post) &&
        findingHasCurrentEvidence(record.post, event);
      event.validity = valid ? 'valid' : 'superseded';
      event.classifierVersion = Number(event.classifierVersion || 1);
      if (HISTORICAL_NOTIFICATION_STATUSES.has(event.notificationStatus)) {
        event.notificationStatus = 'superseded';
        event.notificationSupersededAt = migratedAt;
        event.notificationSupersededReason = 'classifier_v2_migration';
      }
      if (valid) {
        delete event.supersededAt;
        delete event.supersededReason;
        validEvents.push(event);
      } else {
        event.supersededAt = migratedAt;
        event.supersededReason = 'classifier_v2_invalid_event';
        supersededEventIds.push(event.id);
      }
    }
    for (const notification of originalNotifications) {
      if (HISTORICAL_NOTIFICATION_STATUSES.has(notification.status)) {
        notification.status = 'superseded';
        notification.nextAttemptAt = null;
        notification.supersededAt = migratedAt;
        notification.supersededReason = 'classifier_v2_migration';
      }
    }

    const validEventIds = new Set(validEvents.map((event) => event.id));
    const retainedPostIds = new Set(validEvents.map((event) => event.postId));
    const ignoredPostIds = originalPosts
      .filter((record) => !retainedPostIds.has(record?.post?.id))
      .map((record) => record?.post?.id)
      .filter(Boolean);
    const discardedNotificationIds = originalNotifications
      .filter((notification) => !validEventIds.has(notification.eventId))
      .map((notification) => notification.id)
      .filter(Boolean);
    state.posts = originalPosts
      .filter((record) => retainedPostIds.has(record?.post?.id))
      .sort(postRecordDescending);
    state.events = validEvents.sort((left, right) => compareTweetIds(right.postId, left.postId));
    state.notifications = originalNotifications.filter((notification) => validEventIds.has(notification.eventId));
    state.legacyAudit = {
      migratedAt,
      sourceBackup: 'state.v1.backup.json',
      originalPostCount: originalPosts.length,
      retainedPostIds: [...retainedPostIds],
      ignoredPostIds,
      supersededEventIds,
      discardedNotificationIds,
    };
    state.lifecycle = structuredClone(DEFAULT_STATE.lifecycle);
    for (const event of [...validEvents].sort((left, right) => compareTweetIds(left.postId, right.postId))) {
      this.applyLifecycle(event);
    }

    state.schemaVersion = 2;
    state.classifierVersion = CLASSIFIER_VERSION;
    // A v1 ID set may contain conversation parents from other authors. Rebuild
    // the cutover from one clean target-only fetch instead of guessing a
    // watermark from polluted history.
    state.baselineEstablished = false;
    state.baselineCutoffId = null;
    state.highWaterId = null;
    state.seenIds = [];
    this.storage.log('info', 'Migrated monitoring state to classifier v2; historical unsent notifications were superseded and the target watermark will be rebuilt.');
    this.storage.saveState();
    return true;
  }

  snapshot() {
    return {
      ...this.storage.getPublicSnapshot(),
      runtime: { ...this.status },
    };
  }

  emitUpdate() {
    this.emit('update', this.snapshot());
  }

  xSourceFingerprint(settings = this.storage.settings) {
    const x = settings?.x || {};
    return JSON.stringify([
      String(x.handle || ''),
      String(x.firefoxExecutablePath || ''),
      String(x.firefoxProfilePath || ''),
      Number(x.fetchLimit || 0),
    ]);
  }

  waitForIdle() {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  riskAccepted() {
    return Boolean(this.storage.settings.app.acceptedXActionsRisk);
  }

  pauseForUnacceptedRisk() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.storage.settings.app.monitoringEnabled) {
      this.storage.settings.app.monitoringEnabled = false;
      this.storage.saveSettings(this.storage.settings);
    }
    this.status.phase = 'paused';
    this.status.nextCheckAt = null;
    this.status.lastError = null;
    this.status.lastMessage = X_RISK_NOT_ACCEPTED_MESSAGE;
    this.emitUpdate();
  }

  resetForHandleChange(previousHandle, nextHandle) {
    this.storage.state.baselineEstablished = false;
    this.storage.state.baselineCutoffId = null;
    this.storage.state.highWaterId = null;
    this.storage.state.seenIds = [];
    this.storage.state.posts = [];
    this.storage.state.events = [];
    this.storage.state.notifications = [];
    this.storage.state.lifecycle = structuredClone(DEFAULT_STATE.lifecycle);
    this.storage.log(
      'info',
      `Target X handle changed from @${previousHandle} to @${nextHandle}; cleared account-scoped monitoring state.`,
    );
    this.storage.saveState();
  }

  updateXConnection(status, message, details = {}) {
    this.storage.state.xConnection = {
      ...this.storage.state.xConnection,
      status,
      checkedAt: new Date().toISOString(),
      message,
      errorCode: null,
      handle: `@${this.storage.settings.x.handle}`,
      ...details,
    };
  }

  scheduleNext(delayMs = null) {
    clearTimeout(this.timer);
    if (this.closing || !this.storage.settings.app.monitoringEnabled) {
      this.status.phase = 'paused';
      this.status.nextCheckAt = null;
      this.emitUpdate();
      return;
    }
    if (!this.riskAccepted()) {
      this.pauseForUnacceptedRisk();
      return;
    }
    const base = this.storage.settings.x.pollIntervalMinutes * 60 * 1000;
    const jittered = delayMs ?? Math.round(base * (0.85 + Math.random() * 0.3));
    this.status.nextCheckAt = new Date(Date.now() + jittered).toISOString();
    this.status.phase = this.status.lastError ? 'degraded' : 'running';
    this.timer = setTimeout(() => this.checkNow('timer'), jittered);
    this.emitUpdate();
  }

  start({ immediate = true } = {}) {
    if (!this.storage.settings.app.monitoringEnabled) {
      this.scheduleNext();
      return { ok: true, started: false };
    }
    if (!this.riskAccepted()) {
      this.pauseForUnacceptedRisk();
      return { ok: false, code: 'X_RISK_NOT_ACCEPTED', message: X_RISK_NOT_ACCEPTED_MESSAGE };
    }
    if (immediate) this.scheduleNext(1800);
    else this.scheduleNext();
    return { ok: true, started: true };
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.status.phase = 'paused';
    this.status.nextCheckAt = null;
    this.status.lastMessage = '监控已暂停';
    this.emitUpdate();
  }

  async setEnabled(enabled) {
    if (enabled && !this.riskAccepted()) {
      this.pauseForUnacceptedRisk();
      throw codedError('X_RISK_NOT_ACCEPTED', X_RISK_NOT_ACCEPTED_MESSAGE);
    }
    this.storage.settings.app.monitoringEnabled = Boolean(enabled);
    this.storage.saveSettings(this.storage.settings);
    if (enabled) this.start({ immediate: true });
    else this.stop();
    return this.snapshot();
  }

  shouldNotify(event) {
    const aiSettings = this.storage.settings.ai;
    if (event.validity === 'superseded' || event.directEvidence === false || event.needsHumanReview) return false;
    if (event.type === 'reset_announced') return event.confidence >= aiSettings.announcedThreshold;
    if (event.type === 'reset_completed') return event.confidence >= aiSettings.completedThreshold;
    return false;
  }

  selectPrimaryFinding(post, result) {
    const precedence = {
      reset_completed: 4,
      reset_announced: 3,
      reset_cancelled: 2,
      uncertain: 1,
    };
    const eligible = (result?.events || [])
      .filter((finding) => finding?.type !== 'none' && precedence[finding?.type])
      .filter((finding) => findingHasCurrentEvidence(post, finding))
      .map((finding) => ({
        ...finding,
        directEvidence: true,
        needsHumanReview: Boolean(result?.needs_human_review),
        translationZh: String(result?.translation_zh || ''),
      }));
    eligible.sort((left, right) =>
      precedence[right.type] - precedence[left.type] || Number(right.confidence || 0) - Number(left.confidence || 0));
    return eligible[0] || null;
  }

  applyLifecycle(event) {
    const lifecycle = this.storage.state.lifecycle;
    if (event.type === 'reset_announced') {
      if (lifecycle.status === 'completed' || lifecycle.status === 'cancelled') lifecycle.cycle += 1;
      lifecycle.status = 'planned';
      lifecycle.expectedAt = event.effectiveAt;
    } else if (event.type === 'reset_completed') {
      lifecycle.status = 'completed';
      lifecycle.completedAt = new Date().toISOString();
    } else if (event.type === 'reset_cancelled') {
      lifecycle.status = 'cancelled';
    }
  }

  intendedCycleFor(finding) {
    const lifecycle = this.storage.state.lifecycle;
    if (finding.type === 'reset_announced' && ['completed', 'cancelled'].includes(lifecycle.status)) {
      return Number(lifecycle.cycle || 0) + 1;
    }
    return Number(lifecycle.cycle || 0);
  }

  isRecentSameTypeEvent(post, finding, cycle) {
    const currentTime = Date.parse(post.timestamp);
    return this.storage.state.events.some((event) => {
      if (event.type !== finding.type || event.validity === 'superseded') return false;
      if (Number(event.cycle ?? cycle) !== cycle) return false;
      const priorPost = this.storage.state.posts.find((item) => item.post.id === event.postId)?.post;
      const priorTime = Date.parse(priorPost?.timestamp || event.createdAt);
      if (!Number.isFinite(currentTime) || !Number.isFinite(priorTime)) return false;
      return Math.abs(currentTime - priorTime) <= SAME_TYPE_SUPPRESSION_WINDOW_MS;
    });
  }

  createEvent(post, finding, analysisId) {
    const fingerprint = `${post.id}:${finding.type}`;
    if (this.storage.state.events.some((event) => event.fingerprint === fingerprint)) return null;
    const cycle = this.intendedCycleFor(finding);
    if (this.isRecentSameTypeEvent(post, finding, cycle)) return null;
    const event = {
      id: id('evt'),
      fingerprint,
      classifierVersion: CLASSIFIER_VERSION,
      validity: 'valid',
      analysisId,
      postId: post.id,
      type: finding.type,
      confidence: finding.confidence,
      explicit: finding.explicit,
      directEvidence: finding.directEvidence !== false,
      needsHumanReview: Boolean(finding.needsHumanReview),
      cycle,
      effectiveAt: finding.effective_at,
      summary: finding.summary,
      translationZh: finding.translationZh,
      evidence: finding.evidence,
      reason: finding.reason,
      createdAt: new Date().toISOString(),
      notificationStatus: this.shouldNotify(finding) ? 'pending' : 'not_required',
    };
    this.storage.state.events.unshift(event);
    this.applyLifecycle(event);
    return event;
  }

  async analyzePost(postRecord, { createEvents = true } = {}) {
    const post = postRecord.post;
    try {
      const context = this.storage.state.posts
        .filter((item) => item.post.id !== post.id)
        .filter((item) => item.analysisStatus === 'complete')
        .filter((item) => isTargetAuthoredPost(item.post, this.storage.settings.x.handle))
        .filter((item) => compareTweetIds(item.post.id, post.id) < 0)
        .sort(postRecordAscending)
        .slice(-5)
        .map((item) => item.post);
      const result = await this.ai.classify(post, context, this.storage.state.lifecycle);
      postRecord.analysisStatus = 'complete';
      postRecord.classifierVersion = CLASSIFIER_VERSION;
      postRecord.analysisAttempts = Number(postRecord.analysisAttempts || 0) + 1;
      postRecord.nextAnalysisAttemptAt = null;
      postRecord.analysisError = null;
      postRecord.analysis = {
        id: id('ana'),
        model: this.storage.settings.ai.model,
        promptVersion: this.storage.settings.ai.promptVersion,
        classifierVersion: CLASSIFIER_VERSION,
        contentHash: hashText(post.text),
        result,
        historicalBaseline: !createEvents,
        createdAt: new Date().toISOString(),
      };
      const created = [];
      const finding = this.selectPrimaryFinding(post, result);
      if (finding && createEvents) {
        const event = this.createEvent(post, finding, postRecord.analysis.id);
        if (event) created.push(event);
      }
      this.storage.saveState();
      let sentCount = 0;
      for (const event of created.filter((item) => item.notificationStatus === 'pending')) {
        const delivery = await this.deliverEvent(event, post);
        if (delivery.sent) sentCount += 1;
      }
      return { newEventCount: created.length, sentCount };
    } catch (error) {
      postRecord.analysisStatus = 'error';
      postRecord.classifierVersion = CLASSIFIER_VERSION;
      postRecord.analysisAttempts = Number(postRecord.analysisAttempts || 0) + 1;
      postRecord.analysisError = safeError(error);
      const minutes = ANALYSIS_RETRY_MINUTES[Math.min(
        postRecord.analysisAttempts - 1,
        ANALYSIS_RETRY_MINUTES.length - 1,
      )];
      postRecord.nextAnalysisAttemptAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
      this.storage.log('error', `Analysis failed for post ${post.id}: ${safeError(error)}`);
      this.storage.saveState();
      return { newEventCount: 0, sentCount: 0, error: safeError(error) };
    }
  }

  async deliverEvent(event, post) {
    if (!this.storage.settings.mail.enabled) {
      event.notificationStatus = 'waiting_for_mail_config';
      this.storage.saveState();
      return { attempted: false, sent: false, waitingForMailConfig: true };
    }
    if (this.mailAuthCircuitOpen) return { attempted: false, sent: false, authCircuitOpen: true };
    const existing = this.storage.state.notifications.find((item) => item.eventId === event.id);
    if (existing?.status === 'sent') return { attempted: false, sent: false, alreadySent: true };
    if (existing?.status === 'superseded' || event.notificationStatus === 'superseded') {
      return { attempted: false, sent: false, superseded: true };
    }
    const notification = existing || {
      id: id('mail'),
      classifierVersion: CLASSIFIER_VERSION,
      eventId: event.id,
      postId: post.id,
      status: 'pending',
      attempts: 0,
      createdAt: new Date().toISOString(),
      nextAttemptAt: null,
    };
    if (!existing) this.storage.state.notifications.unshift(notification);
    notification.attempts = Number(notification.attempts || 0) + 1;
    notification.status = 'sending';
    notification.lastAttemptAt = new Date().toISOString();
    notification.nextAttemptAt = null;
    notification.lastError = null;
    event.notificationStatus = 'pending';
    this.storage.saveState();
    try {
      const result = await this.mailer.sendEvent(event, post);
      notification.status = 'sent';
      notification.sentAt = new Date().toISOString();
      notification.messageId = result.messageId;
      notification.lastError = null;
      event.notificationStatus = 'sent';
      this.storage.saveState();
      return { attempted: true, sent: true };
    } catch (error) {
      const authError = isMailAuthError(error);
      notification.status = 'failed';
      notification.lastError = safeError(error);
      const waits = [1, 5, 15, 60];
      const minutes = waits[Math.min(notification.attempts - 1, waits.length - 1)];
      notification.nextAttemptAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
      event.notificationStatus = 'failed';
      if (authError) this.mailAuthCircuitOpen = true;
      this.storage.saveState();
      return { attempted: true, sent: false, authError };
    }
  }

  async retryPendingNotifications() {
    const now = Date.now();
    const pendingMail = this.storage.state.notifications.filter((item) =>
      RETRYABLE_NOTIFICATION_STATUSES.has(item.status) && (
        item.status === 'sending' ||
        !item.nextAttemptAt ||
        !Number.isFinite(Date.parse(item.nextAttemptAt)) ||
        Date.parse(item.nextAttemptAt) <= now
      ),
    ).sort((left, right) => compareTweetIds(left.postId, right.postId));
    let retriedCount = 0;
    let sentCount = 0;
    for (const notification of pendingMail) {
      const event = this.storage.state.events.find((item) => item.id === notification.eventId);
      const post = this.storage.state.posts.find((item) => item.post.id === notification.postId)?.post;
      if (event && post) {
        const delivery = await this.deliverEvent(event, post);
        if (delivery.attempted) retriedCount += 1;
        if (delivery.sent) sentCount += 1;
        if (delivery.authError || delivery.authCircuitOpen) break;
      }
    }

    if (this.mailAuthCircuitOpen) return { retriedCount, sentCount, authCircuitOpen: true };
    const orphanedEvents = this.storage.state.events.filter((event) =>
      ['pending', 'failed', 'error', 'sending'].includes(event.notificationStatus) &&
      !this.storage.state.notifications.some((notification) => notification.eventId === event.id),
    ).sort((left, right) => compareTweetIds(left.postId, right.postId));
    for (const event of orphanedEvents) {
      const post = this.storage.state.posts.find((item) => item.post.id === event.postId)?.post;
      if (post) {
        const delivery = await this.deliverEvent(event, post);
        if (delivery.attempted) retriedCount += 1;
        if (delivery.sent) sentCount += 1;
        if (delivery.authError || delivery.authCircuitOpen) break;
      }
    }

    if (this.storage.settings.mail.enabled && !this.mailAuthCircuitOpen) {
      const waiting = this.storage.state.events.filter((event) => event.notificationStatus === 'waiting_for_mail_config');
      for (const event of waiting) {
        const post = this.storage.state.posts.find((item) => item.post.id === event.postId)?.post;
        if (post) {
          const delivery = await this.deliverEvent(event, post);
          if (delivery.attempted) retriedCount += 1;
          if (delivery.sent) sentCount += 1;
          if (delivery.authError || delivery.authCircuitOpen) break;
        }
      }
    }
    return { retriedCount, sentCount, authCircuitOpen: this.mailAuthCircuitOpen };
  }

  async retryPending({ postRecords = [], retryNotifications = this.storage.settings.app.monitoringEnabled } = {}) {
    let newEventCount = 0;
    let sentCount = 0;
    const cutoff = this.storage.state.baselineCutoffId;
    for (const post of [...postRecords].sort(postRecordAscending)) {
      const createEvents = !cutoff || compareTweetIds(post.post.id, cutoff) > 0;
      const outcome = await this.analyzePost(post, { createEvents });
      newEventCount += outcome.newEventCount;
      sentCount += outcome.sentCount;
    }
    let retriedCount = 0;
    if (retryNotifications) {
      const retried = await this.retryPendingNotifications();
      retriedCount += retried.retriedCount;
      sentCount += retried.sentCount;
    }
    return { newEventCount, sentCount, retriedCount };
  }

  pendingV2AnalysisRecords(now = Date.now()) {
    return this.storage.state.posts
      .filter((record) => Number(record.classifierVersion) === CLASSIFIER_VERSION)
      .filter((record) => ['pending', 'error'].includes(record.analysisStatus))
      .filter((record) => Number(record.analysisAttempts || 0) < 5)
      .filter((record) => isTargetAuthoredPost(record.post, this.storage.settings.x.handle))
      .filter((record) =>
        !record.nextAnalysisAttemptAt ||
        !Number.isFinite(Date.parse(record.nextAnalysisAttemptAt)) ||
        Date.parse(record.nextAnalysisAttemptAt) <= now,
      )
      .sort(postRecordAscending);
  }

  publishRunCounters(run) {
    const freshCount = Number(run?.freshCount || 0);
    run.freshCount = freshCount;
    run.newCount = freshCount;
    run.newEventCount = Number(run?.newEventCount || 0);
    run.retriedCount = Number(run?.retriedCount || 0);
    run.sentCount = Number(run?.sentCount || 0);
    run.outOfWindowCount = Number(run?.outOfWindowCount || 0);
    this.status.newCount = freshCount;
    this.status.newEventCount = run.newEventCount;
    this.status.retriedCount = run.retriedCount;
    this.status.sentCount = run.sentCount;
    this.status.outOfWindowCount = run.outOfWindowCount;
  }

  async checkNow(reason = 'manual') {
    if (this.closing) {
      return { ok: false, skipped: true, code: 'MONITOR_CLOSING', message: '监控正在关闭。' };
    }
    if (!this.riskAccepted()) {
      this.pauseForUnacceptedRisk();
      return { ok: false, skipped: true, code: 'X_RISK_NOT_ACCEPTED', message: X_RISK_NOT_ACCEPTED_MESSAGE };
    }
    if (this.busy) return { ok: false, message: '检查已在进行中。' };
    this.busy = true;
    this.mailAuthCircuitOpen = false;
    clearTimeout(this.timer);
    this.status.busy = true;
    this.status.phase = 'checking';
    this.status.lastError = null;
    this.status.lastMessage = '正在读取 Tibo 的最新动态…';
    this.status.newCount = 0;
    this.status.newEventCount = 0;
    this.status.retriedCount = 0;
    this.status.sentCount = 0;
    this.status.outOfWindowCount = 0;
    this.emitUpdate();
    const run = {
      id: id('poll'),
      reason,
      startedAt: new Date().toISOString(),
      outcome: 'running',
      fetchedCount: 0,
      newCount: 0,
      freshCount: 0,
      newEventCount: 0,
      retriedCount: 0,
      sentCount: 0,
      outOfWindowCount: 0,
    };
    this.storage.state.pollRuns.unshift(run);
    try {
      if (this.storage.settings.app.monitoringEnabled) {
        const retried = await this.retryPendingNotifications();
        run.retriedCount += retried.retriedCount;
        run.sentCount += retried.sentCount;
      }
      const sourceFingerprint = this.xSourceFingerprint();
      const fetchResult = await this.source.fetchLatest();
      const { posts, observedHighWaterId } = normalizeFetchResult(fetchResult);
      if (sourceFingerprint !== this.xSourceFingerprint()) {
        run.outcome = 'skipped';
        run.skipReason = 'settings_changed';
        run.discardedCount = posts.length;
        run.finishedAt = new Date().toISOString();
        this.status.lastCheckAt = run.finishedAt;
        this.status.fetchedCount = 0;
        this.status.newCount = 0;
        this.status.lastError = null;
        this.status.lastMessage = 'X 数据源设置已更改，本轮旧结果已丢弃；水位线与通知状态保持不变。';
        this.publishRunCounters(run);
        this.storage.log('warn', `Poll skipped: X source settings changed while fetching; discarded ${posts.length} post(s).`);
        this.storage.saveState();
        return {
          ok: false,
          skipped: true,
          reason: 'settings_changed',
          code: 'X_SETTINGS_CHANGED',
          message: this.status.lastMessage,
          freshCount: 0,
          newEventCount: 0,
          retriedCount: run.retriedCount,
          sentCount: run.sentCount,
        };
      }
      run.fetchedCount = posts.length;
      this.status.fetchedCount = posts.length;
      const targetObservedPosts = posts.filter((post) => isTargetAuthoredPost(post, this.storage.settings.x.handle));
      const windowNow = Number(this.now());
      const targetPosts = targetObservedPosts.filter((post) => isPostWithinMonitoringWindow(post, windowNow));
      run.outOfWindowCount = targetObservedPosts.length - targetPosts.length;
      const observedWatermark = observedHighWaterId || maxTweetId(targetObservedPosts);
      const newestPost = sortTweetIdsDescending(targetPosts)[0] || null;
      this.updateXConnection('connected', `登录有效，已读取 ${targetPosts.length} 条目标账号动态。`, {
        browser: this.source.lastBrowserLabel || this.source.browserLabel || this.storage.state.xConnection.browser || null,
        count: targetPosts.length,
        newestAt: newestPost?.timestamp || null,
      });

      if (!this.storage.state.baselineEstablished || !this.storage.state.highWaterId) {
        const baselineHighWater = observedWatermark || maxTweetId(targetPosts);
        this.storage.state.seenIds = targetPosts.map((post) => String(post.id)).slice(0, 500);
        this.storage.state.baselineEstablished = Boolean(baselineHighWater);
        this.storage.state.baselineCutoffId = baselineHighWater;
        this.storage.state.highWaterId = baselineHighWater;
        this.storage.state.classifierVersion = CLASSIFIER_VERSION;
        const baselineRecords = [];
        for (const post of targetPosts) {
          const existing = this.storage.state.posts.find((item) => item.post.id === post.id);
          if (existing) {
            if (['pending', 'error'].includes(existing.analysisStatus)) baselineRecords.push(existing);
            continue;
          }
          const record = {
            post,
            classifierVersion: CLASSIFIER_VERSION,
            fetchedAt: new Date().toISOString(),
            analysisStatus: 'pending',
            analysisAttempts: 0,
            nextAnalysisAttemptAt: null,
            analysis: null,
          };
          this.storage.state.posts.push(record);
          baselineRecords.push(record);
        }
        this.storage.saveState();
        const analyzed = await this.retryPending({
          postRecords: baselineRecords,
          retryNotifications: false,
        });
        run.newEventCount += analyzed.newEventCount;
        run.sentCount += analyzed.sentCount;
        this.storage.state.posts.sort(postRecordDescending);
        run.outcome = baselineHighWater ? 'baseline' : 'baseline_pending';
        this.status.newCount = 0;
        this.status.lastMessage = baselineHighWater
          ? `基线已建立：已调用大模型分析 ${baselineRecords.length} 条现有动态，不发送历史提醒。`
          : '本轮未读取到目标账号动态，安全基线尚未建立；不会发送历史提醒。';
        if (run.sentCount) this.status.lastMessage += ` 本轮另补发 ${run.sentCount} 封历史提醒。`;
      } else {
        const seen = new Set(this.storage.state.seenIds);
        const previousHighWater = this.storage.state.highWaterId;
        const freshCandidates = sortTweetIdsAscending(targetPosts.filter((post) =>
          !seen.has(String(post.id)) &&
          (!previousHighWater || compareTweetIds(post.id, previousHighWater) > 0),
        ));
        this.storage.state.seenIds = [...new Set([
          ...targetPosts.map((post) => String(post.id)),
          ...this.storage.state.seenIds,
        ])].slice(0, 500);
        const fetchedHighWater = observedWatermark || maxTweetId(targetPosts);
        if (fetchedHighWater && (!previousHighWater || compareTweetIds(fetchedHighWater, previousHighWater) > 0)) {
          this.storage.state.highWaterId = fetchedHighWater;
        }
        const inserted = [];
        for (const post of freshCandidates) {
          if (this.storage.state.posts.some((item) => item.post.id === post.id)) continue;
          const record = {
            post,
            classifierVersion: CLASSIFIER_VERSION,
            fetchedAt: new Date().toISOString(),
            analysisStatus: 'pending',
            analysisAttempts: 0,
            nextAnalysisAttemptAt: null,
            analysis: null,
          };
          this.storage.state.posts.push(record);
          inserted.push(record);
        }
        this.storage.saveState();
        const analyzed = await this.retryPending({
          postRecords: this.pendingV2AnalysisRecords(),
          retryNotifications: false,
        });
        run.newEventCount += analyzed.newEventCount;
        run.sentCount += analyzed.sentCount;
        this.storage.state.posts.sort(postRecordDescending);
        const postsById = new Map(this.storage.state.posts.map((item) => [item.post.id, item.post]));
        this.storage.state.events.sort((left, right) => {
          const leftPost = postsById.get(left.postId);
          const rightPost = postsById.get(right.postId);
          const byId = compareTweetIds(rightPost?.id || right.postId, leftPost?.id || left.postId);
          return byId || String(right.createdAt || '').localeCompare(String(left.createdAt || ''));
        });
        run.newCount = inserted.length;
        run.freshCount = inserted.length;
        this.status.newCount = inserted.length;
        run.outcome = 'success';
        if (inserted.length) {
          this.status.lastMessage = `发现并处理 ${inserted.length} 条新动态，生成 ${run.newEventCount} 条新信号。`;
        } else if (run.newEventCount) {
          this.status.lastMessage = `检查完成，没有新动态；重试分析生成 ${run.newEventCount} 条信号并发送 ${run.sentCount} 封提醒。`;
        } else if (run.sentCount) {
          this.status.lastMessage = `检查完成，没有新动态；补发 ${run.sentCount} 封历史提醒。`;
        } else {
          this.status.lastMessage = '检查完成，没有新动态。';
        }
      }
      run.finishedAt = new Date().toISOString();
      this.status.lastCheckAt = run.finishedAt;
      this.status.lastError = null;
      this.publishRunCounters(run);
      this.storage.saveState();
      return {
        ok: true,
        message: this.status.lastMessage,
        fetched: run.fetchedCount,
        fresh: run.freshCount,
        freshCount: run.freshCount,
        newEventCount: run.newEventCount,
        retriedCount: run.retriedCount,
        sentCount: run.sentCount,
        outOfWindowCount: run.outOfWindowCount,
      };
    } catch (error) {
      const profileInUse = error.code === 'X_FIREFOX_PROFILE_IN_USE';
      const sourceBusy = error.code === 'X_BUSY';
      const skipped = profileInUse || sourceBusy;
      run.outcome = skipped ? 'skipped' : 'error';
      if (profileInUse) run.skipReason = 'profile_in_use';
      if (sourceBusy) run.skipReason = 'source_busy';
      run.error = safeError(error);
      run.errorCode = error.code || null;
      run.finishedAt = new Date().toISOString();
      this.status.lastCheckAt = run.finishedAt;
      this.status.lastError = skipped ? null : run.error;
      this.status.lastMessage = profileInUse
        ? 'Firefox 正在使用所选 profile，本轮已跳过；水位线与通知状态保持不变。'
        : sourceBusy
          ? 'X 正在执行另一项操作，本轮已跳过；水位线与通知状态保持不变。'
          : '本次检查失败，已保留原水位线。';
      if (skipped) {
        this.status.fetchedCount = 0;
        this.status.newCount = 0;
      }
      const waitingForLogin = ['X_AUTH_REQUIRED', 'X_LOGIN_IN_PROGRESS', 'X_LOGIN_WINDOW_STILL_OPEN', 'X_CHALLENGE_REQUIRED'].includes(error.code);
      if (!sourceBusy) {
        this.updateXConnection(profileInUse ? 'waiting_profile' : waitingForLogin ? 'login_required' : 'error', run.error, {
          errorCode: error.code || 'X_UNKNOWN',
        });
      }
      this.publishRunCounters(run);
      this.storage.log(skipped ? 'warn' : 'error', skipped ? `Poll skipped: ${run.error}` : `Poll failed: ${run.error}`);
      this.storage.saveState();
      return {
        ok: false,
        skipped,
        message: run.error,
        code: error.code || null,
        freshCount: run.freshCount,
        newEventCount: run.newEventCount,
        retriedCount: run.retriedCount,
        sentCount: run.sentCount,
        outOfWindowCount: run.outOfWindowCount,
      };
    } finally {
      this.busy = false;
      this.status.busy = false;
      this.scheduleNext();
      for (const resolve of this.idleWaiters.splice(0)) resolve();
    }
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearTimeout(this.timer);
    this.timer = null;
    const closing = (async () => {
      await this.waitForIdle();
      await this.source.close();
      this.status.phase = 'paused';
      this.status.nextCheckAt = null;
      this.status.busy = false;
    })();
    this.closePromise = closing;
    try {
      return await closing;
    } finally {
      if (this.closePromise === closing) this.closePromise = null;
    }
  }

  cancelClose() {
    if (this.closePromise) return false;
    this.closing = false;
    this.start({ immediate: false });
    return true;
  }
}

module.exports = {
  MonitorService,
  isPostWithinMonitoringWindow,
  normalizeFetchResult,
  rebaseSettingsSnapshot,
};
