'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, safeStorage } = require('electron');
const { DeepSeekClient, SYSTEM_PROMPT, parseJsonContent, validateClassification } = require('../src/lib/deepseek.cjs');
const { Storage } = require('../src/lib/storage.cjs');
const { configureElectronDataPaths } = require('../src/lib/electron-paths.cjs');

configureElectronDataPaths(app);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const unquote = (block) => String(block || '').split(/\r?\n/).map((line) => line.replace(/^> ?/, '')).join('\n');
const quote = (value) => String(value || '').split(/\r?\n/).map((line) => `> ${line}`).join('\n');

async function requestAudit(client, post) {
  const system = `${SYSTEM_PROMPT}\n\nFor this audit, also add a top-level field named translation_zh containing a faithful Simplified Chinese translation of the entire current_post.text. Keep evidence in the original language.`;
  let raw;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      raw = parseJsonContent(await client.request([
        { role: 'system', content: system },
        { role: 'user', content: `Classify and translate this input:\n${JSON.stringify({ author: '@thsottiaux', current_post: post, recent_context: [], current_lifecycle: { status: 'idle' } })}` },
      ]));
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(1200);
    }
  }
  let translationZh = String(raw.translation_zh || '').trim();
  if (!translationZh) {
    const translated = parseJsonContent(await client.request([
      { role: 'system', content: 'Translate the complete text into faithful Simplified Chinese. Return JSON only: {"translation_zh":"..."}.' },
      { role: 'user', content: post.text },
    ]));
    translationZh = String(translated.translation_zh || '').trim();
  }
  if (!translationZh) throw new Error('模型仍未返回 translation_zh。');
  return { raw, translationZh, validated: validateClassification(raw, post.text) };
}

app.whenReady().then(async () => {
  const keeper = new BrowserWindow({ width: 1, height: 1, show: false });
  const reportPath = path.resolve(process.argv.at(-1));
  const storage = new Storage({ documentsPath: app.getPath('documents'), safeStorage }).init();
  const client = new DeepSeekClient({
    getSettings: () => storage.settings,
    getApiKey: () => storage.secrets.deepseekApiKey,
    log: (...args) => storage.log(...args),
  });
  const parts = fs.readFileSync(reportPath, 'utf8').split('\n\n---\n\n');
  let retried = 0;
  let succeeded = 0;
  for (let index = 0; index < parts.length; index += 1) {
    if (!parts[index].includes('请求失败：')) continue;
    retried += 1;
    const sectionStart = parts[index].indexOf('## ');
    const prefix = parts[index].slice(0, sectionStart);
    const section = parts[index].slice(sectionStart);
    const heading = section.match(/^## .+$/m)?.[0] || '## 未知时间';
    const id = section.match(/- ID：`([^`]+)`/)?.[1] || '';
    const url = section.match(/- 原帖：([^\r\n]+)/)?.[1] || '';
    const originalBlock = section.match(/### 原文\r?\n\r?\n([\s\S]*?)\r?\n\r?\n### 中文翻译/)?.[1] || '';
    const text = unquote(originalBlock);
    try {
      const result = await requestAudit(client, { id, timestamp: heading.replace(/^## \d+\. /, ''), text, url, is_quote: false, is_retweet: false });
      parts[index] = `${prefix}${heading}\n\n- 原帖：${url}\n- ID：\`${id}\`\n\n### 原文\n\n${quote(text)}\n\n### 中文翻译\n\n${quote(result.translationZh)}\n\n### 大模型原始返回\n\n\`\`\`json\n${JSON.stringify(result.raw, null, 2)}\n\`\`\`\n\n### 软件校验后结果\n\n\`\`\`json\n${JSON.stringify(result.validated, null, 2)}\n\`\`\``;
      succeeded += 1;
      console.log(`[重试] ${succeeded}/${retried} 完成 · ${id}`);
    } catch (error) {
      console.log(`[重试] 仍失败 · ${id} · ${error.message}`);
    }
    fs.writeFileSync(reportPath, parts.join('\n\n---\n\n'), 'utf8');
  }
  console.log(JSON.stringify({ ok: succeeded === retried, reportPath, retried, succeeded }));
  keeper.destroy();
  app.quit();
}).catch((error) => {
  console.error(JSON.stringify({ ok: false, message: error.message }));
  app.exit(1);
});
