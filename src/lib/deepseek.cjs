'use strict';

const { clamp, safeError } = require('./utils.cjs');

const EVENT_TYPES = new Set(['reset_announced', 'reset_completed', 'reset_cancelled', 'uncertain', 'none']);

const SYSTEM_PROMPT = `Classify one public post written by Tibo about Codex or ChatGPT Work usage-limit resets.
Return one JSON object only. Do not use markdown.

Choose exactly one result:
- reset_announced: Tibo releases a credible signal that a reset is planned, likely, or imminent. Social-media teasers, hedged wording, and rhetorical questions such as "Should we reset ... again?" count when Tibo is clearly floating his own reset action to users. A reset described as "lands in the next hour" has not happened yet and is announced.
- reset_completed: Tibo says the reset action has already been executed, started, or completed. If he announces "another reset" and says users should have their limit back in a few minutes, treat it as completed with short propagation delay.
- reset_cancelled: Tibo explicitly cancels or postpones a reset.
- uncertain: reset-related, but attribution or intent is too ambiguous to classify safely.
- none: unrelated content, another person's request, general documentation, or no meaningful reset signal from Tibo.

Judge the meaning of the whole post, not isolated tense keywords. A question can be a signal when it is Tibo teasing or proposing his own action; do not automatically discard question marks. A service outage recovery alone is not a usage reset. The key boundary is whether the reset action itself is still future (announced) or has already been performed (completed); propagation delay after performance does not make it future.
The current_post is the only proof. recent_context may clarify references but can never create an event absent from current_post.
For every non-none result, copy at least one exact evidence span from current_post.text. Never translate or paraphrase evidence.
Return at most one event. Do not invent an absolute time. Write summary and reason in concise Chinese, while evidence stays in the original language.
Always include top-level translation_zh as a faithful, complete Simplified Chinese translation of current_post.text, even when the result is none. Preserve names, URLs, numbers, emoji, paragraph breaks, and meaning.

Required shape:
{"schema_version":"2","translation_zh":"完整中文翻译","events":[{"type":"reset_announced|reset_completed|reset_cancelled|uncertain|none","confidence":0.0,"explicit":true,"effective_at":null,"time_text":"","summary":"中文摘要","evidence":["exact original text"],"reason":"中文理由"}],"needs_human_review":false}`;

function normalizeEvidenceText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function noneClassification(reason = '当前帖没有可验证的重置事件。', needsHumanReview = false, translationZh = '') {
  return {
    schema_version: '2',
    translation_zh: String(translationZh || ''),
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
  const translationZh = typeof raw.translation_zh === 'string' ? raw.translation_zh.trim().slice(0, 12000) : '';
  const normalized = raw.events.map(normalizeEvent);
  if (currentPostText === null || currentPostText === undefined) {
    return {
      schema_version: '2',
      translation_zh: translationZh,
      events: normalized.slice(0, 1),
      needs_human_review: needsHumanReview,
    };
  }
  const noneEvent = normalized.find((event) => event.type === 'none');
  const eligible = normalized
    .filter((event) => event.type !== 'none')
    .filter((event) => evidenceComesFromCurrentPost(event, currentPostText))
    .sort((left, right) => Number(right.explicit) - Number(left.explicit) || right.confidence - left.confidence);
  if (!eligible.length) {
    return noneClassification(
      noneEvent?.reason || 'AI 未提供可由当前帖原文验证的重置信号。',
      needsHumanReview,
      translationZh,
    );
  }
  return {
    schema_version: '2',
    translation_zh: translationZh,
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
          max_tokens: 1400,
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
        const result = validateClassification(parseJsonContent(content), currentText);
        if (!result.translation_zh) {
          const translated = parseJsonContent(await this.request([
            { role: 'system', content: 'Translate the complete input into faithful Simplified Chinese. Preserve names, URLs, numbers, emoji, and paragraph breaks. Return JSON only: {"translation_zh":"..."}.' },
            { role: 'user', content: currentText },
          ]));
          result.translation_zh = String(translated.translation_zh || '').trim().slice(0, 12000);
        }
        if (!result.translation_zh) throw new Error('AI 未返回完整中文翻译。');
        return result;
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
  noneClassification,
  normalizeEvidenceText,
  parseJsonContent,
  validateClassification,
};
