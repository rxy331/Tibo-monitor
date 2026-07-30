'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, DEFAULT_STATE } = require('../src/lib/defaults.cjs');
const { DeepSeekClient } = require('../src/lib/deepseek.cjs');
const { MonitorService } = require('../src/lib/monitor.cjs');
const { sanitizeSettings } = require('../src/lib/utils.cjs');

function fakeStorage() {
  const storage = {
    settings: structuredClone(DEFAULT_SETTINGS),
    state: structuredClone(DEFAULT_STATE),
    getPublicSnapshot() {
      return { settings: this.settings, state: this.state, secrets: {}, dataPath: 'test' };
    },
    saveSettings(next) { this.settings = next; },
    saveState() {},
    log() {},
  };
  storage.settings.app.acceptedXActionsRisk = true;
  storage.settings.app.monitoringEnabled = false;
  return storage;
}

function post(id, timestamp, fields = {}) {
  return {
    id: String(id),
    authorHandle: 'thsottiaux',
    text: 'We have reset the usage limits.',
    timestamp,
    url: `https://x.com/thsottiaux/status/${id}`,
    isReply: false,
    isRetweet: false,
    ...fields,
  };
}

function noneAi(counter = null) {
  return {
    async classify() {
      if (counter) counter.count += 1;
      return { translation_zh: '无关', events: [{ type: 'none', confidence: 0, evidence: [] }] };
    },
  };
}

test('new settings preserve reply analysis, replay windows, and independent Windows notifications', () => {
  const settings = sanitizeSettings({
    x: {
      includeReplies: true,
      startupReplayHours: 12,
      manualReplayHours: 24,
    },
    windowsNotification: { enabled: true },
  }, DEFAULT_SETTINGS);
  assert.equal(settings.schemaVersion, 5);
  assert.equal(settings.x.includeReplies, true);
  assert.equal(settings.x.startupReplayHours, 12);
  assert.equal(settings.x.manualReplayHours, 24);
  assert.equal(settings.windowsNotification.enabled, true);
  assert.equal(sanitizeSettings({ x: { startupReplayHours: 5, manualReplayHours: 99 } }, DEFAULT_SETTINGS).x.startupReplayHours, 0);
});

test('state v2 migrates without losing the original watermark or existing mail outbox identity', () => {
  const storage = fakeStorage();
  storage.state.schemaVersion = 2;
  storage.state.classifierVersion = 2;
  storage.state.baselineEstablished = true;
  storage.state.highWaterId = '123';
  storage.state.highWaterIds = { originals: null, replies: null };
  storage.state.events = [{ id: 'evt-1', postId: '123', notificationStatus: 'sent' }];
  storage.state.notifications = [{ id: 'mail-1', eventId: 'evt-1', postId: '123', status: 'sent' }];
  const monitor = new MonitorService({
    storage,
    source: { async close() {} },
    ai: noneAi(),
    mailer: {},
  });
  assert.equal(storage.state.schemaVersion, 3);
  assert.deepEqual(storage.state.highWaterIds, { originals: '123', replies: null });
  assert.equal(storage.state.notifications[0].channel, 'mail');
  assert.equal(storage.state.events[0].windowsNotificationStatus, 'not_selected');
  monitor.stop();
});

test('DeepSeek receives reply identity as metadata while current reply text remains the evidence source', async () => {
  const settings = structuredClone(DEFAULT_SETTINGS);
  const client = new DeepSeekClient({
    getSettings: () => settings,
    getApiKey: () => 'test-only',
    log: () => {},
  });
  let payload = null;
  client.request = async (messages) => {
    payload = JSON.parse(messages[1].content.split('\n').slice(1).join('\n'));
    return JSON.stringify({
      translation_zh: '回复文本',
      events: [{ type: 'none', confidence: 0, evidence: [], reason: '无信号' }],
    });
  };
  await client.classify(post('321', '2026-07-30T09:00:00.000Z', {
    text: 'A reply with no reset claim.',
    isReply: true,
    replyTo: ['openai', 'someone'],
  }));
  assert.equal(payload.current_post.is_reply, true);
  assert.deepEqual(payload.current_post.reply_to, ['openai', 'someone']);
  assert.equal(payload.current_post.text, 'A reply with no reset claim.');
});

test('manual replay analyzes an unseen reply below the original watermark and delivers both channels once', async () => {
  const now = Date.parse('2026-07-30T10:00:00.000Z');
  const storage = fakeStorage();
  storage.settings.x.includeReplies = true;
  storage.settings.mail.enabled = true;
  storage.settings.windowsNotification.enabled = true;
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '500';
  storage.state.highWaterId = '500';
  storage.state.highWaterIds = { originals: '500', replies: '700' };
  const reply = post('450', '2026-07-30T08:00:00.000Z', {
    isReply: true,
    replyTo: ['openai'],
  });
  const fetchOptions = [];
  const source = {
    async fetchLatest(options) {
      fetchOptions.push(options);
      return {
        posts: [reply],
        observedHighWaterIds: { originals: '500', replies: '700' },
      };
    },
    async close() {},
  };
  const ai = {
    async classify(current) {
      assert.equal(current.isReply, true);
      assert.deepEqual(current.replyTo, ['openai']);
      return {
        translation_zh: '我们已经重置了用量限制。',
        events: [{
          type: 'reset_completed',
          confidence: 0.99,
          explicit: true,
          effective_at: null,
          summary: '额度已重置',
          evidence: ['reset the usage limits'],
          reason: '当前回复帖直接确认',
        }],
      };
    },
  };
  let mailCount = 0;
  let windowsCount = 0;
  const monitor = new MonitorService({
    storage,
    source,
    ai,
    mailer: { async sendEvent() { mailCount += 1; return { messageId: 'mail-1' }; } },
    windowsNotifier: { async show() { windowsCount += 1; return { ok: true }; } },
    now: () => now,
  });

  const first = await monitor.replayNow(6);
  const second = await monitor.replayNow(6);

  assert.equal(first.ok, true);
  assert.equal(first.replayMode, 'manual');
  assert.equal(first.replayCount, 1);
  assert.equal(second.replayCount, 0);
  assert.equal(fetchOptions[0].lookbackMinutes, 360);
  assert.equal(fetchOptions[0].limit, 100);
  assert.equal(fetchOptions[0].includeReplies, true);
  assert.equal(storage.state.events.length, 1);
  assert.equal(storage.state.events[0].notificationStatus, 'sent');
  assert.equal(storage.state.events[0].windowsNotificationStatus, 'shown');
  assert.deepEqual(new Set(storage.state.notifications.map((item) => item.channel)), new Set(['mail', 'windows']));
  assert.equal(mailCount, 1);
  assert.equal(windowsCount, 1);
  assert.equal(storage.state.replayRuns.length, 2);
  monitor.stop();
});

test('enabling replies establishes a separate reply watermark before treating later replies as fresh', async () => {
  const now = Date.parse('2026-07-30T10:00:00.000Z');
  const storage = fakeStorage();
  storage.settings.x.includeReplies = true;
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '500';
  storage.state.highWaterId = '500';
  storage.state.highWaterIds = { originals: '500', replies: null };
  const batches = [
    {
      posts: [post('600', '2026-07-30T09:55:00.000Z', { isReply: true })],
      observedHighWaterIds: { originals: '500', replies: '600' },
    },
    {
      posts: [post('601', '2026-07-30T09:56:00.000Z', { isReply: true })],
      observedHighWaterIds: { originals: '500', replies: '601' },
    },
  ];
  let index = 0;
  const aiCalls = { count: 0 };
  const monitor = new MonitorService({
    storage,
    source: { async fetchLatest() { return batches[index++]; }, async close() {} },
    ai: noneAi(aiCalls),
    mailer: { async sendEvent() { throw new Error('mail must not run'); } },
    now: () => now,
  });

  const first = await monitor.checkNow('reply-cutover');
  const second = await monitor.checkNow('reply-fresh');

  assert.equal(first.freshCount, 0);
  assert.equal(storage.state.highWaterIds.replies, '601');
  assert.equal(second.freshCount, 1);
  assert.equal(aiCalls.count, 1);
  assert.deepEqual(storage.state.posts.map((record) => record.post.id), ['601']);
  monitor.stop();
});

test('startup replay survives a failed fetch and is consumed after the first successful check only', async () => {
  const now = Date.parse('2026-07-30T10:00:00.000Z');
  const storage = fakeStorage();
  storage.settings.x.startupReplayHours = 3;
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '800';
  storage.state.highWaterId = '800';
  storage.state.highWaterIds = { originals: '800', replies: null };
  let attempt = 0;
  const oldPost = post('700', '2026-07-30T08:30:00.000Z');
  const monitor = new MonitorService({
    storage,
    source: {
      async fetchLatest() {
        attempt += 1;
        if (attempt === 1) throw Object.assign(new Error('temporary X failure'), { code: 'X_NETWORK_ERROR' });
        return { posts: attempt === 2 ? [oldPost] : [], observedHighWaterIds: { originals: '800', replies: null } };
      },
      async close() {},
    },
    ai: noneAi(),
    mailer: { async sendEvent() { throw new Error('mail must not run'); } },
    now: () => now,
  });

  const failed = await monitor.checkNow('startup');
  const replayed = await monitor.checkNow('startup-retry');
  const routine = await monitor.checkNow('routine');

  assert.equal(failed.ok, false);
  assert.equal(failed.replayMode, 'startup');
  assert.equal(replayed.ok, true);
  assert.equal(replayed.replayMode, 'startup');
  assert.equal(replayed.replayCount, 1);
  assert.equal(routine.replayMode, null);
  assert.equal(storage.state.replayRuns.length, 2);
  monitor.stop();
});
