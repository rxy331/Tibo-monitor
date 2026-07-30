'use strict';

// The browser lifecycle is provided by XActions. Timeline extraction is kept
// locally so X navigation can be checked before scrolling and document roots
// can be handled safely when the site replaces its page during a transition.

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function createXError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function isTransientPageError(error) {
  return /Execution context was destroyed|Cannot find context|detached Frame|Target closed|Session closed|scrollHeight|document\.body/i
    .test(String(error?.message || error || ''));
}

function friendlyXError(error) {
  if (String(error?.code || '').startsWith('X_')) return error;
  const message = String(error?.message || error || 'X 页面操作失败。');
  if (/scrollHeight|document\.body|Execution context was destroyed|Cannot find context|detached Frame/i.test(message)) {
    return createXError(
      'X_PAGE_NOT_READY',
      'X 页面正在跳转或尚未加载完成。请确认独立登录浏览器已完成登录，然后重新验证。',
      error,
    );
  }
  if (/Target closed|Session closed|Protocol error.*closed/i.test(message)) {
    return createXError('X_BROWSER_CLOSED', '后台浏览器会话已关闭。请重新测试所选浏览器资料。', error);
  }
  if (/parent\.lock|Firefox.*(?:already running|profile.*(?:in use|locked))|profile.*(?:in use|locked).*Firefox/i.test(message)) {
    return createXError(
      'X_FIREFOX_PROFILE_IN_USE',
      'Firefox 日常登录资料正在被使用。请关闭所有 Firefox 窗口，等待几秒后重试；Tibo Monitor 不会终止普通 Firefox。',
      error,
    );
  }
  if (/already running for.*userDataDir|ProcessSingleton|profile.*(?:in use|locked)|SingletonLock|parent\.lock/i.test(message)) {
    return createXError('X_LOGIN_WINDOW_STILL_OPEN', '浏览器登录资料仍在使用中。请稍等片刻，或关闭所选浏览器后再验证。', error);
  }
  if (/Failed to launch|Browser was not found|Could not find browser|spawn .*ENOENT/i.test(message)) {
    return createXError('X_BROWSER_START_FAILED', 'Mozilla Firefox 无法启动。请确认它已正确安装，或在设置中选择 firefox.exe。', error);
  }
  if (/timeout|timed out|Navigation timeout/i.test(message)) {
    return createXError('X_TIMEOUT', 'X 在 60 秒内没有完成响应。登录资料不会被清除，请检查网络后重试。', error);
  }
  if (/net::ERR_|ENOTFOUND|ECONNRESET|ECONNREFUSED/i.test(message)) {
    return createXError('X_NETWORK_ERROR', '无法连接 X。请检查网络或代理设置，然后重试。', error);
  }
  return error;
}

function normalizeTargetHandle(username) {
  return String(username || '').trim().replace(/^@+/, '').toLowerCase();
}

function isTargetProfilePostsUrl(currentUrl, username, includeReplies = false) {
  const targetHandle = normalizeTargetHandle(username);
  if (!targetHandle) return false;
  try {
    const parsed = new URL(String(currentUrl || ''), 'https://x.com');
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(parsed.hostname.toLowerCase())) {
      return false;
    }
    const pathname = decodeURIComponent(parsed.pathname).replace(/\/+$/, '');
    const expected = includeReplies ? `/${targetHandle}/with_replies` : `/${targetHandle}`;
    return pathname.toLowerCase() === expected;
  } catch {
    return false;
  }
}

function isAcceptedOriginalTweet(tweet, username) {
  const targetHandle = normalizeTargetHandle(username);
  return Boolean(
    targetHandle &&
    /^\d+$/.test(String(tweet?.id || '')) &&
    normalizeTargetHandle(tweet?.author) === targetHandle &&
    tweet?.isReply === false &&
    tweet?.isRetweet === false,
  );
}

function isAcceptedTargetTweet(tweet, username, { includeReplies = false } = {}) {
  const targetHandle = normalizeTargetHandle(username);
  return Boolean(
    targetHandle &&
    /^\d+$/.test(String(tweet?.id || '')) &&
    normalizeTargetHandle(tweet?.author) === targetHandle &&
    tweet?.isRetweet === false &&
    (tweet?.isReply === false || (includeReplies && tweet?.isReply === true)),
  );
}

function dedupeAndSortTweets(items, limit = Infinity) {
  const unique = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(item?.id || '');
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    unique.push(item);
  }

  const withOrder = unique.map((item, index) => ({ item, index }));
  withOrder.sort((left, right) => {
    const leftId = String(left.item.id);
    const rightId = String(right.item.id);
    try {
      const leftSnowflake = BigInt(leftId);
      const rightSnowflake = BigInt(rightId);
      if (leftSnowflake !== rightSnowflake) return leftSnowflake > rightSnowflake ? -1 : 1;
    } catch {
      // Numeric IDs are enforced above; timestamps remain a safe fallback if that changes.
    }

    const leftTime = Date.parse(left.item.createdAt || left.item.timestamp || '');
    const rightTime = Date.parse(right.item.createdAt || right.item.timestamp || '');
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(rightTime) ? 1 : -1;
    return left.index - right.index;
  });

  const numericLimit = Number(limit);
  const take = Number.isFinite(numericLimit) ? Math.max(0, Math.floor(numericLimit)) : withOrder.length;
  return withOrder.slice(0, take).map(({ item }) => item);
}

function collectOriginalTweetTexts(value, originals = new Map(), seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return originals;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectOriginalTweetTexts(item, originals, seen));
    return originals;
  }

  const id = String(value.rest_id || value.id_str || '');
  const legacyText = typeof value.legacy?.full_text === 'string' ? value.legacy.full_text : '';
  const noteText = value.note_tweet?.note_tweet_results?.result?.text;
  const text = typeof noteText === 'string' && noteText ? noteText : legacyText;
  if (/^\d+$/.test(id) && text) originals.set(id, text);

  Object.values(value).forEach((item) => collectOriginalTweetTexts(item, originals, seen));
  return originals;
}

function observeOriginalTweetTexts(page) {
  const originals = new Map();
  const pending = new Set();
  if (typeof page?.on !== 'function') {
    return { originals, settle: async () => {}, stop: () => {} };
  }

  const onResponse = (response) => {
    if (!/\/graphql\//i.test(String(response?.url?.() || ''))) return;
    const task = Promise.resolve().then(async () => {
      const contentType = String(response.headers?.()['content-type'] || '');
      if (contentType && !contentType.includes('json')) return;
      collectOriginalTweetTexts(await response.json(), originals);
    }).catch(() => {});
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  page.on('response', onResponse);
  return {
    originals,
    settle: async () => { await Promise.allSettled([...pending]); },
    stop: () => {
      if (typeof page.off === 'function') page.off('response', onResponse);
      else if (typeof page.removeListener === 'function') page.removeListener('response', onResponse);
    },
  };
}

async function evaluateTimeline(page, username, { includeReplies = false } = {}) {
  let lastError = null;
  const targetHandle = normalizeTargetHandle(username);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const currentUrl = page.url?.() || '';
      const profilePostsVerified = isTargetProfilePostsUrl(currentUrl, targetHandle, includeReplies);
      return await page.evaluate(({ expectedHandle, verifiedPostsPage }) => {
        const bodyText = document.body?.innerText?.slice(0, 4000) || '';
        const authRequired = Boolean(
          document.querySelector('input[autocomplete="username"], [data-testid="loginButton"], a[href="/login"]'),
        );
        const challengeRequired = Boolean(
          document.querySelector('[data-testid="ocfEnterTextTextInput"], input[name="text"]'),
        ) && /verify|verification|验证|确认身份/i.test(bodyText);

        const parsePermalink = (link) => {
          const href = link?.getAttribute?.('href') || link?.href || '';
          try {
            const parsed = new URL(href, 'https://x.com');
            if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(parsed.hostname.toLowerCase())) {
              return null;
            }
            const match = decodeURIComponent(parsed.pathname).match(/^\/([^/]+)\/status\/(\d+)(?:\/|$)/i);
            if (!match) return null;
            return {
              author: match[1].replace(/^@+/, '').toLowerCase(),
              id: match[2],
              url: `${parsed.protocol}//${parsed.host}/${match[1]}/status/${match[2]}`,
            };
          } catch {
            return null;
          }
        };

        const tweets = [...document.querySelectorAll('article[data-testid="tweet"]')].map((article) => {
          const isOuterNode = (node) => Boolean(
            node &&
            node.closest?.('article[data-testid="tweet"]') === article &&
            !node.closest?.('[data-testid="quoteTweet"]'),
          );
          const outerTime = [...article.querySelectorAll('time')]
            .find((time) => isOuterNode(time) && parsePermalink(time.closest?.('a')));
          const permalink = parsePermalink(outerTime?.closest?.('a'));
          if (!permalink || permalink.author !== expectedHandle) return null;

          const outerText = [...article.querySelectorAll('[data-testid="tweetText"]')]
            .find((node) => isOuterNode(node));
          const socialContexts = [...article.querySelectorAll('[data-testid="socialContext"]')]
            .filter((node) => isOuterNode(node));
          const explicitContextLabels = (node) => [
            node?.getAttribute?.('aria-label'),
            node?.getAttribute?.('title'),
            node?.textContent,
          ].filter(Boolean).map((label) => String(label).replace(/\s+/g, ' ').trim());
          const translationLabels = [...article.querySelectorAll('button, [role="button"], span')]
            .filter((node) => isOuterNode(node))
            .flatMap((node) => explicitContextLabels(node));
          const replyContexts = [
            ...article.querySelectorAll('[data-testid="replyingTo"], [data-testid="replyContext"], div[id^="id__"]'),
            ...socialContexts,
          ].filter((node) => (
            isOuterNode(node) &&
            !node.querySelector?.('[data-testid="tweetText"]')
          ));
          const hasReplyLabel = replyContexts.some((node) => (
            explicitContextLabels(node).some((label) => (
              label.length <= 280 &&
              /(?:\breplying\s+to\b|\breplied\s+to\b|(?:正在)?回复(?:给|至|對|对)?|回覆(?:給|至|對)?|返信先|返信中|respondendo\s+a)\s*[:：]?\s*@/i
                .test(label)
            ))
          ));
          const replyTo = hasReplyLabel
            ? [...new Set(replyContexts
              .flatMap((node) => explicitContextLabels(node))
              .flatMap((label) => [...label.matchAll(/@([a-zA-Z0-9_]{1,15})/g)].map((match) => match[1].toLowerCase())))]
            : [];
          const hasRepostLabel = socialContexts.some((node) => (
            /\breposted\b|\bretweeted\b|\brepost(?:ed)?\b|转发了|轉發了|已转发|已轉發|リポストしました|republicado/i
              .test(explicitContextLabels(node).join(' '))
          ));
          const readMetric = (testId) => article.querySelector(`[data-testid="${testId}"] span span`)?.textContent || '0';
          return {
            id: permalink.id,
            author: permalink.author,
            text: outerText?.textContent || null,
            displayedAsTranslated: translationLabels.some((label) => (
              /\bshow original\b|显示原文|顯示原文|\btranslated from\b|翻译自|翻譯自/i.test(label)
            )),
            timestamp: outerTime?.getAttribute?.('datetime') || null,
            url: permalink.url,
            likes: readMetric('like'),
            retweets: readMetric('retweet'),
            replies: readMetric('reply'),
            views: article.querySelector('a[href*="/analytics"] span span')?.textContent || '0',
            isQuote: Boolean(article.querySelector('[data-testid="quoteTweet"]')),
            isReply: hasReplyLabel ? true : (verifiedPostsPage ? false : null),
            replyTo,
            isRetweet: hasRepostLabel,
          };
        }).filter(Boolean);
        return {
          authRequired,
          challengeRequired,
          hasDocumentRoot: Boolean(document.scrollingElement || document.documentElement || document.body),
          profilePostsVerified: verifiedPostsPage,
          tweets,
        };
      }, { expectedHandle: targetHandle, verifiedPostsPage: profilePostsVerified });
    } catch (error) {
      lastError = error;
      if (!isTransientPageError(error) || attempt === 1) throw error;
      await sleep(700);
    }
  }
  throw lastError;
}

async function safeScroll(page) {
  const didScroll = await page.evaluate(() => {
    const root = document.scrollingElement || document.documentElement || document.body;
    if (!root) return false;
    window.scrollTo({ top: root.scrollHeight || 0, behavior: 'instant' });
    return true;
  });
  if (!didScroll) {
    throw createXError('X_PAGE_NOT_READY', 'X 页面尚未创建可滚动区域，请确认登录窗口中的页面已完整显示。');
  }
}

async function scrapeRecentTweets(page, username, options = {}) {
  const limit = Math.max(1, Math.min(100, Number(options.limit || 20)));
  const targetHandle = normalizeTargetHandle(username);
  const includeReplies = Boolean(options.includeReplies);
  const originalCapture = observeOriginalTweetTexts(page);
  try {
    const url = `https://x.com/${encodeURIComponent(targetHandle)}${includeReplies ? '/with_replies' : ''}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('body', { timeout: 15000 });
  try {
    await page.waitForSelector(
      'article[data-testid="tweet"], [data-testid="emptyState"], input[autocomplete="username"], [data-testid="loginButton"], [data-testid="ocfEnterTextTextInput"]',
      { timeout: 20000 },
    );
  } catch (error) {
    throw createXError(
      'X_PAGE_NOT_READY',
      'X 个人主页的动态列表尚未加载完成。登录资料不会被清除，请检查网络后重试。',
      error,
    );
  }
  await sleep(700);

  const tweets = new Map();
  const defaultMaxPasses = Math.min(12, Math.max(4, Math.ceil(limit / 4) + 2));
  const maxPasses = Math.max(4, Math.min(60, Number(options.maxPasses || defaultMaxPasses)));

  for (let pass = 0; pass < maxPasses && tweets.size < limit; pass += 1) {
    const state = await evaluateTimeline(page, targetHandle, { includeReplies });
    const currentUrl = page.url();
    if (state.authRequired || /\/i\/flow\/login/i.test(currentUrl)) {
      throw createXError(
        'X_AUTH_REQUIRED',
        '所选浏览器资料尚未登录 X。请先点击“打开浏览器登录 X”，完成登录后再验证。',
      );
    }
    if (state.challengeRequired || /\/account\/access|\/i\/flow\/consent_flow/i.test(currentUrl)) {
      throw createXError('X_CHALLENGE_REQUIRED', 'X 要求完成身份验证。请在所选日常浏览器中处理后再试。');
    }
    if (!state.hasDocumentRoot) {
      throw createXError('X_PAGE_NOT_READY', 'X 页面尚未加载完成。请确认所选浏览器中已显示 X 首页后重试。');
    }

    state.tweets.filter((tweet) => isAcceptedTargetTweet(tweet, targetHandle, { includeReplies })).forEach((tweet) => {
      if (!tweets.has(tweet.id)) tweets.set(tweet.id, tweet);
    });
    if (tweets.size >= limit || pass + 1 >= maxPasses) break;
    await safeScroll(page);
    await sleep(900 + Math.floor(Math.random() * 500));
  }

    await originalCapture.settle();
    const accepted = dedupeAndSortTweets([...tweets.values()], limit);
    const missingOriginals = accepted.filter((post) => (
      post.displayedAsTranslated && !originalCapture.originals.has(String(post.id))
    ));
    if (missingOriginals.length) {
      throw createXError(
        'X_ORIGINAL_TEXT_UNAVAILABLE',
        `X 返回了 ${missingOriginals.length} 条自动译文，但暂未取得对应原文；本轮已停止判断以避免误报。`,
      );
    }
    return accepted.map((post) => {
      const originalText = originalCapture.originals.get(String(post.id));
      if (!originalText) return { ...post, textSource: 'visible_dom', wasTranslated: false };
      const displayedText = post.text;
      return {
        ...post,
        text: originalText,
        displayedText: displayedText !== originalText ? displayedText : null,
        wasTranslated: displayedText !== originalText,
        textSource: 'x_structured_response',
      };
    });
  } finally {
    originalCapture.stop();
  }
}

module.exports = {
  collectOriginalTweetTexts,
  createXError,
  dedupeAndSortTweets,
  evaluateTimeline,
  friendlyXError,
  isAcceptedOriginalTweet,
  isAcceptedTargetTweet,
  isTransientPageError,
  isTargetProfilePostsUrl,
  normalizeTargetHandle,
  safeScroll,
  scrapeRecentTweets,
};
