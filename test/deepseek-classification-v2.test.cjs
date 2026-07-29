'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DeepSeekClient,
  validateClassification,
} = require('../src/lib/deepseek.cjs');
const { MonitorService } = require('../src/lib/monitor.cjs');

const ANNOUNCED_USER_FIXTURE = '我们正在庆祝 chatGPT Work 的快速采用，以及今天投入其中的所有令人难以置信的努力。我感觉像是限额重置了。 紧紧抓住你的 ultra 和 /fast，几个小时后我在笔记本电脑前回来时见！';
const COMPLETED_USER_FIXTURE = '回到笔记本电脑前。Codex 和 ChatGPT Work 的所有付费用户的用量限制已经重置。哇哦哦哦哦。真是个好日子！';
const ENGLISH_ANNOUNCED_FIXTURE = '10M!\n\nNew day, new usage reset for paid users of Codex and ChatGPT Work. Lands in the next hour. Enjoy.';
const ENGLISH_COMPLETED_FIXTURE = 'We have reset usage limits for all Codex and ChatGPT Work users.\n\nLast night around 2am to 4am we suffered an almost global outage. All well and recovered, but you know what comes next.\n\nWe learn. We reset. Enjoy.';
const MINUTES_ANNOUNCED_FIXTURE = 'Another reset for our Codex and ChatGPT Work users. Actually hit 9M active users way earlier today, but then got distracted by the approximately millions of things the team is doing to keep the systems up and reliable.\n\nShould have that sweet 100% weekly usage limit back in a few minutes. Go be your productive self and close twitter. Shoo!';
const RESET_QUESTION_FIXTURE = 'Embarrassment of riches. But looks like we might hit 9M soon. Should we reset the ChatGPT Work and Codex usage again or give it some space?';

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

test('English future reset fixture remains announced', async () => {
  const { client, requestCount } = createClient(() => ({
    events: [{
      type: 'reset_announced',
      confidence: 0.98,
      explicit: true,
      summary: '将在一小时内重置用量限额',
      evidence: ['Lands in the next hour'],
      reason: 'reset lands in the future',
    }],
    needs_human_review: false,
  }));
  const result = await client.classify(post(ENGLISH_ANNOUNCED_FIXTURE, '103'));
  assert.equal(requestCount(), 1);
  assert.equal(result.events[0].type, 'reset_announced');
});

test('active present-perfect reset fixture is completed despite outage narrative', async () => {
  const { client, requestCount } = createClient(() => ({
    events: [{
      type: 'reset_completed',
      confidence: 0.99,
      explicit: true,
      summary: 'Codex 和 ChatGPT Work 用户的用量限额已经重置',
      evidence: ['We have reset usage limits for all Codex and ChatGPT Work users.'],
      reason: 'direct active present-perfect completion statement',
    }],
    needs_human_review: false,
  }));
  const result = await client.classify(post(ENGLISH_COMPLETED_FIXTURE, '104'));
  assert.equal(requestCount(), 1);
  assert.equal(result.events[0].type, 'reset_completed');
});

test('executed reset with a short propagation delay is completed', async () => {
  const { client, requestCount } = createClient(() => ({
    events: [{
      type: 'reset_completed',
      confidence: 0.97,
      explicit: true,
      summary: '几分钟后恢复每周用量限额',
      evidence: ['Should have that sweet 100% weekly usage limit back in a few minutes.'],
      reason: 'the reset was executed and limits will propagate in a few minutes',
    }],
    needs_human_review: false,
  }));
  const result = await client.classify(post(MINUTES_ANNOUNCED_FIXTURE, '105'));
  assert.equal(requestCount(), 1);
  assert.equal(result.events[0].type, 'reset_completed');
});

test('Tibo rhetorical reset question is treated as an announced signal', async () => {
  const { client, requestCount } = createClient(() => ({
    events: [{
      type: 'reset_announced',
      confidence: 0.84,
      explicit: false,
      summary: 'Tibo 释放可能再次重置额度的信号',
      evidence: ['Should we reset the ChatGPT Work and Codex usage again or give it some space?'],
      reason: 'Tibo uses a rhetorical question to float his own reset action',
    }],
    needs_human_review: false,
  }));
  const result = await client.classify(post(RESET_QUESTION_FIXTURE, '106'));
  assert.equal(requestCount(), 1);
  assert.equal(result.events[0].type, 'reset_announced');
});

test('every unrelated and conversational post still calls the model', async () => {
  const { client, requestCount } = createClient(() => ({
    events: [{ type: 'none', confidence: 0.99, explicit: false, summary: '', evidence: [], reason: 'unrelated post' }],
    needs_human_review: false,
  }));
  for (const [index, text] of ['也许', '没错', '玩得开心', 'Have fun!', 'Maybe, sounds right.'].entries()) {
    const result = await client.classify(post(text, `20${index}`));
    assert.equal(result.events[0].type, 'none');
  }
  assert.equal(requestCount(), 5);
});

test('positive recent context can never prove an unrelated current post', async () => {
  const { client, requestCount } = createClient(() => ({
    events: [{ type: 'none', confidence: 0.99, explicit: false, summary: '', evidence: [], reason: 'current post is unrelated' }],
    needs_human_review: false,
  }));
  const context = [post(COMPLETED_USER_FIXTURE, '300')];
  const result = await client.classify(post('没错，祝你玩得开心。', '301'), context, { status: 'completed' });
  assert.equal(result.events[0].type, 'none');
  assert.equal(requestCount(), 1);
});

test('generic reset wording is delegated to the model and can fail closed', async () => {
  const { client, requestCount } = createClient(() => ({
    events: [{ type: 'none', confidence: 0.99, explicit: false, summary: '', evidence: [], reason: 'general documentation' }],
    needs_human_review: false,
  }));
  const text = 'Usage limit reset information is available on the dashboard.';
  const result = await client.classify(post(text, '401'));
  assert.equal(result.events[0].type, 'none');
  assert.equal(requestCount(), 1);
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

test('model type with exact current-post evidence controls the final type', () => {
  const futureText = 'We will reset usage limits later.';
  const wrongType = validateClassification({
    events: [{ type: 'reset_completed', confidence: 1, explicit: true, evidence: ['reset usage limits'] }],
  }, futureText);
  assert.equal(wrongType.events[0].type, 'reset_completed');

  const noScope = 'Usage limits have been reset already.';
  const result = validateClassification({
    events: [{ type: 'reset_completed', confidence: 1, explicit: true, evidence: ['Usage limits have been reset'] }],
  }, noScope);
  assert.equal(result.events[0].type, 'reset_completed');
});

test('multiple model events collapse to the strongest directly evidenced event', () => {
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
  assert.equal(result.events[0].type, 'reset_completed');
  assert.equal(result.events[0].confidence, 0.99);
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
