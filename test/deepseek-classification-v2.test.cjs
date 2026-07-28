'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DeepSeekClient,
  isResetCandidateText,
  localTemporalType,
  validateClassification,
} = require('../src/lib/deepseek.cjs');
const { MonitorService } = require('../src/lib/monitor.cjs');

const ANNOUNCED_USER_FIXTURE = '我们正在庆祝 chatGPT Work 的快速采用，以及今天投入其中的所有令人难以置信的努力。我感觉像是限额重置了。 紧紧抓住你的 ultra 和 /fast，几个小时后我在笔记本电脑前回来时见！';
const COMPLETED_USER_FIXTURE = '回到笔记本电脑前。Codex 和 ChatGPT Work 的所有付费用户的用量限制已经重置。哇哦哦哦哦。真是个好日子！';

function post(text, id = 'fixture') {
  return {
    id,
    timestamp: '2026-07-28T10:00:00.000Z',
    text,
    url: `https://x.com/thsottiaux/status/${id}`,
    isQuote: false,
    isRetweet: false,
  };
}

function createClient(responseFactory) {
  let requestCount = 0;
  const client = new DeepSeekClient({
    getSettings: () => ({
      x: { handle: 'thsottiaux' },
      ai: { model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com', timeoutSeconds: 30, thinkingEnabled: false },
    }),
    getApiKey: () => 'test-only',
    log: () => {},
  });
  client.request = async (messages) => {
    requestCount += 1;
    return JSON.stringify(responseFactory(messages, requestCount));
  };
  return { client, requestCount: () => requestCount };
}

test('hedged future user fixture is announced with one current-post event', async () => {
  const { client, requestCount } = createClient(() => ({
    events: [{
      type: 'reset_announced',
      confidence: 0.94,
      explicit: false,
      summary: '即将重置用量限额',
      evidence: ['我感觉像是限额重置了', '几个小时后我在笔记本电脑前回来时见'],
      reason: '当前帖包含将来时；hedged 不改变 announced 类型',
    }],
    needs_human_review: false,
  }));
  const result = await client.analyze(post(ANNOUNCED_USER_FIXTURE, '101'));
  assert.equal(requestCount(), 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'reset_announced');
});

test('explicit completed user fixture requires paid/ChatGPT/Codex scope', async () => {
  const { client, requestCount } = createClient(() => ({
    events: [{
      type: 'reset_completed',
      confidence: 0.98,
      explicit: true,
      summary: '付费用户的 ChatGPT 用量限额已经重置',
      evidence: ['Codex 和 ChatGPT Work 的所有付费用户', '用量限制已经重置'],
      reason: '当前帖包含明确完成式与付费用户范围',
    }],
    needs_human_review: false,
  }));
  const result = await client.classify(post(COMPLETED_USER_FIXTURE, '102'));
  assert.equal(requestCount(), 1);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'reset_completed');
});

test('local candidate gate ignores unrelated and conversational fragments without API calls', async () => {
  const { client, requestCount } = createClient(() => assert.fail('candidate gate must skip the API'));
  for (const [index, text] of ['也许', '没错', '玩得开心', 'Have fun!', 'Maybe, sounds right.'].entries()) {
    const result = await client.classify(post(text, `20${index}`));
    assert.equal(result.events[0].type, 'none');
  }
  assert.equal(requestCount(), 0);
});

test('positive recent context can never prove an unrelated current post', async () => {
  const { client, requestCount } = createClient(() => assert.fail('context must not bypass the current-post gate'));
  const context = [post(COMPLETED_USER_FIXTURE, '300')];
  const result = await client.classify(post('没错，祝你玩得开心。', '301'), context, { status: 'completed' });
  assert.equal(result.events[0].type, 'none');
  assert.equal(requestCount(), 0);
});

test('generic reset words without an allowed temporal cue fail closed locally', async () => {
  const { client, requestCount } = createClient(() => assert.fail('generic cue must not reach the API'));
  const text = 'Usage limit reset information is available on the dashboard.';
  assert.equal(isResetCandidateText(text), true);
  assert.equal(localTemporalType(text), 'none');
  const result = await client.classify(post(text, '401'));
  assert.equal(result.events[0].type, 'none');
  assert.equal(requestCount(), 0);
});

test('invented or context-only evidence is rejected as none', async () => {
  const { client } = createClient(() => ({
    events: [{
      type: 'reset_announced',
      confidence: 0.99,
      explicit: true,
      summary: '伪造证据',
      evidence: ['I already reset every paid Codex account'],
      reason: 'not present in current_post',
    }],
    needs_human_review: false,
  }));
  const result = await client.classify(post('We will reset usage limits soon.', '501'));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'none');
});

test('local temporal type rejects completed for a future post and completed without scope', () => {
  const futureText = 'We will reset usage limits later.';
  const wrongType = validateClassification({
    events: [{ type: 'reset_completed', confidence: 1, explicit: true, evidence: ['reset usage limits'] }],
  }, futureText);
  assert.equal(wrongType.events[0].type, 'none');

  const noScope = 'Usage limits have been reset already.';
  assert.equal(localTemporalType(noScope), 'none');
  const result = validateClassification({
    events: [{ type: 'reset_completed', confidence: 1, explicit: true, evidence: ['Usage limits have been reset'] }],
  }, noScope);
  assert.equal(result.events[0].type, 'none');
});

test('future meaning wins and multiple model events collapse to one primary event', () => {
  const text = 'ChatGPT limits have been reset already, and we will reset usage limits later.';
  const result = validateClassification({
    events: [
      { type: 'reset_completed', confidence: 0.99, explicit: true, evidence: ['ChatGPT limits have been reset already'] },
      { type: 'reset_announced', confidence: 0.91, explicit: true, evidence: ['we will reset usage limits later'] },
      { type: 'reset_announced', confidence: 0.72, explicit: false, evidence: ['later'] },
    ],
    needs_human_review: false,
  }, text);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].type, 'reset_announced');
  assert.equal(result.events[0].confidence, 0.91);
});

test('human-review classification remains marked so notification policy can suppress it', () => {
  const text = 'I feel like we will reset usage limits soon.';
  const result = validateClassification({
    events: [{ type: 'reset_announced', confidence: 0.8, explicit: false, evidence: ['will reset usage limits soon'] }],
    needs_human_review: true,
  }, text);
  assert.equal(result.events[0].type, 'reset_announced');
  assert.equal(result.needs_human_review, true);

  const monitor = Object.create(MonitorService.prototype);
  monitor.storage = { settings: { ai: { announcedThreshold: 0.75, completedThreshold: 0.8 } } };
  assert.equal(monitor.shouldNotify({
    ...result.events[0],
    validity: 'valid',
    directEvidence: true,
    needsHumanReview: result.needs_human_review,
  }), false);
});
