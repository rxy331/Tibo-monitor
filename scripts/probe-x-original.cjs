'use strict';

const { app, BrowserWindow, safeStorage } = require('electron');
const { Storage } = require('../src/lib/storage.cjs');
const { XActionsSource } = require('../src/lib/xactions-source.cjs');
const { configureElectronDataPaths } = require('../src/lib/electron-paths.cjs');

configureElectronDataPaths(app);

function collectOriginalPosts(value, originals, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item) => collectOriginalPosts(item, originals, seen));
    return;
  }

  const id = String(value.rest_id || value.id_str || '');
  const legacyText = typeof value.legacy?.full_text === 'string' ? value.legacy.full_text : '';
  const noteText = value.note_tweet?.note_tweet_results?.result?.text;
  const text = typeof noteText === 'string' && noteText ? noteText : legacyText;
  if (/^\d+$/.test(id) && text) originals.set(id, text);

  Object.values(value).forEach((item) => collectOriginalPosts(item, originals, seen));
}

app.whenReady().then(async () => {
  const keeper = new BrowserWindow({ width: 1, height: 1, show: false });
  const storage = new Storage({ documentsPath: app.getPath('documents'), safeStorage }).init();
  const source = new XActionsSource({
    profilePath: storage.paths.browserProfile,
    getSettings: () => storage.settings,
    log: (...args) => storage.log(...args),
  });
  const originals = new Map();
  const responseErrors = [];
  try {
    await source.start();
    source.page.on('response', async (response) => {
      const url = response.url();
      if (!/\/graphql\//i.test(url)) return;
      try {
        const contentType = String(response.headers()['content-type'] || '');
        if (!contentType.includes('json')) return;
        collectOriginalPosts(await response.json(), originals);
      } catch (error) {
        responseErrors.push(String(error?.message || error));
      }
    });
    const visible = await source.scrapeTweets(source.page, storage.settings.x.handle, {
      limit: 8,
      maxPasses: 12,
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const domHints = await source.page.evaluate(() => [...document.querySelectorAll('article[data-testid="tweet"]')]
      .slice(0, 5)
      .map((article) => ({
        labels: [...article.querySelectorAll('button, [role="button"], a, span')]
          .map((node) => ({ text: node.textContent?.trim() || '', aria: node.getAttribute('aria-label') || '' }))
          .filter((item) => /original|translat|grok|原文|翻译|翻譯/i.test(`${item.text} ${item.aria}`))
          .slice(0, 12),
      })));
    const comparison = visible.map((post) => ({
      id: post.id,
      url: post.url,
      visibleText: post.displayedText || post.text,
      restoredText: post.text,
      independentlyCapturedSourceText: originals.get(post.id) || null,
      exactMatch: originals.has(post.id) ? originals.get(post.id) === post.text : null,
      textSource: post.textSource || 'visible_dom',
      wasTranslated: Boolean(post.wasTranslated),
    }));
    console.log(JSON.stringify({
      ok: true,
      visibleCount: visible.length,
      structuredCount: originals.size,
      matchedCount: comparison.filter((item) => item.independentlyCapturedSourceText).length,
      differingCount: comparison.filter((item) => item.independentlyCapturedSourceText && !item.exactMatch).length,
      comparison,
      domHints,
      responseErrorCount: responseErrors.length,
    }, null, 2));
  } finally {
    await source.close();
    keeper.destroy();
    app.quit();
  }
}).catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error.code || null, message: error.message }));
  app.exit(1);
});
