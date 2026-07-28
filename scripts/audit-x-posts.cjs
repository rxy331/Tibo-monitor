'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, safeStorage } = require('electron');
const { DeepSeekClient, SYSTEM_PROMPT, parseJsonContent, validateClassification } = require('../src/lib/deepseek.cjs');
const { Storage } = require('../src/lib/storage.cjs');
const { XActionsSource } = require('../src/lib/xactions-source.cjs');
const { configureElectronDataPaths } = require('../src/lib/electron-paths.cjs');

configureElectronDataPaths(app);

// If the parent terminal is closed or times out, Windows reports subsequent
// console writes asynchronously as EPIPE. Exit the audit quietly instead of
// letting Electron display a repeating main-process JavaScript error dialog.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0);
  });
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function markdownQuote(value) {
  return String(value || '').split(/\r?\n/).map((line) => `> ${line}`).join('\n');
}

function renderReport({ posts, results, model, generatedAt }) {
  const completed = results.filter(Boolean).length;
  const sections = posts.map((post, index) => {
    const item = results[index];
    const heading = `## ${index + 1}. ${post.timestamp || '时间未知'}`;
    if (!item) {
      return `${heading}\n\n- 原帖：${post.url || '无'}\n- ID：\`${post.id}\`\n\n### 原文\n\n${markdownQuote(post.text)}\n\n### 中文翻译\n\n> 等待模型处理\n\n### 大模型返回结果\n\n等待模型处理。`;
    }
    if (item.error) {
      return `${heading}\n\n- 原帖：${post.url || '无'}\n- ID：\`${post.id}\`\n\n### 原文\n\n${markdownQuote(post.text)}\n\n### 中文翻译\n\n> 生成失败\n\n### 大模型返回结果\n\n\`请求失败：${String(item.error).replaceAll('`', '\\`')}\``;
    }
    return `${heading}\n\n- 原帖：${post.url || '无'}\n- ID：\`${post.id}\`\n\n### 原文\n\n${markdownQuote(post.text)}\n\n### 中文翻译\n\n${markdownQuote(item.translationZh)}\n\n### 大模型原始返回\n\n\`\`\`json\n${JSON.stringify(item.raw, null, 2)}\n\`\`\`\n\n### 软件校验后结果\n\n\`\`\`json\n${JSON.stringify(item.validated, null, 2)}\n\`\`\``;
  });
  return `# Tibo 最近原创帖 DeepSeek 审计\n\n- 生成时间：${generatedAt}\n- 模型：\`${model}\`\n- 抓取数量：${posts.length}\n- 已处理：${completed}/${posts.length}\n- 范围：Tibo 本人原创帖，排除回复和纯转推，不受应用的 30 分钟窗口限制\n- 说明：每条帖子均单独调用一次大模型；翻译为中文，证据保持原文。\n\n${sections.join('\n\n---\n\n')}\n`;
}

async function auditPost(client, post) {
  const auditPrompt = `${SYSTEM_PROMPT}\n\nFor this audit, also add a top-level field named translation_zh containing a faithful Simplified Chinese translation of the entire current_post.text. Keep evidence in the original language.`;
  const payload = {
    author: '@thsottiaux',
    current_post: {
      id: post.id,
      timestamp: post.timestamp,
      text: post.text,
      url: post.url,
      is_quote: Boolean(post.isQuote),
      is_retweet: false,
    },
    recent_context: [],
    current_lifecycle: { status: 'idle' },
  };
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const content = await client.request([
        { role: 'system', content: auditPrompt },
        { role: 'user', content: `Classify and translate this input:\n${JSON.stringify(payload)}` },
      ]);
      const raw = parseJsonContent(content);
      let translationZh = String(raw.translation_zh || '').trim();
      if (!translationZh) {
        const translationContent = await client.request([
          { role: 'system', content: 'Translate the complete text into faithful Simplified Chinese. Return JSON only: {"translation_zh":"..."}.' },
          { role: 'user', content: post.text },
        ]);
        translationZh = String(parseJsonContent(translationContent).translation_zh || '').trim();
      }
      if (!translationZh) throw new Error('模型未返回 translation_zh。');
      return {
        translationZh,
        raw,
        validated: validateClassification(raw, post.text),
      };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(1200);
    }
  }
  return { error: lastError?.message || String(lastError) };
}

app.whenReady().then(async () => {
  const keeper = new BrowserWindow({ width: 1, height: 1, show: false });
  const storage = new Storage({ documentsPath: app.getPath('documents'), safeStorage }).init();
  const source = new XActionsSource({
    profilePath: storage.paths.browserProfile,
    getSettings: () => storage.settings,
    log: (...args) => storage.log(...args),
  });
  const requestedLimit = Math.max(1, Math.min(100, Number(process.argv.at(-2) || 70)));
  const outputDirectory = path.resolve(process.argv.at(-1) || 'E:\\temp');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(outputDirectory, `Tibo-X-${requestedLimit}-posts-DeepSeek-audit-${stamp}.md`);
  let posts = [];
  try {
    console.log(`[抓取] 正在读取最近 ${requestedLimit} 条原创帖…`);
    await source.start();
    posts = await source.scrapeTweets(source.page, storage.settings.x.handle, {
      limit: requestedLimit,
      maxPasses: 60,
    });
    await source.inspectHealth(posts);
  } finally {
    await source.close();
  }
  if (posts.length === 0) throw new Error('没有抓取到可审计的原创帖。');

  fs.mkdirSync(outputDirectory, { recursive: true });
  const results = Array(posts.length).fill(null);
  const generatedAt = new Date().toISOString();
  fs.writeFileSync(outputPath, renderReport({ posts, results, model: storage.settings.ai.model, generatedAt }), 'utf8');
  console.log(`[抓取] 已获得 ${posts.length} 条，开始逐条调用 ${storage.settings.ai.model}。`);

  const client = new DeepSeekClient({
    getSettings: () => storage.settings,
    getApiKey: () => storage.secrets.deepseekApiKey,
    log: (...args) => storage.log(...args),
  });
  for (let index = 0; index < posts.length; index += 1) {
    results[index] = await auditPost(client, posts[index]);
    fs.writeFileSync(outputPath, renderReport({ posts, results, model: storage.settings.ai.model, generatedAt }), 'utf8');
    console.log(`[模型] ${index + 1}/${posts.length} ${results[index].error ? '失败' : '完成'} · ${posts[index].id}`);
    await sleep(250);
  }
  console.log(JSON.stringify({ ok: true, outputPath, fetched: posts.length, processed: results.filter(Boolean).length }));
  keeper.destroy();
  app.quit();
}).catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error.code || null, message: error.message }));
  app.exit(1);
});
