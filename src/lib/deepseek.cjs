'use strict';

const { clamp, safeError } = require('./utils.cjs');

const EVENT_TYPES = new Set(['reset_announced', 'reset_completed', 'reset_cancelled', 'uncertain', 'none']);
const LIMIT_SUBJECT_RE = /\b(?:limits?|quotas?|usage)\b|(?:限额|额度|用量)/i;
const RESET_ACTION_RE = /\b(?:reset(?:s|ted|ting)?|restore(?:d|s|ing)?)\b|(?:重置|恢复)/i;
const FUTURE_CUE_RE = /\bwill\b|\bsoon\b|\blater\b|\bin\s+(?:(?:the\s+)?next\s+|a\s+few\s+|\d+\s+)?hours?\b|\bwhen\s+(?:i(?:'m|\s+am)?\s+)?back\b|(?:即将|稍后|几(?:个)?小时后)/i;
const COMPLETED_CUE_RE = /\b(?:have|has)\s+been\s+(?:reset|restored)\b|\balready\s+(?:reset|restored)\b|(?:已经(?:重置|恢复)|(?:重置|恢复)(?:已经|已)?完成)/i;
const COMPLETED_SCOPE_RE = /\b(?:paid\s+users?|chatgpt(?:\s+work)?|codex)\b|(?:付费用户)/i;
const CANCELLED_CUE_RE = /\b(?:cancelled?|postponed?)\b|\b(?:won't|will\s+not)\b[^.!?\n]{0,80}\b(?:reset|restore)\b|(?:取消|推迟)[^。！？\n]{0,40}(?:重置|恢复)/i;

const SYSTEM_PROMPT = `You are a strict event classifier for public posts by Tibo, an OpenAI team member.
Your only task is to determine whether Tibo himself is announcing a GPT/Codex/ChatGPT Work usage-limit reset.
Return one JSON object only. Do not use markdown.

Distinguish carefully:
- reset_announced: the current post contains a future cue such as will, soon, later, in hours, when back, 即将, 稍后, 几小时后, or 几个小时后. Hedged wording such as "I feel like" / "感觉" is still announced when a future cue is present.
- reset_completed: only when the current post explicitly says have/has been reset, already reset, 已经重置, or 重置完成, and names paid users, ChatGPT, or Codex as the scope.
- reset_cancelled: a previously planned reset is explicitly cancelled or postponed.
- uncertain: relevant but requires human review; it must never be treated as notification proof.
- none: unrelated discussion, a question/request, a quote of somebody else, a joke without a factual statement, or a negated reset.

The current_post is the only source that can prove an event. recent_context can clarify references but can NEVER prove that current_post contains an event.
Every non-none event must include non-empty evidence copied verbatim from current_post.text. Never quote or paraphrase context as evidence.
Future meaning takes priority over completed meaning when both appear. Generic words without a permitted temporal cue are none.
Return at most ONE primary event. If the type, scope, timing, or evidence is not directly supported by current_post, fail closed with none.
Do not infer a time that is absent. Do not treat a user's request to Tibo as Tibo's own announcement.
Set needs_human_review=true whenever attribution or meaning is genuinely ambiguous; human-review results are not notification proof.
Summaries must be concise Chinese.

Required JSON shape example:
{"schema_version":"2","events":[{"type":"reset_announced","confidence":0.93,"explicit":true,"effective_at":null,"time_text":"in the next hour","summary":"Tibo 表示将在一小时内重置额度","evidence":["will reset usage limits","in the next hour"],"reason":"current_post 使用明确将来时"}],"needs_human_review":false}`;

function normalizeEvidenceText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function isResetCandidateText(text) {
  const current = String(text || '');
  return LIMIT_SUBJECT_RE.test(current) && RESET_ACTION_RE.test(current);
}

function localTemporalType(text) {
  const current = String(text || '');
  if (!isResetCandidateText(current)) return 'none';
  if (CANCELLED_CUE_RE.test(current)) return 'reset_cancelled';
  if (FUTURE_CUE_RE.test(current)) return 'reset_announced';
  if (COMPLETED_CUE_RE.test(current) && COMPLETED_SCOPE_RE.test(current)) return 'reset_completed';
  return 'none';
}

function noneClassification(reason = '当前帖没有可验证的重置事件。', needsHumanReview = false) {
  return {
    schema_version: '2',
    events: [{
      type: 'none',
      confidence: 0,
      explicit: false,
      effective_at: null,
      time_text: '',
      summary: '',
      evidence: [],
      reason,
    }],
    needs_human_review: Boolean(needsHumanReview),
  };
}

function normalizeEvent(raw) {
  const type = EVENT_TYPES.has(raw?.type) ? raw.type : 'uncertain';
  const confidence = clamp(Number(raw?.confidence ?? 0), 0, 1);
  return {
    type,
    confidence,
    explicit: Boolean(raw?.explicit),
    effective_at: typeof raw?.effective_at === 'string' && raw.effective_at.trim() ? raw.effective_at.trim() : null,
    time_text: typeof raw?.time_text === 'string' ? raw.time_text.slice(0, 160) : '',
    summary: typeof raw?.summary === 'string' ? raw.summary.slice(0, 300) : '',
    evidence: Array.isArray(raw?.evidence) ? raw.evidence.map(String).map((item) => item.slice(0, 180)).slice(0, 4) : [],
    reason: typeof raw?.reason === 'string' ? raw.reason.slice(0, 400) : '',
  };
}

function evidenceComesFromCurrentPost(event, currentPostText) {
  const current = normalizeEvidenceText(currentPostText);
  const evidence = Array.isArray(event?.evidence)
    ? event.evidence.map((item) => normalizeEvidenceText(item)).filter(Boolean)
    : [];
  return Boolean(current) && evidence.length > 0 && evidence.every((item) => current.includes(item));
}

function validateClassification(raw, currentPostText = null) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.events)) {
    throw new Error('AI 返回的 JSON 缺少 events 数组。');
  }
  const needsHumanReview = Boolean(raw.needs_human_review);
  const normalized = raw.events.map(normalizeEvent);
  if (currentPostText === null || currentPostText === undefined) {
    return {
      schema_version: '2',
      events: normalized.slice(0, 1),
      needs_human_review: needsHumanReview,
    };
  }
  const expectedType = localTemporalType(currentPostText);
  if (expectedType === 'none') return noneClassification('当前帖缺少可验证的时间或完成条件。', needsHumanReview);
  const eligible = normalized
    .filter((event) => event.type === expectedType)
    .filter((event) => evidenceComesFromCurrentPost(event, currentPostText))
    .sort((left, right) => Number(right.explicit) - Number(left.explicit) || right.confidence - left.confidence);
  if (!eligible.length) return noneClassification('AI 类型或证据与当前帖不一致，已按无事件处理。', needsHumanReview);
  return {
    schema_version: '2',
    events: [eligible[0]],
    needs_human_review: needsHumanReview,
  };
}

function parseJsonContent(content) {
  const text = String(content || '').trim();
  if (!text) throw new Error('AI 返回内容为空。');
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('AI 返回内容不是有效 JSON。');
    return JSON.parse(match[0]);
  }
}

class DeepSeekClient {
  constructor({ getSettings, getApiKey, log }) {
    this.getSettings = getSettings;
    this.getApiKey = getApiKey;
    this.log = log;
  }

  endpoint(baseUrl) {
    const clean = String(baseUrl || '').replace(/\/+$/, '');
    return clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`;
  }

  async request(messages) {
    const settings = this.getSettings().ai;
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error('尚未配置 DeepSeek API Key。');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.timeoutSeconds * 1000);
    try {
      const response = await fetch(this.endpoint(settings.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          messages,
          stream: false,
          temperature: settings.thinkingEnabled ? undefined : 0,
          thinking: { type: settings.thinkingEnabled ? 'enabled' : 'disabled' },
          response_format: { type: 'json_object' },
          max_tokens: 900,
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = payload?.error?.message || `HTTP ${response.status}`;
        throw new Error(`DeepSeek 请求失败（${response.status}）：${detail}`);
      }
      return payload?.choices?.[0]?.message?.content;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`DeepSeek 请求超过 ${settings.timeoutSeconds} 秒。`);
      throw new Error(safeError(error, 'DeepSeek 请求失败。'));
    } finally {
      clearTimeout(timer);
    }
  }

  async classify(post, context = [], lifecycle = {}) {
    const currentText = String(post?.text || '');
    if (!isResetCandidateText(currentText)) {
      return noneClassification('本地候选门未同时发现额度主题与重置动作。');
    }
    if (localTemporalType(currentText) === 'none') {
      return noneClassification('当前帖只有泛化重置词，没有允许的未来或明确完成线索。');
    }
    const contextText = context.slice(-5).map((item) => ({
      id: item.id,
      timestamp: item.timestamp,
      text: item.text,
    }));
    const userPayload = {
      author: `@${this.getSettings().x.handle}`,
      current_post: {
        id: post.id,
        timestamp: post.timestamp,
        text: post.text,
        url: post.url,
        is_quote: Boolean(post.isQuote),
        is_retweet: Boolean(post.isRetweet),
      },
      recent_context: contextText,
      current_lifecycle: lifecycle,
    };
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const content = await this.request([
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Classify this input and return JSON:\n${JSON.stringify(userPayload)}` },
        ]);
        return validateClassification(parseJsonContent(content), currentText);
      } catch (error) {
        lastError = error;
        this.log('warn', `DeepSeek classification attempt ${attempt + 1} failed: ${safeError(error)}`);
      }
    }
    throw lastError;
  }

  async analyze(post, context = [], lifecycle = {}) {
    return this.classify(post, context, lifecycle);
  }

  async test() {
    const sample = {
      id: 'test-only',
      timestamp: new Date().toISOString(),
      text: 'We will reset usage limits for Codex and ChatGPT Work in the next hour.',
      url: 'https://x.com/thsottiaux',
      isQuote: false,
      isRetweet: false,
    };
    const result = await this.classify(sample, [], { status: 'idle' });
    return {
      ok: true,
      model: this.getSettings().ai.model,
      detected: result.events[0]?.type || 'none',
      confidence: result.events[0]?.confidence ?? 0,
    };
  }
}

module.exports = {
  DeepSeekClient,
  EVENT_TYPES,
  SYSTEM_PROMPT,
  evidenceComesFromCurrentPost,
  isResetCandidateText,
  localTemporalType,
  noneClassification,
  normalizeEvidenceText,
  parseJsonContent,
  validateClassification,
};
