'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEventMessage, Mailer } = require('../src/lib/mailer.cjs');

const mail = {
  username: 'sender@example.com',
  from: '',
  announcedSubject: '即将重置',
  completedSubject: '已经重置',
};
const event = {
  id: 'evt_test',
  type: 'reset_announced',
  confidence: 0.98,
  effectiveAt: '未来一小时内',
  summary: '即将重置用量限额',
  translationZh: '新的一天，付费用户的使用额度即将重置。',
};
const post = {
  timestamp: '2026-07-29T00:00:00.000Z',
  url: 'https://x.com/thsottiaux/status/1?x=<unsafe>',
  text: 'New day & new usage reset.\nLands in the next hour.',
};

test('event email contains the complete original post and Chinese translation', () => {
  const message = buildEventMessage(event, post, mail);

  assert.equal(message.subject, '即将重置');
  assert.match(message.text, /原文：\nNew day & new usage reset\.\nLands in the next hour\./);
  assert.match(message.text, /中文翻译：\n新的一天，付费用户的使用额度即将重置。/);
  assert.match(message.html, /New day &amp; new usage reset\./);
  assert.match(message.html, /中文翻译/);
  assert.doesNotMatch(message.html, /\?x=<unsafe>/);
});

test('SMTP test sends the same visible original-and-translation template', async () => {
  let captured = null;
  const mailer = new Mailer({
    getSettings: () => ({
      mail: { ...mail, host: 'smtp.qq.com', port: 465, secure: true, recipients: ['recipient@example.com'] },
    }),
    getPassword: () => 'test-only-password',
    log: () => {},
  });
  mailer.transport = () => ({
    async sendMail(payload) {
      captured = payload;
      return { messageId: 'test-message', accepted: ['recipient@example.com'] };
    },
  });

  const result = await mailer.test();

  assert.equal(result.ok, true);
  assert.equal(result.accepted, 1);
  assert.match(captured.subject, /邮件模板测试/);
  assert.match(captured.text, /原文：/);
  assert.match(captured.text, /中文翻译：/);
  assert.match(captured.html, /New day, new usage reset/);
});
