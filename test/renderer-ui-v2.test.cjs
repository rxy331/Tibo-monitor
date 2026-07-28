'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  alertHistoryView,
  clampPollInterval,
  eventNotificationLabel,
  formatPollResult,
  isExcludedPost,
  isSupersededEvent,
  pollCounts,
  pollDisplaySource,
  sortNewestFirst,
} = require('../src/renderer/app.js');

const ROOT = path.resolve(__dirname, '..');

test('renderer defensively sorts tweetAt, eventAt, and createdAt newest first', () => {
  const items = [
    { id: 'created', createdAt: '2026-07-28T09:00:00.000Z' },
    { id: 'tweet', tweetAt: '2026-07-28T11:00:00.000Z', createdAt: '2026-07-28T01:00:00.000Z' },
    { id: 'event', eventAt: '2026-07-28T10:00:00.000Z' },
    { id: 'invalid', createdAt: 'not-a-date' },
  ];
  assert.deepEqual(sortNewestFirst(items).map((item) => item.id), ['tweet', 'event', 'created', 'invalid']);
  assert.deepEqual(items.map((item) => item.id), ['created', 'tweet', 'event', 'invalid'], 'renderer sort must not mutate snapshot arrays');
});

test('poll copy distinguishes all four counters and names zero-fresh sends as historical retries', () => {
  const retry = { freshCount: 0, newEventCount: 0, retriedCount: 3, sentCount: 2 };
  assert.deepEqual(pollCounts(retry), retry);
  assert.equal(formatPollResult(retry), '无新帖，补发 2 封历史提醒；新信号 0 条，历史重试 3 封。');
  assert.doesNotMatch(formatPollResult(retry), /新提醒/);

  const fresh = formatPollResult({ freshCount: 4, newEventCount: 1, retriedCount: 2, sentCount: 3 });
  assert.match(fresh, /新帖 4 条/);
  assert.match(fresh, /新信号 1 条/);
  assert.match(fresh, /历史重试 2 封/);
  assert.match(fresh, /已发送 3 封/);
});

test('failed and profile-busy polls render all four counters from snapshot runtime', () => {
  const staleFailureResponse = { ok: false, freshCount: 0, newEventCount: 0, retriedCount: 0, sentCount: 0 };
  const fetchFailureSnapshot = {
    runtime: { freshCount: 0, newEventCount: 0, retriedCount: 3, sentCount: 2 },
  };
  assert.deepEqual(
    pollCounts(pollDisplaySource(fetchFailureSnapshot, staleFailureResponse)),
    { freshCount: 0, newEventCount: 0, retriedCount: 3, sentCount: 2 },
  );

  const profileBusySnapshot = {
    runtime: { freshCount: 0, newEventCount: 0, retriedCount: 4, sentCount: 1 },
  };
  assert.deepEqual(
    pollCounts(pollDisplaySource(profileBusySnapshot, { ok: false, code: 'X_FIREFOX_PROFILE_IN_USE' })),
    { freshCount: 0, newEventCount: 0, retriedCount: 4, sentCount: 1 },
  );
});

test('poll interval is clamped to the supported 5 to 30 minute UI range', () => {
  assert.equal(clampPollInterval(60), 30);
  assert.equal(clampPollInterval('30'), 30);
  assert.equal(clampPollInterval(0), 5);
  assert.equal(clampPollInterval('not-a-number'), 15);
});

test('reply and pure-retweet controls and payload fields are absent while policy remains visible', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  assert.doesNotMatch(html, /id=["']include-replies["']/);
  assert.doesNotMatch(html, /id=["']include-retweets["']/);
  assert.doesNotMatch(appSource, /includeReplies/);
  assert.doesNotMatch(appSource, /includeRetweets/);
  assert.match(html, /回复与纯转推始终排除，只分析 Tibo 本人原创帖/);
  assert.match(html, /每轮只分析最近30分钟原创帖/);
  assert.match(html, /id="poll-interval"[^>]*min="5"[^>]*max="30"/);
});

test('actual migration shape keeps both valid positives visible and supersedes only old mail', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  const completed = {
    id: 'evt_completed',
    type: 'reset_completed',
    confidence: 1,
    validity: 'valid',
    classifierVersion: 1,
    notificationStatus: 'superseded',
    supersededAt: '2026-07-28T15:27:45.932Z',
    supersededReason: 'classifier_v2_migration',
    createdAt: '2026-07-28T13:45:15.639Z',
  };
  const announced = {
    id: 'evt_announced',
    type: 'reset_announced',
    confidence: 0.85,
    validity: 'valid',
    classifierVersion: 1,
    notificationStatus: 'sent',
    createdAt: '2026-07-28T14:15:17.440Z',
  };
  const oldFalsePositive = {
    id: 'evt_bad',
    type: 'reset_announced',
    validity: 'superseded',
    notificationStatus: 'superseded',
    supersededAt: '2026-07-28T15:27:45.932Z',
  };
  const view = alertHistoryView(
    [completed, announced, oldFalsePositive],
    { supersededEventIds: ['evt_bad', 'evt_completed'] },
  );

  assert.deepEqual(view.events.map((event) => event.id), ['evt_announced', 'evt_completed']);
  assert.equal(view.hiddenCount, 1, 'a valid event must not be counted as a hidden false positive');
  assert.equal(isSupersededEvent(completed), false, 'validity=valid takes priority over migration supersededAt');
  assert.equal(eventNotificationLabel(completed), '旧版邮件已停止重试');
  assert.equal(eventNotificationLabel({ notificationSupersededAt: completed.supersededAt, notificationStatus: 'failed' }), '旧版邮件已停止重试');
  assert.equal(eventNotificationLabel({ notificationStatus: 'superseded', needsHumanReview: true }), '旧版邮件已停止重试');
  assert.match(appSource, /isSupersededEvent/);
  assert.match(appSource, /已隐藏.*旧版误判/);
  assert.match(appSource, /已废弃且不会重发/);
  assert.doesNotMatch(appSource, /已废弃 · 不再发送/);
  assert.match(html, /id="alerts-audit-summary"/);
  assert.equal(isSupersededEvent({ status: 'superseded' }), true);
  assert.equal(isSupersededEvent({ supersededAt: '2026-07-28T00:00:00Z' }), true);
  assert.equal(isSupersededEvent({ validity: 'valid', status: 'superseded', supersededAt: completed.supersededAt, notificationStatus: 'superseded' }), false);
  assert.equal(isSupersededEvent({ notificationSupersededAt: completed.supersededAt, notificationStatus: 'superseded' }), false);
  assert.equal(isSupersededEvent({ validity: 'valid', notificationStatus: 'sent' }), false);
  assert.equal(isExcludedPost({ post: { ignored: true } }), true);
  assert.equal(isExcludedPost({ excludedReason: 'reply' }), true);
  assert.equal(isExcludedPost({ post: { text: 'valid' } }), false);
});
