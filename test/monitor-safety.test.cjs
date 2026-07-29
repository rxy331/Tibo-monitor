'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_SETTINGS, DEFAULT_STATE } = require('../src/lib/defaults.cjs');
const {
  MonitorService,
  isPostWithinMonitoringWindow,
  normalizeFetchResult,
  rebaseSettingsSnapshot,
} = require('../src/lib/monitor.cjs');
const { sanitizeSettings } = require('../src/lib/utils.cjs');

function clone(value) {
  return structuredClone(value);
}

function fakeStorage({ acceptedRisk = true } = {}) {
  const savedStates = [];
  const logs = [];
  return {
    settings: clone(DEFAULT_SETTINGS),
    state: clone(DEFAULT_STATE),
    savedStates,
    logs,
    getPublicSnapshot() {
      return { settings: this.settings, state: this.state, secrets: {}, dataPath: 'test' };
    },
    saveSettings(next) {
      this.settings = next;
    },
    saveState() {
      savedStates.push(clone(this.state));
    },
    log(level, message) { logs.push({ level, message }); },
    initialize() {
      this.settings.app.acceptedXActionsRisk = acceptedRisk;
      this.settings.app.monitoringEnabled = false;
      return this;
    },
  }.initialize();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function samplePost(id = '991', overrides = {}) {
  return {
    id,
    text: 'Old account post about resetting limits',
    timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    url: `https://x.com/thsottiaux/status/${id}`,
    authorHandle: 'thsottiaux',
    isRetweet: false,
    ...overrides,
  };
}

test('monitoring window is inclusive at minus 30 minutes and plus 2 minutes', () => {
  const now = Date.parse('2026-07-28T10:00:00.000Z');
  const at = (offset) => ({ timestamp: new Date(now + offset).toISOString() });
  assert.equal(isPostWithinMonitoringWindow(at(-30 * 60 * 1000), now), true);
  assert.equal(isPostWithinMonitoringWindow(at(-30 * 60 * 1000 - 1), now), false);
  assert.equal(isPostWithinMonitoringWindow(at(2 * 60 * 1000), now), true);
  assert.equal(isPostWithinMonitoringWindow(at(2 * 60 * 1000 + 1), now), false);
  assert.equal(isPostWithinMonitoringWindow({ timestamp: null }, now), false);
});

test('fetch result accepts the observed high-water contract while preserving legacy arrays', () => {
  const legacy = [samplePost('1')];
  legacy.observedHighWaterId = '9';
  assert.deepEqual(normalizeFetchResult(legacy), { posts: legacy, observedHighWaterId: '9' });
  assert.deepEqual(normalizeFetchResult({ posts: [], observedHighWaterId: '500' }), {
    posts: [],
    observedHighWaterId: '500',
  });
  assert.deepEqual(normalizeFetchResult({ posts: 'invalid', observedHighWaterId: 'not-an-id' }), {
    posts: [],
    observedHighWaterId: null,
  });
});

test('out-of-window target posts never enter state, AI, events, or mail', async () => {
  const now = Date.parse('2026-07-28T10:00:00.000Z');
  const storage = fakeStorage();
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '100';
  storage.state.highWaterId = '100';
  const posts = [
    samplePost('101', { timestamp: new Date(now - 30 * 60 * 1000).toISOString() }),
    samplePost('102', { timestamp: new Date(now - 30 * 60 * 1000 - 1).toISOString() }),
    samplePost('103', { timestamp: new Date(now + 2 * 60 * 1000).toISOString() }),
    samplePost('104', { timestamp: new Date(now + 2 * 60 * 1000 + 1).toISOString() }),
    samplePost('105', { timestamp: null }),
  ];
  let aiCalls = 0;
  let mailCalls = 0;
  const monitor = new MonitorService({
    storage,
    source: { async fetchLatest() { return posts; }, async close() {} },
    ai: { async classify() { aiCalls += 1; return { events: [] }; } },
    mailer: { async sendEvent() { mailCalls += 1; return {}; } },
    now: () => now,
  });

  const result = await monitor.checkNow('window-boundary');

  assert.equal(result.freshCount, 2);
  assert.equal(result.outOfWindowCount, 3);
  assert.equal(storage.state.pollRuns[0].outOfWindowCount, 3);
  assert.deepEqual(storage.state.posts.map((record) => record.post.id), ['103', '101']);
  assert.deepEqual(storage.state.seenIds.sort(), ['101', '103']);
  assert.equal(aiCalls, 2);
  assert.equal(storage.state.events.length, 0);
  assert.equal(mailCalls, 0);
  assert.equal(storage.state.highWaterId, '105');
  monitor.stop();
});

test('empty recent result establishes observed water and a later higher recent ID is fresh', async () => {
  const now = Date.parse('2026-07-28T10:00:00.000Z');
  const storage = fakeStorage();
  const batches = [
    { posts: [], observedHighWaterId: '500' },
    {
      posts: [samplePost('501', { timestamp: new Date(now - 60 * 1000).toISOString() })],
      observedHighWaterId: '501',
    },
  ];
  let fetchIndex = 0;
  let aiCalls = 0;
  const monitor = new MonitorService({
    storage,
    source: { async fetchLatest() { return batches[fetchIndex++]; }, async close() {} },
    ai: { async classify() { aiCalls += 1; return { events: [] }; } },
    mailer: { async sendEvent() { throw new Error('mail must not run'); } },
    now: () => now,
  });

  const baseline = await monitor.checkNow('empty-recent-baseline');
  assert.equal(baseline.freshCount, 0);
  assert.equal(storage.state.baselineEstablished, true);
  assert.equal(storage.state.baselineCutoffId, '500');
  assert.equal(storage.state.highWaterId, '500');
  assert.deepEqual(storage.state.seenIds, []);
  assert.equal(aiCalls, 0);

  const next = await monitor.checkNow('later-recent');
  assert.equal(next.freshCount, 1);
  assert.equal(storage.state.highWaterId, '501');
  assert.equal(storage.state.posts[0].post.id, '501');
  assert.equal(aiCalls, 1);
  monitor.stop();
});

test('the main process gates navigation and all IPC handlers to the local renderer', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  assert.match(mainSource, /webContents\.on\('will-navigate'/);
  assert.match(mainSource, /if \(!isTrustedRendererUrl\(targetUrl\)\)\s*\{\s*event\.preventDefault\(\)/);
  assert.match(mainSource, /event\.senderFrame\?\.url/);
  assert.match(mainSource, /IPC_UNTRUSTED_SENDER/);
  assert.equal((mainSource.match(/ipcMain\.handle\(/g) || []).length, 1);
  assert.ok((mainSource.match(/trustedHandle\('/g) || []).length >= 14);
});

test('portable shortcuts target the persistent launcher and replace an existing link', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  assert.match(mainSource, /process\.env\.PORTABLE_EXECUTABLE_FILE/);
  assert.match(mainSource, /app\.isPackaged && portableTarget && fs\.existsSync\(portableTarget\)/);
  assert.match(mainSource, /cwd: app\.isPackaged \? path\.dirname\(target\) : app\.getAppPath\(\)/);
  assert.match(mainSource, /icon: app\.isPackaged \? target : assetPath\('app-icon\.ico'\)/);
  assert.match(mainSource, /const operation = fs\.existsSync\(shortcutPath\) \? 'replace' : 'create'/);
  assert.match(mainSource, /shell\.writeShortcutLink\(shortcutPath, operation, options\)/);
});

test('settings saves are serialized and rebase full snapshots captured concurrently', () => {
  const base = clone(DEFAULT_SETTINGS);
  const current = clone(base);
  current.x.handle = 'first_writer';
  current.mail.host = 'smtp.first.example';
  const secondRequest = clone(base);
  secondRequest.ai.model = 'second-writer-model';
  secondRequest.mail.port = 587;

  const merged = rebaseSettingsSnapshot(current, base, secondRequest);

  assert.equal(merged.x.handle, 'first_writer');
  assert.equal(merged.mail.host, 'smtp.first.example');
  assert.equal(merged.ai.model, 'second-writer-model');
  assert.equal(merged.mail.port, 587);
  assert.equal(base.x.handle, DEFAULT_SETTINGS.x.handle);

  const sameFieldRequest = clone(base);
  sameFieldRequest.x.handle = 'second_writer';
  assert.equal(rebaseSettingsSnapshot(current, base, sameFieldRequest).x.handle, 'second_writer');

  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  assert.match(mainSource, /let settingsSaveQueue = Promise\.resolve\(\)/);
  assert.match(mainSource, /return enqueueSettingsSave\(async \(\) =>/);
  assert.match(mainSource, /rebaseSettingsSnapshot\(storage\.settings, baseSettings, requestedSettings\)/);
});

test('settings migration permanently drops legacy reply and retweet toggles', () => {
  const legacy = clone(DEFAULT_SETTINGS);
  legacy.schemaVersion = 1;
  legacy.x.includeReplies = true;
  legacy.x.includeRetweets = true;
  legacy.ai.promptVersion = 'reset-classifier-v1';
  const migrated = sanitizeSettings(legacy, DEFAULT_SETTINGS);
  assert.equal(migrated.schemaVersion, 4);
  assert.equal(Object.hasOwn(migrated.x, 'includeReplies'), false);
  assert.equal(Object.hasOwn(migrated.x, 'includeRetweets'), false);
  assert.equal(migrated.ai.promptVersion, 'reset-classifier-v2');

  const current = clone(DEFAULT_SETTINGS);
  current.x.includeReplies = true;
  current.x.includeRetweets = true;
  assert.equal(Object.hasOwn(sanitizeSettings(current, DEFAULT_SETTINGS).x, 'includeReplies'), false);
  assert.equal(Object.hasOwn(sanitizeSettings(current, DEFAULT_SETTINGS).x, 'includeRetweets'), false);
});

test('quit is blocked on cleanup failure and only resumes after retry or explicit cancellation', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  assert.match(mainSource, /app\.on\('before-quit', interceptQuitUntilMonitorCloses\)/);
  assert.match(mainSource, /app\.on\('will-quit', interceptQuitUntilMonitorCloses\)/);
  assert.match(mainSource, /buttons: \['重试安全退出', '暂不退出'\]/);
  assert.match(mainSource, /if \(result\.response === 0\) continue/);
  assert.match(mainSource, /monitor\?\.cancelClose\(\)/);
  assert.doesNotMatch(mainSource, /finally\s*\{\s*app\.quit\(\)/);
});

const sourceChangeScenarios = [
  {
    name: 'handle',
    prepare(storage) {
      storage.settings.x.handle = 'oldacct';
      storage.state.baselineEstablished = false;
      storage.state.seenIds = [];
    },
    mutate(storage) {
      storage.settings.x.handle = 'newacct';
      storage.state.baselineEstablished = false;
      storage.state.seenIds = [];
    },
  },
  {
    name: 'Firefox executable path',
    prepare(storage) {
      storage.settings.x.firefoxExecutablePath = 'C:\\Firefox\\old\\firefox.exe';
      storage.state.baselineEstablished = true;
      storage.state.seenIds = ['known'];
    },
    mutate(storage) {
      storage.settings.x.firefoxExecutablePath = 'C:\\Firefox\\new\\firefox.exe';
    },
  },
  {
    name: 'Firefox profile path',
    prepare(storage) {
      storage.settings.x.firefoxProfilePath = 'C:\\Firefox\\Profiles\\old';
      storage.state.baselineEstablished = true;
      storage.state.seenIds = ['known'];
    },
    mutate(storage) {
      storage.settings.x.firefoxProfilePath = 'C:\\Firefox\\Profiles\\new';
    },
  },
];

for (const scenario of sourceChangeScenarios) {
  test(`a completed fetch is discarded when ${scenario.name} changes in flight`, async () => {
    const storage = fakeStorage();
    scenario.prepare(storage);
    storage.settings.mail.enabled = true;
    const baselineBeforeFetch = storage.state.baselineEstablished;
    const seenBeforeFetch = clone(storage.state.seenIds);
    const connectionBeforeFetch = clone(storage.state.xConnection);
    const started = deferred();
    const fetch = deferred();
    let aiCalls = 0;
    let mailCalls = 0;
    const source = {
      async fetchLatest() {
        started.resolve();
        return fetch.promise;
      },
      async close() {},
    };
    const ai = {
      async classify() {
        aiCalls += 1;
        return {
          events: [{
            type: 'reset_completed',
            confidence: 0.99,
            explicit: true,
            effective_at: null,
            summary: 'Reset completed',
            evidence: ['resetting limits'],
            reason: 'explicit',
          }],
        };
      },
    };
    const mailer = {
      async sendEvent() {
        mailCalls += 1;
        return { messageId: 'should-not-send' };
      },
    };
    const monitor = new MonitorService({ storage, source, ai, mailer });

    const checking = monitor.checkNow('test');
    await started.promise;
    scenario.mutate(storage);
    fetch.resolve([samplePost()]);
    const result = await checking;

    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'settings_changed');
    assert.equal(result.code, 'X_SETTINGS_CHANGED');
    assert.equal(storage.state.pollRuns[0].outcome, 'skipped');
    assert.equal(storage.state.pollRuns[0].skipReason, 'settings_changed');
    assert.equal(storage.state.pollRuns[0].discardedCount, 1);
    assert.equal(storage.state.pollRuns[0].fetchedCount, 0);
    assert.equal(storage.state.baselineEstablished, baselineBeforeFetch);
    assert.deepEqual(storage.state.seenIds, seenBeforeFetch);
    assert.deepEqual(storage.state.xConnection, connectionBeforeFetch);
    assert.deepEqual(storage.state.posts, []);
    assert.deepEqual(storage.state.events, []);
    assert.deepEqual(storage.state.notifications, []);
    assert.equal(aiCalls, 0);
    assert.equal(mailCalls, 0);
    assert.equal(monitor.busy, false);
    assert.equal(monitor.timer, null);
  });
}

test('risk acceptance is enforced by every MonitorService start path', async () => {
  const storage = fakeStorage({ acceptedRisk: false });
  let fetchCalls = 0;
  const source = {
    async fetchLatest() {
      fetchCalls += 1;
      return [samplePost()];
    },
    async close() {},
  };
  const monitor = new MonitorService({
    storage,
    source,
    ai: { async classify() { throw new Error('AI must not run'); } },
    mailer: { async sendEvent() { throw new Error('mail must not run'); } },
  });

  const manual = await monitor.checkNow('manual');
  assert.equal(manual.ok, false);
  assert.equal(manual.skipped, true);
  assert.equal(manual.code, 'X_RISK_NOT_ACCEPTED');
  assert.equal(fetchCalls, 0);
  assert.equal(monitor.status.phase, 'paused');
  assert.equal(monitor.timer, null);

  await assert.rejects(
    monitor.setEnabled(true),
    (error) => error.code === 'X_RISK_NOT_ACCEPTED',
  );
  assert.equal(storage.settings.app.monitoringEnabled, false);
  assert.equal(fetchCalls, 0);

  storage.settings.app.monitoringEnabled = true;
  const automatic = monitor.start({ immediate: true });
  assert.equal(automatic.ok, false);
  assert.equal(automatic.code, 'X_RISK_NOT_ACCEPTED');
  assert.equal(storage.settings.app.monitoringEnabled, false);
  assert.equal(monitor.status.phase, 'paused');
  assert.equal(monitor.timer, null);
  assert.equal(fetchCalls, 0);
});

test('changing handles clears all account-scoped history and lifecycle state', () => {
  const storage = fakeStorage();
  storage.state.baselineEstablished = true;
  storage.state.seenIds = ['1'];
  storage.state.posts = [{ post: samplePost('1'), analysisStatus: 'complete' }];
  storage.state.events = [{ id: 'evt_a', postId: '1', notificationStatus: 'pending' }];
  storage.state.notifications = [{ id: 'mail_a', eventId: 'evt_a', status: 'failed' }];
  storage.state.lifecycle = {
    status: 'planned',
    cycle: 4,
    expectedAt: '2026-07-29T00:00:00.000Z',
    completedAt: null,
  };
  storage.state.pollRuns = [{ id: 'poll_a', outcome: 'success' }];
  const monitor = new MonitorService({
    storage,
    source: { async close() {} },
    ai: {},
    mailer: {},
  });

  monitor.resetForHandleChange('account_a', 'account_b');

  assert.equal(storage.state.baselineEstablished, false);
  assert.equal(storage.state.baselineCutoffId, null);
  assert.equal(storage.state.highWaterId, null);
  assert.deepEqual(storage.state.seenIds, []);
  assert.deepEqual(storage.state.posts, []);
  assert.deepEqual(storage.state.events, []);
  assert.deepEqual(storage.state.notifications, []);
  assert.deepEqual(storage.state.lifecycle, DEFAULT_STATE.lifecycle);
  assert.deepEqual(storage.state.pollRuns, [{ id: 'poll_a', outcome: 'success' }]);
  assert.match(storage.logs.at(-1).message, /@account_a.*@account_b/);
  assert.equal(storage.savedStates.length, 1);
});

test('baseline analyzes every in-window target original but never sends historical mail', async () => {
  const storage = fakeStorage();
  const targetOld = samplePost('200', { timestamp: '2026-07-28T08:00:00.000Z' });
  const targetNew = samplePost('300', { timestamp: '2026-07-28T10:00:00.000Z' });
  const foreign = samplePost('999', {
    timestamp: '2026-07-28T11:00:00.000Z',
    url: 'https://x.com/someone_else/status/999',
    authorHandle: 'someone_else',
  });
  const targetRepost = samplePost('400', { isRetweet: true });
  let aiCalls = 0;
  let mailCalls = 0;
  const monitor = new MonitorService({
    storage,
    source: { async fetchLatest() { return [targetOld, foreign, targetRepost, targetNew]; }, async close() {} },
    ai: { async classify() {
      aiCalls += 1;
      return { events: [{
        type: 'reset_announced',
        confidence: 0.99,
        explicit: true,
        evidence: ['post'],
        summary: '历史基线信号',
      }] };
    } },
    mailer: { async sendEvent() { mailCalls += 1; return { messageId: 'must-not-send' }; } },
    now: () => Date.parse('2026-07-28T10:05:00.000Z'),
  });

  const result = await monitor.checkNow('test');

  assert.equal(result.freshCount, 0);
  assert.equal(storage.state.highWaterId, '300');
  assert.equal(storage.state.baselineCutoffId, '300');
  assert.deepEqual(new Set(storage.state.seenIds), new Set(['300']));
  assert.equal(storage.state.xConnection.count, 1);
  assert.equal(storage.state.xConnection.newestAt, targetNew.timestamp);
  assert.equal(aiCalls, 1);
  assert.equal(mailCalls, 0);
  assert.equal(storage.state.posts.length, 1);
  assert.equal(storage.state.posts[0].analysisStatus, 'complete');
  assert.equal(storage.state.posts[0].analysis.historicalBaseline, true);
  assert.equal(storage.state.events.length, 0);
});

test('an unseen post below the high-water mark is historical, not fresh', async () => {
  const storage = fakeStorage();
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '300';
  storage.state.highWaterId = '300';
  storage.state.seenIds = ['300'];
  let aiCalls = 0;
  let mailCalls = 0;
  const monitor = new MonitorService({
    storage,
    source: {
      async fetchLatest() {
        return [samplePost('300'), samplePost('100', { timestamp: '2026-07-26T09:00:00.000Z' })];
      },
      async close() {},
    },
    ai: { async classify() { aiCalls += 1; return { events: [] }; } },
    mailer: { async sendEvent() { mailCalls += 1; return {}; } },
  });

  const result = await monitor.checkNow('test');

  assert.equal(result.freshCount, 0);
  assert.equal(aiCalls, 0);
  assert.equal(mailCalls, 0);
  assert.deepEqual(storage.state.posts, []);
});

test('one unordered batch is analyzed oldest-first with past-only context and one lifecycle mail per type', async () => {
  const storage = fakeStorage();
  storage.settings.mail.enabled = true;
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '300';
  storage.state.highWaterId = '300';
  storage.state.seenIds = ['300'];
  const announced = samplePost('301', {
    text: 'We will reset usage limits soon.',
    timestamp: '2026-07-28T10:01:00.000Z',
  });
  const completed = samplePost('302', {
    text: 'Usage limits have been reset.',
    timestamp: '2026-07-28T10:02:00.000Z',
  });
  const repeatedCompletion = samplePost('303', {
    text: 'Usage limits were reset again.',
    timestamp: '2026-07-28T10:03:00.000Z',
  });
  const calls = [];
  const contexts = new Map();
  const mailOrder = [];
  const monitor = new MonitorService({
    storage,
    source: { async fetchLatest() { return [repeatedCompletion, announced, completed]; }, async close() {} },
    ai: {
      async classify(post, context) {
        calls.push(post.id);
        contexts.set(post.id, context.map((item) => item.id));
        if (post.id === '301') {
          return { events: [{ type: 'reset_announced', confidence: 0.99, explicit: true, evidence: ['reset usage limits'], summary: '即将重置' }] };
        }
        return { events: [{ type: 'reset_completed', confidence: 0.99, explicit: true, evidence: ['limits have been reset', 'limits were reset again'].filter((part) => post.text.toLowerCase().includes(part)), summary: '已经重置' }] };
      },
    },
    mailer: { async sendEvent(event) { mailOrder.push(event.postId); return { messageId: event.id }; } },
    now: () => Date.parse('2026-07-28T10:04:00.000Z'),
  });

  const result = await monitor.checkNow('test');

  assert.deepEqual(calls, ['301', '302', '303']);
  assert.deepEqual(contexts.get('301'), []);
  assert.deepEqual(contexts.get('302'), ['301']);
  assert.deepEqual(contexts.get('303'), ['301', '302']);
  assert.deepEqual(mailOrder, ['301', '302']);
  assert.equal(result.freshCount, 3);
  assert.equal(result.newEventCount, 2);
  assert.equal(result.sentCount, 2);
  assert.equal(storage.state.lifecycle.status, 'completed');
  assert.deepEqual(storage.state.posts.map((item) => item.post.id), ['303', '302', '301']);
  assert.deepEqual(storage.state.events.map((event) => event.postId), ['302', '301']);
});

test('the two observed reset posts pass the direct-evidence gate while a hallucinated reply does not', async () => {
  const storage = fakeStorage();
  storage.settings.mail.enabled = true;
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '2081899343091843462';
  storage.state.highWaterId = '2081899343091843462';
  storage.state.seenIds = ['2081899343091843462'];
  const announced = samplePost('2081899343091843463', {
    text: '我们正在庆祝 ChatGPT Work 的快速采用。我感觉像是限额重置了。几个小时后我回到笔记本电脑前再见！',
    timestamp: '2026-07-28T02:45:00.000Z',
  });
  const ambiguousReply = samplePost('2081939918818025982', {
    text: '也许',
    timestamp: '2026-07-28T03:08:51.000Z',
  });
  const completed = samplePost('2081940052154933696', {
    text: '回到笔记本电脑前。Codex 和 ChatGPT Work 的所有付费用户的用量限制已经重置。真是个好日子！',
    timestamp: '2026-07-28T03:09:23.000Z',
  });
  const mailOrder = [];
  const monitor = new MonitorService({
    storage,
    source: { async fetchLatest() { return [completed, ambiguousReply, announced]; }, async close() {} },
    ai: {
      async classify(post) {
        if (post.id === announced.id) {
          return { events: [{ type: 'reset_announced', confidence: 0.85, explicit: false, evidence: ['限额重置'], summary: '准备重置' }] };
        }
        return { events: [{ type: 'reset_completed', confidence: 0.99, explicit: true, evidence: ['用量限制已经重置'], summary: '已经重置' }] };
      },
    },
    mailer: { async sendEvent(event) { mailOrder.push(event.postId); return { messageId: event.id }; } },
    now: () => Date.parse('2026-07-28T03:10:00.000Z'),
  });

  const result = await monitor.checkNow('test');

  assert.equal(result.freshCount, 3);
  assert.equal(result.newEventCount, 2);
  assert.deepEqual(mailOrder, [announced.id, completed.id]);
  assert.deepEqual(storage.state.events.map((event) => event.postId), [completed.id, announced.id]);
  assert.equal(storage.state.events.some((event) => event.postId === ambiguousReply.id), false);
});

test('a no-fresh poll analyzes a pending historical record without creating events or mail', async () => {
  const storage = fakeStorage();
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '500';
  storage.state.highWaterId = '500';
  storage.state.seenIds = ['500'];
  storage.state.posts = [{
    post: samplePost('400'),
    classifierVersion: 2,
    fetchedAt: '2026-07-28T09:00:00.000Z',
    analysisStatus: 'pending',
    analysisAttempts: 0,
    analysis: null,
  }];
  let aiCalls = 0;
  const monitor = new MonitorService({
    storage,
    source: { async fetchLatest() { return [samplePost('500')]; }, async close() {} },
    ai: { async classify() { aiCalls += 1; return { events: [] }; } },
    mailer: { async sendEvent() { throw new Error('mail must not run'); } },
  });

  const result = await monitor.checkNow('test');

  assert.equal(result.freshCount, 0);
  assert.equal(aiCalls, 1);
  assert.equal(storage.state.posts[0].analysisStatus, 'complete');
  assert.equal(storage.state.posts[0].analysis.historicalBaseline, true);
  assert.equal(storage.state.events.length, 0);
});

test('a new v2 post retries transient AI failures and creates exactly one event and notification', async () => {
  const storage = fakeStorage();
  storage.settings.mail.enabled = true;
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '100';
  storage.state.highWaterId = '100';
  storage.state.seenIds = ['100'];
  const post = samplePost('101', {
    text: 'We will reset usage limits soon.',
    timestamp: '2026-07-28T10:01:00.000Z',
  });
  let aiCalls = 0;
  let mailCalls = 0;
  const monitor = new MonitorService({
    storage,
    source: { async fetchLatest() { return [post]; }, async close() {} },
    ai: {
      async classify() {
        aiCalls += 1;
        if (aiCalls <= 2) throw new Error('temporary AI failure');
        return { events: [{
          type: 'reset_announced',
          confidence: 0.99,
          explicit: true,
          evidence: ['reset usage limits'],
          summary: '即将重置',
        }] };
      },
    },
    mailer: { async sendEvent() { mailCalls += 1; return { messageId: 'only-once' }; } },
    now: () => Date.parse('2026-07-28T10:05:00.000Z'),
  });

  const first = await monitor.checkNow('test');
  let record = storage.state.posts.find((item) => item.post.id === post.id);
  assert.equal(first.freshCount, 1);
  assert.equal(record.classifierVersion, 2);
  assert.equal(record.analysisStatus, 'error');
  assert.equal(record.analysisAttempts, 1);
  assert.ok(record.nextAnalysisAttemptAt);

  record.nextAnalysisAttemptAt = '2000-01-01T00:00:00.000Z';
  const second = await monitor.checkNow('test');
  record = storage.state.posts.find((item) => item.post.id === post.id);
  assert.equal(second.freshCount, 0);
  assert.equal(record.analysisStatus, 'error');
  assert.equal(record.analysisAttempts, 2);

  record.nextAnalysisAttemptAt = '2000-01-01T00:00:00.000Z';
  const third = await monitor.checkNow('test');
  const fourth = await monitor.checkNow('test');
  record = storage.state.posts.find((item) => item.post.id === post.id);

  assert.equal(third.freshCount, 0);
  assert.equal(third.newEventCount, 1);
  assert.equal(third.sentCount, 1);
  assert.equal(fourth.newEventCount, 0);
  assert.equal(record.analysisStatus, 'complete');
  assert.equal(record.analysisAttempts, 3);
  assert.equal(record.nextAnalysisAttemptAt, null);
  assert.equal(aiCalls, 3);
  assert.equal(mailCalls, 1);
  assert.equal(storage.state.events.length, 1);
  assert.equal(storage.state.notifications.length, 1);
});

test('classifier v2 migration supersedes unsent v1 outbox rows and re-baselines without replay', async () => {
  const storage = fakeStorage();
  storage.settings.app.monitoringEnabled = true;
  storage.settings.mail.enabled = true;
  storage.state.schemaVersion = 1;
  storage.state.classifierVersion = 1;
  storage.state.baselineEstablished = true;
  storage.state.seenIds = ['700'];
  const post = samplePost('700', { text: 'Usage limits have been reset.' });
  const foreignPost = samplePost('699', {
    text: 'Maybe something unrelated',
    url: 'https://x.com/another_user/status/699',
    authorHandle: 'another_user',
  });
  storage.state.posts = [
    { post, analysisStatus: 'complete', analysisAttempts: 1, analysis: { id: 'ana_v1' } },
    { post: foreignPost, analysisStatus: 'complete', analysisAttempts: 1, analysis: { id: 'ana_bad' } },
  ];
  storage.state.events = [{
    id: 'evt_v1',
    postId: post.id,
    type: 'reset_completed',
    evidence: ['limits have been reset'],
    notificationStatus: 'failed',
  }, {
    id: 'evt_bad',
    postId: foreignPost.id,
    type: 'reset_completed',
    evidence: ['limits have been reset'],
    notificationStatus: 'failed',
  }];
  storage.state.notifications = [
    { id: 'mail_v1', eventId: 'evt_v1', postId: post.id, status: 'failed', attempts: 3, nextAttemptAt: null },
    { id: 'mail_bad', eventId: 'evt_bad', postId: foreignPost.id, status: 'failed', attempts: 3, nextAttemptAt: null },
  ];
  let aiCalls = 0;
  let mailCalls = 0;
  const monitor = new MonitorService({
    storage,
    source: { async fetchLatest() { return [post]; }, async close() {} },
    ai: { async classify() { aiCalls += 1; return { events: [] }; } },
    mailer: { async sendEvent() { mailCalls += 1; return {}; } },
  });

  assert.equal(storage.state.events[0].validity, 'valid');
  assert.equal(storage.state.events[0].notificationStatus, 'superseded');
  assert.equal(Object.hasOwn(storage.state.events[0], 'supersededAt'), false);
  assert.ok(storage.state.events[0].notificationSupersededAt);
  assert.equal(storage.state.notifications[0].status, 'superseded');
  assert.deepEqual(storage.state.posts.map((record) => record.post.id), ['700']);
  assert.deepEqual(storage.state.events.map((event) => event.id), ['evt_v1']);
  assert.deepEqual(storage.state.notifications.map((notification) => notification.id), ['mail_v1']);
  assert.deepEqual(storage.state.legacyAudit.ignoredPostIds, ['699']);
  assert.deepEqual(storage.state.legacyAudit.supersededEventIds, ['evt_bad']);
  assert.deepEqual(storage.state.legacyAudit.discardedNotificationIds, ['mail_bad']);
  assert.equal(storage.state.lifecycle.status, 'completed');
  assert.equal(storage.state.baselineEstablished, false);

  const result = await monitor.checkNow('test');
  monitor.stop();

  assert.equal(result.freshCount, 0);
  assert.equal(result.retriedCount, 0);
  assert.equal(aiCalls, 0);
  assert.equal(mailCalls, 0);
  assert.equal(storage.state.highWaterId, '700');
});

test('actual v1 history migrates to two visible valid events with notification suppression kept separate', () => {
  const storage = fakeStorage();
  storage.state.schemaVersion = 1;
  storage.state.classifierVersion = 1;
  const announced = samplePost('2081899343091843463', {
    text: '我们正在庆祝 ChatGPT Work 的快速采用。我感觉像是限额重置了。几个小时后见！',
    timestamp: '2026-07-28T00:27:37.000Z',
  });
  const falseReply = samplePost('2081939918818025982', {
    text: '也许',
    timestamp: '2026-07-28T03:08:51.000Z',
  });
  const completed = samplePost('2081940052154933696', {
    text: 'Codex 和 ChatGPT Work 的所有付费用户的用量限制已经重置。',
    timestamp: '2026-07-28T03:09:23.000Z',
  });
  storage.state.posts = [announced, falseReply, completed].map((post) => ({
    post,
    analysisStatus: 'complete',
    analysisAttempts: 1,
    analysis: { id: `ana_${post.id}` },
  }));
  storage.state.events = [{
    id: 'evt_announced',
    postId: announced.id,
    type: 'reset_announced',
    evidence: ['限额重置'],
    notificationStatus: 'sent',
  }, {
    id: 'evt_false',
    postId: falseReply.id,
    type: 'reset_completed',
    evidence: ['用量限制已经重置'],
    notificationStatus: 'sent',
  }, {
    id: 'evt_completed',
    postId: completed.id,
    type: 'reset_completed',
    evidence: ['用量限制已经重置'],
    notificationStatus: 'failed',
  }];
  storage.state.notifications = [{ id: 'mail_announced', eventId: 'evt_announced', postId: announced.id, status: 'sent' },
    { id: 'mail_false', eventId: 'evt_false', postId: falseReply.id, status: 'sent' },
    { id: 'mail_completed', eventId: 'evt_completed', postId: completed.id, status: 'failed' }];

  new MonitorService({ storage, source: { async close() {} }, ai: {}, mailer: {} });

  assert.deepEqual(storage.state.posts.map((record) => record.post.id), [completed.id, announced.id]);
  assert.deepEqual(storage.state.events.map((event) => event.id), ['evt_completed', 'evt_announced']);
  assert.equal(storage.state.events.every((event) => event.validity === 'valid'), true);
  const completedEvent = storage.state.events.find((event) => event.id === 'evt_completed');
  assert.equal(completedEvent.notificationStatus, 'superseded');
  assert.ok(completedEvent.notificationSupersededAt);
  assert.equal(Object.hasOwn(completedEvent, 'supersededAt'), false);
  assert.equal(storage.state.events.find((event) => event.id === 'evt_announced').notificationStatus, 'sent');
  assert.deepEqual(storage.state.legacyAudit.supersededEventIds, ['evt_false']);
  assert.equal(storage.state.lifecycle.status, 'completed');
});

test('prefetch outbox delivery publishes counters even when the X profile is busy', async () => {
  const storage = fakeStorage();
  storage.settings.app.monitoringEnabled = true;
  storage.settings.mail.enabled = true;
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '200';
  storage.state.highWaterId = '200';
  storage.state.seenIds = ['200'];
  const post = samplePost('150');
  storage.state.posts = [{ post, analysisStatus: 'complete', analysisAttempts: 1, analysis: { id: 'ana_150' } }];
  storage.state.events = [{ id: 'evt_150', postId: post.id, type: 'reset_completed', notificationStatus: 'pending' }];
  storage.state.notifications = [{ id: 'mail_150', eventId: 'evt_150', postId: post.id, status: 'pending', attempts: 0 }];
  const monitor = new MonitorService({
    storage,
    source: {
      async fetchLatest() { throw Object.assign(new Error('profile busy'), { code: 'X_FIREFOX_PROFILE_IN_USE' }); },
      async close() {},
    },
    ai: { async classify() { throw new Error('AI must not run'); } },
    mailer: { async sendEvent() { return { messageId: 'recovered-before-fetch' }; } },
  });

  const result = await monitor.checkNow('test');
  monitor.stop();

  assert.equal(result.skipped, true);
  assert.equal(result.retriedCount, 1);
  assert.equal(result.sentCount, 1);
  assert.equal(monitor.snapshot().runtime.retriedCount, 1);
  assert.equal(monitor.snapshot().runtime.sentCount, 1);
  assert.equal(storage.state.pollRuns[0].retriedCount, 1);
  assert.equal(storage.state.pollRuns[0].sentCount, 1);
});

test('one SMTP authentication failure opens a per-poll retry circuit', async () => {
  const storage = fakeStorage();
  storage.settings.app.monitoringEnabled = true;
  storage.settings.mail.enabled = true;
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '900';
  storage.state.highWaterId = '900';
  storage.state.seenIds = ['900'];
  for (const postId of ['800', '801']) {
    const post = samplePost(postId);
    const eventId = `evt_${postId}`;
    storage.state.posts.push({ post, analysisStatus: 'complete', analysisAttempts: 1, analysis: { id: `ana_${postId}` } });
    storage.state.events.push({ id: eventId, postId, type: 'reset_completed', notificationStatus: 'pending' });
    storage.state.notifications.push({ id: `mail_${postId}`, eventId, postId, status: 'pending', attempts: 1, nextAttemptAt: null });
  }
  const mailOrder = [];
  const monitor = new MonitorService({
    storage,
    source: { async fetchLatest() { return [samplePost('900')]; }, async close() {} },
    ai: { async classify() { throw new Error('AI must not run'); } },
    mailer: {
      async sendEvent(event) {
        mailOrder.push(event.postId);
        throw Object.assign(new Error('535 Invalid login'), { code: 'EAUTH', responseCode: 535 });
      },
    },
  });

  const result = await monitor.checkNow('test');
  monitor.stop();

  assert.deepEqual(mailOrder, ['800']);
  assert.equal(result.retriedCount, 1);
  assert.equal(result.sentCount, 0);
  assert.equal(storage.state.notifications.find((item) => item.postId === '800').status, 'failed');
  assert.equal(storage.state.notifications.find((item) => item.postId === '801').status, 'pending');
});

test('source contention is skipped without changing connection state or running AI/mail', async () => {
  const storage = fakeStorage();
  storage.state.baselineEstablished = true;
  storage.state.xConnection = {
    ...storage.state.xConnection,
    status: 'connected',
    checkedAt: '2026-07-28T08:00:00.000Z',
    handle: '@thsottiaux',
    browser: 'Mozilla Firefox',
  };
  const connectionBefore = clone(storage.state.xConnection);
  let aiCalls = 0;
  let mailCalls = 0;
  const monitor = new MonitorService({
    storage,
    source: {
      async fetchLatest() {
        throw Object.assign(new Error('X is already testing login'), { code: 'X_BUSY' });
      },
      async close() {},
    },
    ai: { async classify() { aiCalls += 1; return { events: [] }; } },
    mailer: { async sendEvent() { mailCalls += 1; return {}; } },
  });

  const result = await monitor.checkNow('timer');

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.code, 'X_BUSY');
  assert.equal(storage.state.pollRuns[0].outcome, 'skipped');
  assert.equal(storage.state.pollRuns[0].skipReason, 'source_busy');
  assert.deepEqual(storage.state.xConnection, connectionBefore);
  assert.equal(monitor.status.lastError, null);
  assert.equal(aiCalls, 0);
  assert.equal(mailCalls, 0);
});

test('an existing-profile fetch records the last released browser label', async () => {
  const storage = fakeStorage();
  const source = {
    browserLabel: null,
    lastBrowserLabel: 'Mozilla Firefox',
    async fetchLatest() { return [samplePost('1601')]; },
    async close() {},
  };
  const monitor = new MonitorService({
    storage,
    source,
    ai: { async classify() { return { events: [] }; } },
    mailer: { async sendEvent() { return {}; } },
  });

  await monitor.checkNow('test');

  assert.equal(storage.state.xConnection.status, 'connected');
  assert.equal(storage.state.xConnection.browser, 'Mozilla Firefox');
});

test('mail outbox is durable before send, retries a failure, and does not resend success', async () => {
  const storage = fakeStorage();
  storage.settings.app.monitoringEnabled = true;
  storage.settings.mail.enabled = true;
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '1200';
  storage.state.highWaterId = '1200';
  let aiCalls = 0;
  let mailCalls = 0;
  const post = samplePost('1201');
  const source = { async fetchLatest() { return [post]; }, async close() {} };
  const ai = {
    async classify() {
      aiCalls += 1;
      return {
        translation_zh: '旧账户的帖子，内容是重置限额。',
        events: [{
          type: 'reset_announced',
          confidence: 0.99,
          explicit: true,
          effective_at: null,
          summary: 'Reset soon',
          evidence: ['resetting limits'],
          reason: 'explicit',
        }],
      };
    },
  };
  const mailer = {
    async sendEvent() {
      mailCalls += 1;
      const durable = storage.savedStates.at(-1).notifications[0];
      assert.equal(durable.status, 'sending');
      assert.equal(durable.attempts, mailCalls);
      if (mailCalls === 1) throw new Error('temporary SMTP failure');
      return { messageId: 'smtp-ok' };
    },
  };
  const monitor = new MonitorService({ storage, source, ai, mailer });

  await monitor.checkNow('test');
  assert.equal(aiCalls, 1);
  assert.equal(mailCalls, 1);
  assert.equal(storage.state.events[0].notificationStatus, 'failed');
  assert.equal(storage.state.events[0].translationZh, '旧账户的帖子，内容是重置限额。');
  assert.equal(storage.state.notifications[0].status, 'failed');
  assert.equal(storage.state.notifications[0].attempts, 1);

  storage.state.notifications[0].nextAttemptAt = '2000-01-01T00:00:00.000Z';
  await monitor.checkNow('test');
  assert.equal(aiCalls, 1);
  assert.equal(mailCalls, 2);
  assert.equal(storage.state.events[0].notificationStatus, 'sent');
  assert.equal(storage.state.notifications[0].status, 'sent');
  assert.equal(storage.state.notifications[0].attempts, 2);
  assert.equal(storage.state.notifications[0].messageId, 'smtp-ok');

  await monitor.checkNow('test');
  assert.equal(aiCalls, 1);
  assert.equal(mailCalls, 2);
  monitor.stop();
});

test('a persisted pending event without an outbox row is recovered without re-running AI', async () => {
  const storage = fakeStorage();
  storage.settings.app.monitoringEnabled = true;
  storage.settings.mail.enabled = true;
  storage.state.baselineEstablished = true;
  const post = samplePost('1301');
  storage.state.seenIds = [post.id];
  storage.state.posts = [{
    post,
    fetchedAt: '2026-07-28T09:00:00.000Z',
    analysisStatus: 'complete',
    analysisAttempts: 1,
    analysis: { id: 'ana_old' },
  }];
  storage.state.events = [{
    id: 'evt_old',
    fingerprint: `${post.id}:reset_announced`,
    postId: post.id,
    type: 'reset_announced',
    notificationStatus: 'pending',
  }];
  let aiCalls = 0;
  let mailCalls = 0;
  const monitor = new MonitorService({
    storage,
    source: { async fetchLatest() { return [post]; }, async close() {} },
    ai: { async classify() { aiCalls += 1; return { events: [] }; } },
    mailer: {
      async sendEvent() {
        mailCalls += 1;
        assert.equal(storage.savedStates.at(-1).notifications[0].status, 'sending');
        return { messageId: 'recovered' };
      },
    },
  });

  await monitor.checkNow('test');
  assert.equal(aiCalls, 0);
  assert.equal(mailCalls, 1);
  assert.equal(storage.state.events[0].notificationStatus, 'sent');
  assert.equal(storage.state.notifications[0].status, 'sent');
  monitor.stop();
});

for (const persistedStatus of ['pending', 'error', 'sending']) {
  test(`a persisted ${persistedStatus} outbox row is retried after restart`, async () => {
    const storage = fakeStorage();
    storage.settings.app.monitoringEnabled = true;
    storage.settings.mail.enabled = true;
    storage.state.baselineEstablished = true;
    const post = samplePost(`14${persistedStatus.length}`);
    storage.state.seenIds = [post.id];
    storage.state.posts = [{
      post,
      fetchedAt: '2026-07-28T09:00:00.000Z',
      analysisStatus: 'complete',
      analysisAttempts: 1,
      analysis: { id: 'ana_old' },
    }];
    storage.state.events = [{ id: 'evt_old', postId: post.id, notificationStatus: 'pending' }];
    storage.state.notifications = [{
      id: 'mail_old',
      eventId: 'evt_old',
      postId: post.id,
      status: persistedStatus,
      attempts: 1,
      nextAttemptAt: null,
    }];
    let mailCalls = 0;
    const monitor = new MonitorService({
      storage,
      source: { async fetchLatest() { return [post]; }, async close() {} },
      ai: { async classify() { throw new Error('AI must not run'); } },
      mailer: { async sendEvent() { mailCalls += 1; return { messageId: 'retry-ok' }; } },
    });

    await monitor.checkNow('test');
    assert.equal(mailCalls, 1);
    assert.equal(storage.state.notifications[0].status, 'sent');
    assert.equal(storage.state.notifications[0].attempts, 2);
    monitor.stop();
  });
}

test('a manual check does not retry old outbox rows while monitoring is disabled', async () => {
  const storage = fakeStorage();
  storage.settings.mail.enabled = true;
  storage.state.baselineEstablished = true;
  const post = samplePost('1499');
  storage.state.seenIds = [post.id];
  storage.state.posts = [{
    post,
    fetchedAt: '2026-07-28T09:00:00.000Z',
    analysisStatus: 'complete',
    analysisAttempts: 1,
    analysis: { id: 'ana_disabled' },
  }];
  storage.state.events = [{ id: 'evt_disabled', postId: post.id, notificationStatus: 'failed' }];
  storage.state.notifications = [{
    id: 'mail_disabled',
    eventId: 'evt_disabled',
    postId: post.id,
    status: 'failed',
    attempts: 1,
    nextAttemptAt: null,
  }];
  let mailCalls = 0;
  const monitor = new MonitorService({
    storage,
    source: { async fetchLatest() { return [post]; }, async close() {} },
    ai: { async classify() { throw new Error('AI must not run'); } },
    mailer: { async sendEvent() { mailCalls += 1; return {}; } },
  });

  await monitor.checkNow('manual');

  assert.equal(mailCalls, 0);
  assert.equal(storage.state.notifications[0].status, 'failed');
});

test('durable outbox retries before a profile-busy fetch when monitoring is enabled', async () => {
  const storage = fakeStorage();
  storage.settings.app.monitoringEnabled = true;
  storage.settings.mail.enabled = true;
  storage.state.baselineEstablished = true;
  const persistedStatuses = ['pending', 'error', 'sending'];
  const order = [];
  for (let index = 0; index < persistedStatuses.length; index += 1) {
    const post = samplePost(`17${index}`);
    const eventId = `evt_${index}`;
    storage.state.posts.push({
      post,
      fetchedAt: '2026-07-28T09:00:00.000Z',
      analysisStatus: 'complete',
      analysisAttempts: 1,
      analysis: { id: `ana_${index}` },
    });
    storage.state.events.push({ id: eventId, postId: post.id, notificationStatus: 'pending' });
    storage.state.notifications.push({
      id: `mail_${index}`,
      eventId,
      postId: post.id,
      status: persistedStatuses[index],
      attempts: 1,
      nextAttemptAt: null,
    });
  }
  let aiCalls = 0;
  const monitor = new MonitorService({
    storage,
    source: {
      async fetchLatest() {
        order.push('fetch');
        throw Object.assign(new Error('Firefox profile in use'), { code: 'X_FIREFOX_PROFILE_IN_USE' });
      },
      async close() {},
    },
    ai: { async classify() { aiCalls += 1; return { events: [] }; } },
    mailer: {
      async sendEvent(event) {
        order.push(`mail:${event.id}`);
        return { messageId: `sent:${event.id}` };
      },
    },
  });

  const result = await monitor.checkNow('timer');
  monitor.stop();

  assert.equal(result.skipped, true);
  assert.equal(result.code, 'X_FIREFOX_PROFILE_IN_USE');
  assert.equal(aiCalls, 0);
  assert.deepEqual(order, ['mail:evt_0', 'mail:evt_1', 'mail:evt_2', 'fetch']);
  assert.deepEqual(storage.state.notifications.map((item) => item.status), ['sent', 'sent', 'sent']);
  assert.deepEqual(storage.state.notifications.map((item) => item.attempts), [2, 2, 2]);
});

test('close waits for an in-flight AI/mail round and prevents rescheduling', async () => {
  const storage = fakeStorage();
  storage.settings.mail.enabled = true;
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '1500';
  storage.state.highWaterId = '1500';
  const sending = deferred();
  const finishSend = deferred();
  let sourceCloseCalls = 0;
  const monitor = new MonitorService({
    storage,
    source: {
      async fetchLatest() { return [samplePost('1501')]; },
      async close() { sourceCloseCalls += 1; },
    },
    ai: {
      async classify() {
        return {
          events: [{
            type: 'reset_completed',
            confidence: 0.99,
            explicit: true,
            effective_at: null,
            summary: 'Done',
            evidence: ['resetting limits'],
            reason: 'explicit',
          }],
        };
      },
    },
    mailer: {
      async sendEvent() {
        sending.resolve();
        await finishSend.promise;
        return { messageId: 'done' };
      },
    },
  });

  const checking = monitor.checkNow('test');
  await sending.promise;
  let closed = false;
  const closing = monitor.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.equal(sourceCloseCalls, 0);

  finishSend.resolve();
  await checking;
  await closing;
  assert.equal(closed, true);
  assert.equal(sourceCloseCalls, 1);
  assert.equal(monitor.timer, null);
  assert.equal(monitor.status.phase, 'paused');
  const afterClose = await monitor.checkNow('manual');
  assert.equal(afterClose.code, 'MONITOR_CLOSING');
});

test('a failed owned-browser close can be cancelled or retried without losing cleanup state', async () => {
  const storage = fakeStorage();
  let closeCalls = 0;
  const source = {
    async close() {
      closeCalls += 1;
      if (closeCalls === 1) {
        throw Object.assign(new Error('owned Firefox did not exit'), { code: 'X_FIREFOX_PROCESS_CLOSE_FAILED' });
      }
    },
  };
  const monitor = new MonitorService({ storage, source, ai: {}, mailer: {} });

  await assert.rejects(
    monitor.close(),
    (error) => error.code === 'X_FIREFOX_PROCESS_CLOSE_FAILED',
  );
  assert.equal(monitor.closing, true);
  assert.equal(monitor.closePromise, null);
  assert.equal(monitor.cancelClose(), true);
  assert.equal(monitor.closing, false);

  await monitor.close();
  assert.equal(closeCalls, 2);
  assert.equal(monitor.closing, true);
  assert.equal(monitor.closePromise, null);
});
