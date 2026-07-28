'use strict';

const nodemailer = require('nodemailer');
const { escapeHtml, parseRecipients, safeError } = require('./utils.cjs');

class Mailer {
  constructor({ getSettings, getPassword, log }) {
    this.getSettings = getSettings;
    this.getPassword = getPassword;
    this.log = log;
  }

  config() {
    const mail = this.getSettings().mail;
    const password = this.getPassword();
    const recipients = parseRecipients(mail.recipients);
    if (!mail.host || !mail.username || !password || recipients.length === 0) {
      throw new Error('邮件配置不完整：请填写 SMTP 主机、账号、授权码和收件人。');
    }
    return { mail, password, recipients };
  }

  transport() {
    const { mail, password } = this.config();
    return nodemailer.createTransport({
      host: mail.host,
      port: mail.port,
      secure: mail.secure,
      auth: { user: mail.username, pass: password },
      connectionTimeout: 20000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
  }

  async test() {
    const { mail, recipients } = this.config();
    const transport = this.transport();
    const info = await transport.sendMail({
      from: mail.from || mail.username,
      to: recipients,
      subject: '[Tibo Monitor] 邮件连接测试成功',
      text: `Tibo Monitor 已成功连接 QQ SMTP。\n测试时间：${new Date().toLocaleString('zh-CN')}\n\n这是一封配置测试邮件。`,
    });
    this.log('info', 'SMTP test message sent.');
    return { ok: true, messageId: info.messageId, accepted: info.accepted?.length || 0 };
  }

  async sendEvent(event, post) {
    const { mail, recipients } = this.config();
    const isCompleted = event.type === 'reset_completed';
    const title = isCompleted ? mail.completedSubject : mail.announcedSubject;
    const confidence = `${Math.round(event.confidence * 100)}%`;
    const effective = event.effectiveAt || '未提取到明确时间';
    const transport = this.transport();
    const text = [
      event.summary || '检测到可能的额度重置动态。',
      '',
      `判断类型：${isCompleted ? '可能已经重置' : '可能准备重置'}`,
      `置信度：${confidence}`,
      `预计/生效时间：${effective}`,
      `原帖时间：${post.timestamp || '未知'}`,
      `原帖链接：${post.url}`,
      '',
      'AI 自动判断，请以 Tibo 原帖与实际账户状态为准。',
    ].join('\n');
    const html = `
      <div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:auto;color:#122033">
        <div style="background:#071a2d;color:white;border-radius:18px;padding:24px">
          <div style="font-size:13px;color:#36d7ff;letter-spacing:.08em">TIBO MONITOR</div>
          <h2 style="margin:8px 0 4px">${escapeHtml(event.summary || title)}</h2>
          <p style="margin:0;color:#b6c7d9">${isCompleted ? '检测到“已重置”信号' : '检测到“准备重置”信号'} · 置信度 ${confidence}</p>
        </div>
        <div style="padding:22px 8px;line-height:1.7">
          <p><b>预计/生效时间：</b>${escapeHtml(effective)}</p>
          <p><b>原帖时间：</b>${escapeHtml(post.timestamp || '未知')}</p>
          <p><a href="${escapeHtml(post.url)}" style="color:#087ea4">打开 Tibo 原帖</a></p>
          <p style="font-size:13px;color:#6b7788">AI 自动判断，请以 Tibo 原帖与实际账户状态为准。</p>
        </div>
      </div>`;
    try {
      const info = await transport.sendMail({
        from: mail.from || mail.username,
        to: recipients,
        subject: title,
        text,
        html,
        messageId: `<${event.id}@tibo-monitor.local>`,
      });
      this.log('info', `Notification sent for event ${event.id}.`);
      return { ok: true, messageId: info.messageId };
    } catch (error) {
      this.log('error', `Notification failed for event ${event.id}: ${safeError(error)}`);
      throw error;
    }
  }
}

module.exports = { Mailer };
