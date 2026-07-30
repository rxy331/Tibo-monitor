'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  collectOriginalTweetTexts,
  evaluateTimeline,
  isTargetProfilePostsUrl,
  scrapeRecentTweets,
} = require('../src/lib/xactions-tweets.cjs');
const { newestPostTimestamp, XActionsSource } = require('../src/lib/xactions-source.cjs');

function splitSelectorList(selector) {
  return String(selector).split(',').map((part) => part.trim()).filter(Boolean);
}

function matchesSimple(node, selector) {
  const match = String(selector).match(/^([a-z][\w-]*|\*)?(?:\[([\w-]+)(?:(\^=|\*=|=)"([^"]*)")?\])?$/i);
  if (!match) return false;
  const [, tagName, attribute, operator, expected] = match;
  if (tagName && tagName !== '*' && node.tagName.toLowerCase() !== tagName.toLowerCase()) return false;
  if (!attribute) return true;
  const actual = node.getAttribute(attribute);
  if (actual === null) return false;
  if (!operator) return true;
  if (operator === '=') return actual === expected;
  if (operator === '^=') return actual.startsWith(expected);
  if (operator === '*=') return actual.includes(expected);
  return false;
}

function matchesSelector(node, selector) {
  const parts = String(selector).trim().split(/\s+/).filter(Boolean);
  if (!parts.length || !matchesSimple(node, parts.at(-1))) return false;
  let ancestor = node.parentElement;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    while (ancestor && !matchesSimple(ancestor, parts[index])) ancestor = ancestor.parentElement;
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

class FixtureNode {
  constructor(tagName, attributes = {}, children = [], ownText = '') {
    this.tagName = tagName.toUpperCase();
    this.attributes = { ...attributes };
    this.children = children;
    this.parentElement = null;
    this.ownText = ownText;
    for (const child of children) child.parentElement = this;
  }

  get textContent() {
    return `${this.ownText}${this.children.map((child) => child.textContent).join('')}`;
  }

  get innerText() {
    return this.textContent;
  }

  get href() {
    const value = this.getAttribute('href');
    return value === null ? '' : new URL(value, 'https://x.com').href;
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? String(this.attributes[name]) : null;
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (splitSelectorList(selector).some((part) => matchesSelector(current, part))) return current;
      current = current.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const selectors = splitSelectorList(selector);
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (selectors.some((part) => matchesSelector(child, part))) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

class FixtureDocument {
  constructor(articles) {
    this.body = new FixtureNode('body', {}, articles);
    this.documentElement = this.body;
    this.scrollingElement = this.body;
    this.body.scrollHeight = 1000;
  }

  querySelectorAll(selector) {
    return this.body.querySelectorAll(selector);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

const element = (tagName, attributes = {}, children = [], text = '') => (
  new FixtureNode(tagName, attributes, children, text)
);

test('structured X responses preserve source text and prefer long-note text', () => {
  const originals = collectOriginalTweetTexts({
    data: {
      entries: [
        { content: { item: { itemContent: { tweet_results: { result: {
          rest_id: '2081940052154933696',
          legacy: { full_text: 'Back at the laptop.' },
        } } } } } },
        { content: { item: { itemContent: { tweet_results: { result: {
          rest_id: '2081899343091843463',
          legacy: { full_text: 'Truncated legacy text…' },
          note_tweet: { note_tweet_results: { result: { text: 'Complete long-form original text.' } } },
        } } } } } },
      ],
    },
  });

  assert.equal(originals.get('2081940052154933696'), 'Back at the laptop.');
  assert.equal(originals.get('2081899343091843463'), 'Complete long-form original text.');
});

function timePermalink(author, id, timestamp) {
  return element('a', { href: `/${author}/status/${id}` }, [
    element('time', { datetime: timestamp }, [], timestamp),
  ]);
}

function quoteFixture(author, id, text, timestamp) {
  return element('div', { 'data-testid': 'quoteTweet' }, [
    timePermalink(author, id, timestamp),
    element('div', { 'data-testid': 'tweetText' }, [], text),
  ]);
}

function articleFixture({
  author,
  id,
  text,
  timestamp,
  replyTo = '',
  socialContext = '',
  quote = null,
  quoteFirst = false,
}) {
  const outer = [
    timePermalink(author, id, timestamp),
    element('div', { 'data-testid': 'tweetText' }, [], text),
  ];
  if (replyTo) outer.unshift(element('div', { id: `id__reply_${id}` }, [], `Replying to @${replyTo}`));
  if (socialContext) outer.unshift(element('div', { 'data-testid': 'socialContext' }, [], socialContext));
  if (quote) {
    if (quoteFirst) outer.unshift(quote);
    else outer.push(quote);
  }
  return element('article', { 'data-testid': 'tweet' }, outer);
}

function buildTimelineFixture() {
  const articles = [
    articleFixture({
      author: 'outside_parent',
      id: '900',
      text: 'external parent must never enter the target feed',
      timestamp: '2026-07-28T09:00:00.000Z',
    }),
    articleFixture({
      author: 'Tibo',
      id: '800',
      text: 'target reply must be excluded even when includeReplies is true',
      timestamp: '2026-07-28T08:00:00.000Z',
      replyTo: 'outside_parent',
    }),
    articleFixture({
      author: 'Tibo',
      id: '700',
      text: 'explicit repost',
      timestamp: '2026-07-28T07:00:00.000Z',
      socialContext: 'Tibo reposted',
    }),
    articleFixture({
      author: 'Tibo',
      id: '100',
      text: 'old pinned original',
      timestamp: '2026-07-28T01:00:00.000Z',
      socialContext: 'Pinned',
    }),
    articleFixture({
      author: 'Tibo',
      id: '600',
      text: 'new original',
      timestamp: '2026-07-28T06:00:00.000Z',
    }),
    element('article', { 'data-testid': 'tweet' }, [
      element('div', { id: 'id__generic_accessibility_container' }, [
        timePermalink('Tibo', '550', '2026-07-28T05:30:00.000Z'),
        element('div', { 'data-testid': 'tweetText' }, [], 'original with a generic 回复 action nearby'),
        element('button', { 'aria-label': '回复' }, [], '回复'),
      ]),
    ]),
    articleFixture({
      author: 'Tibo',
      id: '500',
      text: 'outer quote commentary',
      timestamp: '2026-07-28T05:45:00.000Z',
      quote: quoteFixture('someone_else', '999', 'quoted inner body must not be returned', '2026-07-28T10:00:00.000Z'),
      quoteFirst: true,
    }),
    articleFixture({
      author: 'Tibo',
      id: '600',
      text: 'duplicate DOM copy',
      timestamp: '2026-07-28T06:00:00.000Z',
    }),
  ];
  return new FixtureDocument(articles);
}

function fixturePage(documentOrPages, initialUrl = 'https://x.com/Tibo', graphqlPayload = null) {
  const pages = Array.isArray(documentOrPages) ? documentOrPages : [documentOrPages];
  let pageIndex = 0;
  let currentUrl = initialUrl;
  const visits = [];
  const responseListeners = new Set();
  let scrollCount = 0;
  return {
    visits,
    get scrollCount() { return scrollCount; },
    url: () => currentUrl,
    goto: async (url) => {
      currentUrl = url;
      visits.push(url);
      if (graphqlPayload) {
        const response = {
          url: () => 'https://x.com/i/api/graphql/example/UserTweets',
          headers: () => ({ 'content-type': 'application/json' }),
          json: async () => graphqlPayload,
        };
        responseListeners.forEach((listener) => listener(response));
      }
    },
    on: (event, listener) => { if (event === 'response') responseListeners.add(listener); },
    off: (event, listener) => { if (event === 'response') responseListeners.delete(listener); },
    waitForSelector: async () => {},
    evaluate: async (callback, argument) => {
      const previousDocument = global.document;
      const previousWindow = global.window;
      global.document = pages[pageIndex];
      global.window = {
        scrollTo: () => {
          scrollCount += 1;
          pageIndex = Math.min(pageIndex + 1, pages.length - 1);
        },
      };
      try {
        return callback(argument);
      } finally {
        global.document = previousDocument;
        global.window = previousWindow;
      }
    },
  };
}

function buildRejectedFirstPageFixture() {
  const articles = [];
  for (let index = 0; index < 10; index += 1) {
    articles.push(articleFixture({
      author: 'Tibo',
      id: String(3000 + index),
      text: `reply ${index}`,
      timestamp: '2026-07-28T03:00:00.000Z',
      replyTo: 'outside_parent',
    }));
    articles.push(articleFixture({
      author: 'Tibo',
      id: String(2000 + index),
      text: `repost ${index}`,
      timestamp: '2026-07-28T02:00:00.000Z',
      socialContext: 'Tibo reposted',
    }));
    articles.push(articleFixture({
      author: index === 0 ? 'real_original_author' : `outside_${index}`,
      id: String(1000 + index),
      text: `external ${index}`,
      timestamp: '2026-07-28T01:00:00.000Z',
      socialContext: index === 0 ? 'Tibo reposted' : '',
    }));
  }
  return new FixtureDocument(articles);
}

function buildFiveOriginalsFixture() {
  return new FixtureDocument(Array.from({ length: 5 }, (_, index) => articleFixture({
    author: 'Tibo',
    id: String(5000 + index),
    text: `accepted original ${index}`,
    timestamp: `2026-07-28T05:0${index}:00.000Z`,
  })));
}

test('timeline DOM extraction binds identity to the outer time permalink', async () => {
  const page = fixturePage(buildTimelineFixture());
  const state = await evaluateTimeline(page, 'tIbO');

  assert.equal(state.profilePostsVerified, true);
  assert.deepEqual(state.tweets.map((post) => post.id), ['800', '700', '100', '600', '550', '500', '600']);
  assert.equal(state.tweets.every((post) => post.author === 'tibo'), true);
  assert.equal(state.tweets.find((post) => post.id === '800').isReply, true);
  assert.equal(state.tweets.find((post) => post.id === '700').isRetweet, true);
  assert.equal(state.tweets.find((post) => post.id === '100').isRetweet, false, 'Pinned is not a repost label');
  assert.equal(state.tweets.find((post) => post.id === '550').isReply, false, 'generic reply action text is not Replying-to context');
  const quote = state.tweets.find((post) => post.id === '500');
  assert.equal(quote.isQuote, true);
  assert.equal(quote.text, 'outer quote commentary');
  assert.equal(quote.url, 'https://x.com/Tibo/status/500');
  assert.equal(state.tweets.some((post) => post.id === '999'), false, 'first nested status link is not the outer permalink');
  assert.equal(state.tweets.some((post) => post.id === '900'), false, 'external parent author is rejected');
});

test('unverified pages leave reply state unknown for fail-closed filtering', async () => {
  const document = new FixtureDocument([
    articleFixture({
      author: 'Tibo',
      id: '400',
      text: 'looks original but page structure is not verified',
      timestamp: '2026-07-28T04:00:00.000Z',
    }),
  ]);
  const state = await evaluateTimeline(fixturePage(document, 'https://x.com/home'), 'Tibo');
  assert.equal(state.profilePostsVerified, false);
  assert.equal(state.tweets[0].isReply, null);
  assert.equal(isTargetProfilePostsUrl('https://x.com/Tibo/with_replies', 'tibo'), false);
  assert.equal(isTargetProfilePostsUrl('https://x.com/Tibo/with_replies', 'tibo', true), true);
});

test('scraper visits with_replies and returns target originals plus replies when enabled', async () => {
  const page = fixturePage(buildTimelineFixture(), 'about:blank');
  const posts = await scrapeRecentTweets(page, '@Tibo', { limit: 4, includeReplies: true, includeRetweets: true });

  assert.deepEqual(page.visits, ['https://x.com/tibo/with_replies']);
  assert.deepEqual(posts.map((post) => post.id), ['800', '600', '550', '500']);
  assert.equal(posts.every((post) => post.author === 'tibo' && post.isRetweet === false), true);
  assert.deepEqual(posts.find((post) => post.id === '800').replyTo, ['outside_parent']);
  assert.equal(posts.find((post) => post.id === '600').text, 'new original');
});

test('scraper replaces an auto-translated DOM body with the exact X source text', async () => {
  const document = new FixtureDocument([articleFixture({
    author: 'Tibo',
    id: '2081940052154933696',
    text: '回到笔记本电脑前。所有付费用户的用量限制已经重置。',
    timestamp: '2026-07-28T08:00:00.000Z',
  })]);
  const graphqlPayload = {
    data: { result: {
      rest_id: '2081940052154933696',
      legacy: { full_text: 'Back at the laptop. The usage limits have been reset for all paid users.' },
    } },
  };
  const posts = await scrapeRecentTweets(fixturePage(document, 'about:blank', graphqlPayload), 'Tibo', { limit: 1 });

  assert.equal(posts[0].text, 'Back at the laptop. The usage limits have been reset for all paid users.');
  assert.equal(posts[0].displayedText, '回到笔记本电脑前。所有付费用户的用量限制已经重置。');
  assert.equal(posts[0].wasTranslated, true);
  assert.equal(posts[0].textSource, 'x_structured_response');
});

test('scraper scrolls past thirty rejected rows until five accepted originals are collected', async () => {
  const rejectedPage = buildRejectedFirstPageFixture();
  const initialState = await evaluateTimeline(fixturePage(rejectedPage), 'Tibo');
  assert.equal(initialState.tweets.length, 20, 'ten external authors, including a real repost outer author, are rejected by identity');
  assert.equal(initialState.tweets.every((post) => post.isReply || post.isRetweet), true);

  const page = fixturePage([rejectedPage, buildFiveOriginalsFixture()], 'about:blank');
  const posts = await scrapeRecentTweets(page, 'Tibo', { limit: 5 });

  assert.equal(page.scrollCount, 1);
  assert.deepEqual(posts.map((post) => post.id), ['5004', '5003', '5002', '5001', '5000']);
  assert.equal(posts.every((post) => post.author === 'tibo' && post.isReply === false && post.isRetweet === false), true);
});

test('source includes target replies when enabled while excluding reposts and unknown reply state', async () => {
  const extracted = await evaluateTimeline(fixturePage(buildTimelineFixture()), 'Tibo');
  const settings = {
    x: {
      handle: 'Tibo',
      firefoxProfileMode: 'isolated',
      fetchLimit: 20,
      includeReplies: true,
      includeRetweets: true,
    },
  };
  let scrapeOptions = null;
  const source = new XActionsSource({
    profilePath: 'unused',
    getSettings: () => settings,
    log: () => {},
    now: () => Date.parse('2026-07-28T06:00:00.000Z'),
  });
  source.candidateProfiles = () => [{ path: 'unused', name: 'test-profile' }];
  source.start = async () => { source.page = {}; };
  source.inspectHealth = async () => {};
  source.scrapeTweets = async (_page, _handle, options) => {
    scrapeOptions = options;
    return [
      ...extracted.tweets,
      {
        id: '575',
        author: 'tibo',
        text: 'target reply inside the active window',
        timestamp: '2026-07-28T05:50:00.000Z',
        isReply: true,
        replyTo: ['someone'],
        isRetweet: false,
      },
      {
        id: '650',
        author: 'tibo',
        text: 'unknown reply state',
        timestamp: '2026-07-28T06:30:00.000Z',
        isReply: null,
        isRetweet: false,
      },
      {
        id: '950',
        author: 'another_account',
        text: 'defense in depth author rejection',
        timestamp: '2026-07-28T09:30:00.000Z',
        isReply: false,
        isRetweet: false,
      },
    ];
  };

  const posts = await source._fetchLatest({ limit: 20 });
  assert.equal(scrapeOptions.includeReplies, true);
  assert.deepEqual(posts.map((post) => post.id), ['600', '575', '550', '500']);
  assert.equal(posts.every((post) => post.author === 'tibo' && post.isRetweet === false), true);
  assert.deepEqual(posts.find((post) => post.id === '575').replyTo, ['someone']);
  assert.equal(posts.some((post) => post.id === '650'), false);
  assert.equal(posts.find((post) => post.id === '500').text, 'outer quote commentary');
});

function sourceForTimeWindow(rawPosts, nowIso) {
  const settings = {
    x: {
      handle: 'Tibo',
      firefoxProfileMode: 'isolated',
      fetchLimit: 30,
    },
  };
  const source = new XActionsSource({
    profilePath: 'unused',
    getSettings: () => settings,
    log: () => {},
    now: () => Date.parse(nowIso),
  });
  source.candidateProfiles = () => [{ path: 'unused', name: 'test-profile' }];
  source.start = async () => { source.page = {}; };
  source.inspectHealth = async () => {};
  source.scrapeTweets = async () => rawPosts;
  return source;
}

const originalPost = (id, fields = {}) => ({
  id: String(id),
  author: 'tibo',
  text: `post ${id}`,
  isReply: false,
  isRetweet: false,
  ...fields,
});

test('source applies inclusive thirty-minute and two-minute-skew boundaries with an injected clock', async () => {
  const source = sourceForTimeWindow([
    originalPost('900', { timestamp: '2026-07-28T10:00:00.000Z' }),
    originalPost('850', { timestamp: 'not-a-date' }),
    originalPost('800', { createdAt: '2026-07-28T11:30:01.000Z' }),
    originalPost('700', { tweetAt: '2026-07-28T11:29:59.000Z' }),
    originalPost('600', { tweetAt: 'invalid-date' }),
    originalPost('500', { createdAt: '2026-07-28T12:02:01.000Z' }),
    originalPost('400', { tweetAt: '2026-07-28T12:02:00.000Z' }),
    originalPost('300', { timestamp: '2026-07-28T12:00:00.000Z' }),
  ], '2026-07-28T12:00:00.000Z');

  const posts = await source._fetchLatest({ limit: 30 });

  assert.deepEqual(posts.map((post) => post.id), ['800', '400', '300']);
  assert.equal(posts.observedHighWaterId, '900', 'old observed originals still advance source metadata');
  assert.equal(posts.newestAt, '2026-07-28T12:02:00.000Z');
  assert.deepEqual(source.lastFetchMetadata, {
    observedHighWaterId: '900',
    observedHighWaterIds: { originals: '900', replies: null },
    newestAt: '2026-07-28T12:02:00.000Z',
  });
  assert.equal(posts.every((post) => post.timestamp === post.tweetAt && post.tweetAt === post.createdAt), true);
  assert.equal(posts.some((post) => ['850', '700', '600', '500'].includes(post.id)), false);
});

test('an empty recent window retains the maximum observed snowflake and has null newestAt', async () => {
  const source = sourceForTimeWindow([
    originalPost('1100', { text: '', tweetAt: '2026-07-28T12:00:00.000Z' }),
    originalPost('1000', { tweetAt: '2026-07-28T10:00:00.000Z' }),
    originalPost('900', { createdAt: 'invalid-date' }),
  ], '2026-07-28T12:00:00.000Z');

  const posts = await source._fetchLatest({ limit: 30 });

  assert.equal(posts.length, 0);
  assert.equal(posts.observedHighWaterId, '1100');
  assert.equal(posts.newestAt, null);
  assert.deepEqual(source.lastFetchMetadata, {
    observedHighWaterId: '1100',
    observedHighWaterIds: { originals: '1100', replies: null },
    newestAt: null,
  });
});

test('newest metadata takes the maximum timestamp rather than DOM position', () => {
  assert.equal(newestPostTimestamp([
    { id: '100', timestamp: '2026-07-28T01:00:00.000Z' },
    { id: '300', timestamp: '2026-07-28T03:00:00.000Z' },
    { id: '200', timestamp: '2026-07-28T02:00:00.000Z' },
  ]), '2026-07-28T03:00:00.000Z');
});
