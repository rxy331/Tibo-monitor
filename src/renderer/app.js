'use strict';

let snapshot = null;
let toastTimer = null;
let xUiBusy = false;
let browserProfiles = [];
let browserProfileLoading = false;
let smtpRecipients = [];
let recipientSaveQueue = Promise.resolve();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const PAGE_META = {
  overview: ['MONITORING OVERVIEW', '监控概览'],
  activity: ['POST ANALYSIS', '动态与 AI 判断'],
  alerts: ['NOTIFICATION HISTORY', '预警历史'],
  settings: ['LOCAL CONFIGURATION', '设置'],
  about: ['ABOUT & PRIVACY', '关于'],
};

function formatTime(value, fallback = '尚未检查') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function itemTimeValue(item) {
  const candidates = [
    item?.tweetAt,
    item?.eventAt,
    item?.createdAt,
    item?.post?.tweetAt,
    item?.post?.eventAt,
    item?.post?.createdAt,
    item?.post?.timestamp,
    item?.analysis?.createdAt,
    item?.fetchedAt,
    item?.timestamp,
  ];
  for (const candidate of candidates) {
    const time = Date.parse(candidate);
    if (Number.isFinite(time)) return time;
  }
  return 0;
}

function sortNewestFirst(items) {
  return [...(Array.isArray(items) ? items : [])].sort((left, right) => itemTimeValue(right) - itemTimeValue(left));
}

function isExcludedPost(record) {
  return Boolean(record?.ignored || record?.excludedReason || record?.post?.ignored || record?.post?.excludedReason);
}

function isSupersededEvent(event) {
  // classifier v2 migration can keep a verified event while superseding only
  // its old notification attempt. An explicit valid verdict always wins over
  // legacy event-level superseded markers such as `supersededAt`.
  if (event?.validity === 'valid') return false;
  return Boolean(
    event?.validity === 'superseded' ||
    event?.status === 'superseded' ||
    event?.supersededAt,
  );
}

function eventNotificationLabel(event = {}) {
  if (event.notificationStatus === 'superseded' || event.notificationSupersededAt) {
    return '旧版邮件已停止重试';
  }
  if (event.needsHumanReview) return '人工复核 · 不通知';
  return ({
    sent: '邮件已发送',
    failed: '邮件发送失败',
    waiting_for_mail_config: '等待邮件配置',
    pending: '等待发送',
    not_required: '无需通知',
  }[event.notificationStatus] || '状态未知');
}

function alertHistoryView(rawEvents = [], legacyAudit = {}) {
  const allEvents = sortNewestFirst(rawEvents);
  const events = allEvents.filter((event) => !isSupersededEvent(event));
  const visibleIds = new Set(events.map((event) => String(event?.id || '')).filter(Boolean));
  const hiddenIds = new Set(
    allEvents
      .filter(isSupersededEvent)
      .map((event) => String(event?.id || ''))
      .filter(Boolean),
  );
  for (const id of Array.isArray(legacyAudit?.supersededEventIds) ? legacyAudit.supersededEventIds : []) {
    const normalized = String(id || '');
    if (normalized && !visibleIds.has(normalized)) hiddenIds.add(normalized);
  }
  return { allEvents, events, hiddenCount: hiddenIds.size };
}

function pollCounts(result = {}) {
  const numeric = (value) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
  return {
    freshCount: numeric(result.freshCount ?? result.fresh ?? result.newCount),
    newEventCount: numeric(result.newEventCount),
    retriedCount: numeric(result.retriedCount),
    sentCount: numeric(result.sentCount),
  };
}

function pollDisplaySource(nextSnapshot, fallbackResult = {}) {
  return nextSnapshot?.runtime && typeof nextSnapshot.runtime === 'object'
    ? nextSnapshot.runtime
    : fallbackResult;
}

function clampPollInterval(value, fallback = 15) {
  const numeric = Number(value);
  const normalized = Number.isFinite(numeric) ? Math.round(numeric) : fallback;
  return Math.min(30, Math.max(5, normalized));
}

function formatPollResult(result = {}) {
  const counts = pollCounts(result);
  if (counts.freshCount === 0 && counts.sentCount > 0) {
    return `无新帖，补发 ${counts.sentCount} 封历史提醒；新信号 ${counts.newEventCount} 条，历史重试 ${counts.retriedCount} 封。`;
  }
  if (counts.freshCount === 0 && counts.retriedCount > 0) {
    return `无新帖；历史提醒重试 ${counts.retriedCount} 封，发送成功 ${counts.sentCount} 封，新信号 ${counts.newEventCount} 条。`;
  }
  const prefix = String(result.message || '').includes('基线已建立') ? '基线已建立' : counts.freshCount === 0 ? '无新帖' : '轮询完成';
  return `${prefix} · 新帖 ${counts.freshCount} 条 · 新信号 ${counts.newEventCount} 条 · 历史重试 ${counts.retriedCount} 封 · 已发送 ${counts.sentCount} 封`;
}

function escapeText(value) {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
}

function normalizeRecipientValues(value) {
  const groups = Array.isArray(value) ? value : [value];
  const recipients = [];
  const seen = new Set();
  for (const group of groups) {
    for (const item of String(group || '').split(/[;,\n]/)) {
      const address = item.trim();
      const key = address.toLowerCase();
      if (!address || seen.has(key)) continue;
      seen.add(key);
      recipients.push(address);
    }
  }
  return recipients;
}

function renderRecipientList() {
  const list = $('#smtp-recipient-list');
  if (!list) return;
  list.innerHTML = smtpRecipients.map((address, index) => `
    <span class="recipient-chip"><span>${escapeText(address)}</span><button type="button" class="recipient-remove" data-recipient-index="${index}" aria-label="删除 ${escapeText(address)}">×</button></span>
  `).join('');
  const hint = $('#smtp-recipient-hint');
  if (hint) hint.textContent = smtpRecipients.length
    ? `已添加 ${smtpRecipients.length} 个收件邮箱；添加或删除后会自动保存。`
    : '尚未添加收件邮箱；添加或删除后会自动保存。';
}

function addRecipientFromInput({ announce = true } = {}) {
  const input = $('#smtp-recipient-input');
  const address = String(input?.value || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    if (announce) showToast('邮箱格式不正确', '请输入完整的邮箱地址。', 'error');
    return false;
  }
  if (!smtpRecipients.some((item) => item.toLowerCase() === address.toLowerCase())) smtpRecipients.push(address);
  if (input) input.value = '';
  renderRecipientList();
  return true;
}

function persistRecipientList(successMessage) {
  const requestedRecipients = [...smtpRecipients];
  const run = async () => {
    const hint = $('#smtp-recipient-hint');
    if (hint) hint.textContent = '正在自动保存收件人列表…';
    const result = await window.tibo.saveMailRecipients(requestedRecipients);
    if (!result?.ok) {
      renderRecipientList();
      showToast('收件人自动保存失败', result?.message || '无法写入本地设置。', 'error', 10000);
      return false;
    }
    snapshot = result.snapshot;
    render(result.snapshot, { fillSettings: false });
    if (hint) hint.textContent = `已自动保存 ${result.recipients.length} 个收件邮箱。`;
    showToast('收件人已自动保存', successMessage);
    return true;
  };
  recipientSaveQueue = recipientSaveQueue.then(run, run);
  return recipientSaveQueue;
}

async function addRecipientAndSave() {
  const before = smtpRecipients.length;
  if (!addRecipientFromInput()) return false;
  if (smtpRecipients.length === before) {
    showToast('收件人已存在', '该邮箱已在收件人列表中。');
    return true;
  }
  return persistRecipientList('新收件邮箱已写入本地文档。');
}

function showToast(title, message, state = 'success', duration = 4500) {
  clearTimeout(toastTimer);
  const visualState = state === true ? 'error' : state === false ? 'success' : state;
  $('#toast-title').textContent = title;
  $('#toast-message').textContent = message || '';
  $('#toast-icon').textContent = visualState === 'error' ? '!' : visualState === 'loading' ? '…' : '✓';
  $('#toast').classList.toggle('error', visualState === 'error');
  $('#toast').classList.toggle('loading', visualState === 'loading');
  $('#toast').classList.add('show');
  toastTimer = setTimeout(() => $('#toast').classList.remove('show'), duration);
}

function setTestStatus(kind, state, title, message) {
  [kind, `overview-${kind}`].forEach((prefix) => {
    const container = $(`#${prefix}-test-status`);
    if (!container) return;
    container.dataset.state = state;
    $(`#${prefix}-test-status-title`).textContent = title;
    $(`#${prefix}-test-status-message`).textContent = message || '';
  });
}

function selectedBrowserLabel() {
  return 'Mozilla Firefox';
}

function setProfileHint(message, state = 'idle') {
  const hint = $('#browser-profile-hint');
  if (!hint) return;
  hint.textContent = message;
  hint.dataset.state = state;
}

function syncXActionButtons() {
  const locked = xUiBusy || browserProfileLoading;
  ['check-now', 'activity-refresh', 'quick-test-x', 'open-x-login', 'test-x', 'choose-firefox-executable', 'clear-firefox-executable', 'refresh-firefox-profiles'].forEach((id) => {
    const button = $(`#${id}`);
    if (button) button.disabled = locked;
  });
  if (!locked) {
    const accepted = Boolean($('#accept-risk')?.checked);
    const hasProfile = browserProfiles.length > 0;
    $('#open-x-login').disabled = !accepted || !hasProfile;
    $('#test-x').disabled = !accepted || !hasProfile;
    $('#clear-firefox-executable').disabled = !$('#firefox-executable').value.trim();
    $('#refresh-firefox-profiles').disabled = browserProfileLoading;
  }
  const riskHint = $('#risk-required-hint');
  if (riskHint) riskHint.hidden = Boolean($('#accept-risk')?.checked);
}

function renderXConnection() {
  if (xUiBusy && $('#x-test-status')?.dataset.state === 'loading') return;
  const connection = snapshot?.state?.xConnection || {};
  const checked = connection.checkedAt ? ` · ${formatTime(connection.checkedAt)}` : '';
  const errorCode = connection.errorCode || '';
  if (errorCode === 'X_FIREFOX_PROFILES_FAILED') {
    setTestStatus('x', 'error', '所有 Firefox 资料均未通过验证', `${connection.message || '请先在日常 Firefox 中登录 X。'}${checked}`);
  } else if (errorCode.includes('PROFILE_NOT_FOUND') || errorCode === 'X_FIREFOX_PROFILE_NOT_REGISTERED') {
    setTestStatus('x', 'error', '未找到 Firefox 资料', `${connection.message || '没有检测到可用的 Firefox 资料。'} 请正常启动 Firefox 后重新检测。${checked}`);
  } else if (errorCode === 'X_BROWSER_PROFILE_COPY_FAILED') {
    setTestStatus('x', 'waiting', '暂时无法读取 Firefox 资料', `${connection.message || '请关闭 Firefox 后重试。'} 本轮不会移动水位线。${checked}`);
  } else if (connection.status === 'connected') {
    const browser = connection.browser || selectedBrowserLabel();
    const newest = connection.newestAt ? `，最新动态 ${formatTime(connection.newestAt)}` : '';
    setTestStatus('x', 'success', `已连接 ${connection.handle || `@${snapshot.settings.x.handle}`}`, `${browser} · 读取 ${connection.count || 0} 条${newest} · 临时快照已删除${checked}`);
  } else if (connection.status === 'login_required') {
    setTestStatus('x', 'error', 'Firefox 尚未登录 X', `${connection.message || '请在日常 Firefox 中登录 X 后再测试。'}${checked}`);
  } else if (connection.status === 'waiting_login') {
    setTestStatus('x', 'waiting', 'Firefox 已打开', `${connection.message || '请完成 X 登录，然后回来测试。'}`);
  } else if (connection.status === 'error') {
    setTestStatus('x', 'error', 'X 连接验证失败', `${connection.message || '请按提示重试。'}${checked}`);
  } else {
    setTestStatus('x', 'idle', '等待测试 Firefox 登录', '测试时会自动查找已登录 X 的 Firefox 资料。');
  }
}

function renderAiConnection() {
  if ($('#ai-test-status')?.dataset.state === 'loading') return;
  const connection = snapshot?.state?.aiConnection || {};
  const checked = connection.checkedAt ? ` · ${formatTime(connection.checkedAt)}` : '';
  if (connection.status === 'connected') {
    const confidence = Number.isFinite(Number(connection.confidence))
      ? ` · 样例置信度 ${Math.round(Number(connection.confidence) * 100)}%`
      : '';
    setTestStatus('ai', 'success', 'DeepSeek 连接正常', `${connection.message || `模型 ${connection.model || snapshot.settings.ai.model} 已通过测试。`}${confidence}${checked}`);
  } else if (connection.status === 'error') {
    setTestStatus('ai', 'error', 'DeepSeek 测试失败', `${connection.message || '请检查模型配置与 API Key。'}${checked}`);
  } else {
    setTestStatus('ai', 'idle', 'DeepSeek 尚未测试', connection.message || '测试后会在这里保留模型与判断结果。');
  }
}

function renderMailConnection() {
  if ($('#mail-test-status')?.dataset.state === 'loading') return;
  const connection = snapshot?.state?.mailConnection || {};
  const checked = connection.checkedAt ? ` · ${formatTime(connection.checkedAt)}` : '';
  if (connection.status === 'connected') {
    setTestStatus('mail', 'success', 'QQ 邮件连接正常', `${connection.message || '测试邮件已提交发送。'}${checked}`);
  } else if (connection.status === 'error') {
    setTestStatus('mail', 'error', 'QQ 邮件测试失败', `${connection.message || '请检查 SMTP 配置与授权码。'}${checked}`);
  } else {
    setTestStatus('mail', 'idle', 'QQ SMTP 尚未测试', connection.message || '测试会向已填写的收件邮箱发送一封配置确认邮件。');
  }
}

function setPage(name) {
  $$('.page').forEach((page) => page.classList.toggle('active', page.id === `page-${name}`));
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === name));
  const [eyebrow, title] = PAGE_META[name] || PAGE_META.overview;
  $('#page-eyebrow').textContent = eyebrow;
  $('#page-title').textContent = title;
}

function runtimeState() {
  const runtime = snapshot?.runtime || {};
  const enabled = Boolean(snapshot?.settings?.app?.monitoringEnabled);
  if (!enabled) return { key: 'paused', label: '监控已暂停' };
  if (runtime.busy) return { key: 'running', label: '正在检查' };
  if (runtime.lastError) return { key: 'degraded', label: '监控降级' };
  return { key: 'running', label: '监控运行中' };
}

function lifecycleLabel(status) {
  return { idle: '未发现', planned: '已预告', completed: '已完成', cancelled: '已取消' }[status] || '未发现';
}

function eventLabel(type) {
  return {
    reset_announced: ['准备重置', 'announced'],
    reset_completed: ['已经重置', 'completed'],
    reset_cancelled: ['计划取消', 'uncertain'],
    uncertain: ['需要复核', 'uncertain'],
  }[type] || ['无关', ''];
}

function renderPollSummary(result = {}, hasResult = true) {
  const counts = pollCounts(result);
  $('#poll-fresh-count').textContent = String(counts.freshCount);
  $('#poll-event-count').textContent = String(counts.newEventCount);
  $('#poll-retried-count').textContent = String(counts.retriedCount);
  $('#poll-sent-count').textContent = String(counts.sentCount);
  $('#poll-result-message').textContent = hasResult ? formatPollResult(result) : '尚未产生轮询结果';
}

function renderOverview() {
  const { settings, state, runtime } = snapshot;
  const orderedPosts = sortNewestFirst(state.posts).filter((record) => !isExcludedPost(record));
  const validEvents = sortNewestFirst(state.events).filter((event) => !isSupersededEvent(event));
  const current = runtimeState();
  const enabled = settings.app.monitoringEnabled;
  $('#side-status-dot').className = `status-dot ${current.key === 'running' ? '' : current.key}`;
  $('#side-status-text').textContent = current.label;
  $('#hero-dot').className = `status-dot ${current.key === 'running' ? '' : current.key}`;
  $('#hero-state').textContent = current.label;
  $('#monitor-toggle').classList.toggle('paused', !enabled);
  $('#monitor-toggle-label').textContent = enabled ? '暂停监控' : '开始监控';
  $('#top-last-check').textContent = formatTime(runtime.lastCheckAt);
  $('#hero-title').textContent = runtime.lastError ? '数据源需要你的关注' : enabled ? '正在守候 Tibo 的下一次重置信号' : '准备好监听 Tibo 的下一次信号';
  $('#hero-message').textContent = runtime.lastError || runtime.lastMessage || '首次检查只建立基线，不会为历史动态发送邮件。';
  $('#metric-handle').textContent = `@${settings.x.handle}`;
  $('#metric-interval').textContent = `约每 ${clampPollInterval(settings.x.pollIntervalMinutes)} 分钟`;
  $('#metric-posts').textContent = String(orderedPosts.length);
  $('#metric-cycle').textContent = lifecycleLabel(state.lifecycle.status);
  $('#metric-events').textContent = `${validEvents.length} 条有效信号`;
  renderPollSummary(runtime, Boolean(runtime.lastCheckAt));

  const recent = orderedPosts.slice(0, 4);
  $('#recent-posts').classList.toggle('empty-state', recent.length === 0);
  $('#recent-posts').innerHTML = recent.length ? recent.map((item) => `
    <div class="timeline-item">
      <span class="timeline-dot"></span>
      <div class="timeline-content">
        <p>${escapeText(item.post.text)}</p>
        <div class="timeline-meta">${formatTime(item.post.tweetAt || item.post.timestamp || item.tweetAt || item.createdAt, '时间未知')} · ${item.analysisStatus === 'complete' ? 'AI 已分析' : '等待分析'}</div>
      </div>
    </div>`).join('') : '尚无基线后的新动态';

  const lifeStatus = state.lifecycle.status;
  const order = ['idle', 'planned', 'completed'];
  const activeIndex = lifeStatus === 'cancelled' ? 1 : Math.max(0, order.indexOf(lifeStatus));
  $$('.life-node').forEach((node, index) => node.classList.toggle('active', index <= activeIndex));
  const latestEvent = validEvents[0];
  $('#latest-event').classList.toggle('empty-state', !latestEvent);
  $('#latest-event').innerHTML = latestEvent
    ? `<b>${escapeText(eventLabel(latestEvent.type)[0])} · ${Math.round(latestEvent.confidence * 100)}%</b><br>${escapeText(latestEvent.summary || latestEvent.reason)}<div class="timeline-meta">${formatTime(latestEvent.tweetAt || latestEvent.eventAt || latestEvent.createdAt)}</div>`
    : '尚未检测到额度重置信号';
}

function renderActivity() {
  const allPosts = sortNewestFirst(snapshot.state.posts);
  const posts = allPosts.filter((record) => !isExcludedPost(record));
  const legacyHiddenCount = Array.isArray(snapshot.state.legacyAudit?.ignoredPostIds) ? snapshot.state.legacyAudit.ignoredPostIds.length : 0;
  const hiddenCount = Math.max(allPosts.length - posts.length, legacyHiddenCount);
  $('#activity-audit-summary').hidden = hiddenCount === 0;
  $('#activity-audit-summary').textContent = hiddenCount ? `已隐藏 ${hiddenCount} 条回复、非目标帖子或旧版无效记录。` : '';
  $('#activity-list').classList.toggle('empty-state', posts.length === 0);
  $('#activity-list').innerHTML = posts.length ? posts.map((item) => {
    const finding = item.analysis?.result?.events?.find((event) => event.type !== 'none');
    const [baseLabel, cls] = finding
      ? eventLabel(finding.type)
      : item.analysisStatus === 'complete'
        ? ['AI 已分析 · 无信号', '']
        : [item.analysisStatus === 'error' ? '分析失败' : '等待分析', ''];
    const label = item.analysis?.result?.needs_human_review ? `${baseLabel} · 人工复核` : baseLabel;
    return `<article class="feed-item">
      <div class="feed-top"><div class="feed-meta"><span class="tag">@${escapeText(snapshot.settings.x.handle)}</span><span>${formatTime(item.post.tweetAt || item.post.timestamp || item.tweetAt || item.createdAt, '时间未知')}</span></div><span class="tag ${cls}">${label}${finding ? ` · ${Math.round(finding.confidence * 100)}%` : ''}</span></div>
      <p class="feed-text">${escapeText(item.post.text)}</p>
      <div class="feed-meta"><button class="text-button external" data-url="${escapeText(item.post.url)}">打开原帖 →</button>${item.analysisError ? `<span>${escapeText(item.analysisError)}</span>` : ''}</div>
    </article>`;
  }).join('') : '尚无基线后的新动态';
}

function renderAlerts() {
  const { events, hiddenCount } = alertHistoryView(snapshot.state.events, snapshot.state.legacyAudit);
  $('#alert-count').textContent = `${events.length} 条有效`;
  $('#alerts-audit-summary').hidden = hiddenCount === 0;
  $('#alerts-audit-summary').textContent = hiddenCount ? `已隐藏 ${hiddenCount} 条旧版误判；这些记录均已废弃且不会重发。` : '';
  $('#alerts-list').classList.toggle('empty-state', events.length === 0);
  $('#alerts-list').innerHTML = events.length ? events.map((event) => {
    const [label, cls] = eventLabel(event.type);
    const mailText = eventNotificationLabel(event);
    const post = snapshot.state.posts.find((item) => item.post.id === event.postId)?.post;
    return `<article class="alert-item">
      <div class="alert-top"><span class="tag ${cls}">${label}</span><span class="tag">${escapeText(mailText)}</span></div>
      <p class="feed-text"><b>${escapeText(event.summary || label)}</b></p>
      <div class="alert-meta"><span>置信度 ${Math.round(event.confidence * 100)}%</span><span>${formatTime(event.tweetAt || event.eventAt || event.createdAt)}</span>${post ? `<button class="text-button external" data-url="${escapeText(post.url)}">查看原帖 →</button>` : ''}</div>
    </article>`;
  }).join('') : '暂时没有预警事件';
}

function samePath(left, right) {
  return String(left || '').replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
    === String(right || '').replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
}

async function loadBrowserProfiles({ announce = false } = {}) {
  const refreshButton = $('#refresh-firefox-profiles');
  if (!refreshButton || browserProfileLoading) return;
  const browserLabel = 'Mozilla Firefox';
  browserProfileLoading = true;
  const oldText = refreshButton.textContent;
  refreshButton.textContent = '检测中…';
  refreshButton.setAttribute('aria-busy', 'true');
  setProfileHint(`正在读取 ${browserLabel} 的现有登录资料…`, 'loading');
  syncXActionButtons();
  try {
    const result = await window.tibo.listFirefoxProfiles();
    browserProfiles = Array.isArray(result?.profiles) ? result.profiles.filter((profile) => profile?.path) : [];
    if (!result?.ok || browserProfiles.length === 0) {
      const message = result?.reason || `请先正常启动 ${browserLabel} 并登录 X，然后刷新列表。`;
      setProfileHint(message, 'error');
      setTestStatus('x', 'error', '未找到 Firefox 登录资料', message);
      if (announce) showToast('未找到 Firefox 登录资料', message, 'error', 10000);
      return;
    }
    const savedPath = String(snapshot?.settings?.x?.firefoxProfilePath || '').trim();
    const savedProfile = browserProfiles.find((profile) => samePath(profile.path, savedPath));
    const remembered = savedProfile ? '，会先尝试上次成功的资料' : '';
    const message = `已检测到 ${browserProfiles.length} 个 Firefox 资料${remembered}；测试时会自动逐个验证并记住成功项。`;
    setProfileHint(message, 'success');
    if ($('#accept-risk')?.checked) {
      setTestStatus('x', 'idle', 'Firefox 资料已就绪', '点击测试后将在后台自动寻找已登录 X 的资料，无需手动选择。');
    } else {
      setTestStatus('x', 'waiting', '请先勾选风险确认', '勾选上方“我了解”后，测试按钮才会启用。');
    }
    if (announce) showToast('Firefox 资料检测完成', message);
  } catch (error) {
    browserProfiles = [];
    setProfileHint(error.message, 'error');
    setTestStatus('x', 'error', 'Firefox 资料检测失败', error.message);
    if (announce) showToast('Firefox 资料检测失败', error.message, 'error', 10000);
  } finally {
    browserProfileLoading = false;
    refreshButton.textContent = oldText;
    refreshButton.removeAttribute('aria-busy');
    syncXActionButtons();
  }
}

function fillForm() {
  const { settings, secrets, dataPath } = snapshot;
  $('#x-handle').value = settings.x.handle;
  $('#firefox-executable').value = settings.x.firefoxExecutablePath || '';
  $('#poll-interval').value = clampPollInterval(settings.x.pollIntervalMinutes);
  $('#fetch-limit').value = settings.x.fetchLimit;
  $('#accept-risk').checked = settings.app.acceptedXActionsRisk;
  $('#ai-url').value = settings.ai.baseUrl;
  $('#ai-model').value = settings.ai.model;
  $('#thinking-enabled').checked = settings.ai.thinkingEnabled;
  $('#smtp-host').value = settings.mail.host;
  $('#smtp-port').value = settings.mail.port;
  $('#smtp-user').value = settings.mail.username;
  smtpRecipients = normalizeRecipientValues(settings.mail.recipients);
  renderRecipientList();
  $('#smtp-secure').checked = settings.mail.secure;
  $('#mail-enabled').checked = settings.mail.enabled;
  $('#close-to-tray').checked = settings.app.closeToTray;
  $('#start-minimized').checked = settings.app.startMinimized;
  $('#data-path').textContent = dataPath;
  $('#ai-secret-dot').classList.toggle('ready', secrets.hasDeepSeekKey);
  $('#ai-secret-text').textContent = secrets.hasDeepSeekKey ? 'API Key 已由 Windows 安全存储加密' : '尚未保存密钥';
  $('#mail-secret-dot').classList.toggle('ready', secrets.hasSmtpPassword);
  $('#mail-secret-text').textContent = secrets.hasSmtpPassword ? 'SMTP 授权码已由 Windows 安全存储加密' : '尚未保存授权码';
  syncXActionButtons();
}

function render(nextSnapshot, { fillSettings = true } = {}) {
  snapshot = nextSnapshot;
  renderOverview();
  renderActivity();
  renderAlerts();
  if (fillSettings) fillForm();
  renderXConnection();
  renderAiConnection();
  renderMailConnection();
}

function readSettingsForm() {
  const next = structuredClone(snapshot.settings);
  next.x = {
    handle: $('#x-handle').value,
    firefoxExecutablePath: $('#firefox-executable').value,
    firefoxProfilePath: snapshot.settings.x.firefoxProfilePath || '',
    pollIntervalMinutes: clampPollInterval($('#poll-interval').value),
    fetchLimit: Number($('#fetch-limit').value),
  };
  next.ai.baseUrl = $('#ai-url').value;
  next.ai.model = $('#ai-model').value;
  next.ai.thinkingEnabled = $('#thinking-enabled').checked;
  next.mail.host = $('#smtp-host').value;
  next.mail.port = Number($('#smtp-port').value);
  next.mail.username = $('#smtp-user').value;
  next.mail.from = $('#smtp-user').value;
  next.mail.recipients = [...smtpRecipients];
  next.mail.secure = $('#smtp-secure').checked;
  next.mail.enabled = $('#mail-enabled').checked;
  next.app.closeToTray = $('#close-to-tray').checked;
  next.app.startMinimized = $('#start-minimized').checked;
  next.app.acceptedXActionsRisk = $('#accept-risk').checked;
  return next;
}

async function saveFromForm({ silent = false } = {}) {
  const result = await window.tibo.saveSettings({
    settings: readSettingsForm(),
    deepseekApiKey: $('#ai-key').value,
    smtpPassword: $('#smtp-password').value,
  });
  if (!result.ok) {
    if (!silent) showToast('保存失败', result.message, true);
    return false;
  }
  $('#ai-key').value = '';
  $('#smtp-password').value = '';
  render(result.snapshot);
  if (!silent) showToast('设置已保存', '配置已写入本机文档目录，敏感信息已加密。');
  return true;
}

function focusXSettings() {
  setPage('settings');
  requestAnimationFrame(() => $('#x-settings-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

function formatAiTest(result) {
  const [detected] = eventLabel(result.detected);
  return `模型 ${result.model} · 测试样例判断“${detected}” · 置信度 ${Math.round((result.confidence || 0) * 100)}%`;
}

function formatMailTest(result) {
  return `SMTP 已接受 ${result.accepted || 0} 位收件人，测试邮件已提交发送。`;
}

function xFailurePresentation(result = {}) {
  const code = result.code || result.errorCode || '';
  if (code === 'X_BROWSER_PROFILE_COPY_FAILED') return { state: 'waiting', title: '暂时无法读取 Firefox 资料' };
  if (code.includes('PROFILE_AMBIGUOUS')) return { state: 'waiting', title: '需要选择 Firefox 登录资料' };
  if (code.includes('PROFILE_NOT_FOUND') || code === 'X_FIREFOX_PROFILE_NOT_REGISTERED') return { state: 'error', title: '未找到 Firefox 登录资料' };
  if (['X_AUTH_REQUIRED', 'X_CHALLENGE_REQUIRED'].includes(code)) return { state: 'error', title: 'Firefox 尚未登录 X' };
  if (code === 'X_RISK_NOT_ACCEPTED') return { state: 'error', title: '请先确认 XActions 使用风险' };
  return { state: 'error', title: 'X 连接验证失败' };
}

async function withBusy(button, action, successTitle, options = {}) {
  const oldText = button.textContent;
  if (options.xOperation) {
    xUiBusy = true;
    syncXActionButtons();
  } else {
    button.disabled = true;
  }
  button.setAttribute('aria-busy', 'true');
  button.textContent = options.busyText || '处理中…';
  if (options.statusKind) {
    setTestStatus(options.statusKind, 'loading', options.pendingTitle || '正在测试', options.pendingMessage || '正在等待服务响应…');
  }
  if (options.pendingTitle) {
    showToast(options.pendingTitle, options.pendingMessage || '正在处理，请稍候。', 'loading', 90000);
  }
  try {
    const result = await action();
    if (result?.ok) {
      const message = options.formatSuccess ? options.formatSuccess(result) : result.message || '操作已完成。';
      if (options.statusKind) {
        setTestStatus(options.statusKind, options.successState || 'success', options.successStatusTitle || successTitle, message);
      }
      showToast(successTitle, message, options.successState === 'waiting' ? 'loading' : 'success');
    } else {
      const message = result?.message || '未知错误';
      const failureState = options.failureState ? options.failureState(result) : 'error';
      const failureTitle = typeof options.failureTitle === 'function' ? options.failureTitle(result) : options.failureTitle;
      if (options.statusKind) setTestStatus(options.statusKind, failureState, failureTitle || '测试失败', message);
      showToast(failureTitle || '操作失败', message, failureState === 'waiting' ? 'loading' : 'error', 10000);
      if (options.xOperation && (['X_AUTH_REQUIRED', 'X_CHALLENGE_REQUIRED', 'X_RISK_NOT_ACCEPTED', 'X_BROWSER_PROFILE_COPY_FAILED'].includes(result?.code) || String(result?.code || '').includes('PROFILE_'))) {
        focusXSettings();
      }
    }
    return result;
  } catch (error) {
    const failureTitle = typeof options.failureTitle === 'function' ? options.failureTitle(error) : options.failureTitle;
    if (options.statusKind) setTestStatus(options.statusKind, 'error', failureTitle || '测试失败', error.message);
    showToast(failureTitle || '操作失败', error.message, 'error', 10000);
    return { ok: false };
  } finally {
    button.textContent = oldText;
    button.removeAttribute('aria-busy');
    if (options.xOperation) {
      xUiBusy = false;
      syncXActionButtons();
    } else {
      button.disabled = false;
    }
  }
}

function bindEvents() {
  $$('.nav-item').forEach((item) => item.addEventListener('click', () => setPage(item.dataset.page)));
  $$('[data-go]').forEach((item) => item.addEventListener('click', () => setPage(item.dataset.go)));
  document.addEventListener('click', (event) => {
    const target = event.target.closest('.external');
    if (target?.dataset.url) window.tibo.openExternal(target.dataset.url);
  });

  $('#monitor-toggle').addEventListener('click', async () => {
    const result = await window.tibo.toggleMonitor(!snapshot.settings.app.monitoringEnabled);
    if (result.ok) render(result.snapshot);
    else { showToast('无法启动监控', result.message, 'error', 10000); focusXSettings(); }
  });
  const runCheck = (button) => {
    return withBusy(button, async () => {
      const result = await window.tibo.checkNow();
      let latestSnapshot = result?.snapshot;
      if (!latestSnapshot?.runtime) {
        try {
          latestSnapshot = await window.tibo.getState();
        } catch {
          latestSnapshot = null;
        }
      }
      if (latestSnapshot?.runtime) {
        render(latestSnapshot, { fillSettings: false });
      } else {
        renderPollSummary(pollDisplaySource(latestSnapshot, result), true);
      }
      return result;
    }, '检查完成', {
      xOperation: true,
      statusKind: 'x',
      busyText: '正在读取 X…',
      pendingTitle: '正在使用 Firefox 资料检查 X',
      pendingMessage: '正在自动寻找可用资料并读取临时快照；完成后会立即删除。',
      failureTitle: (result) => xFailurePresentation(result).title,
      failureState: (result) => xFailurePresentation(result).state,
      successStatusTitle: 'Firefox 登录与读取均正常',
      formatSuccess: (result) => `${formatPollResult(result)} 临时资料快照已删除。`,
    });
  };
  const runXTest = (button, saveFirst = false) => {
    return withBusy(button, async () => {
      if (saveFirst && !await saveFromForm({ silent: true })) return { ok: false, message: '请先保存有效配置。' };
      const result = await window.tibo.testX();
      if (result?.ok && result.profile?.path) {
        snapshot.settings.x.firefoxProfilePath = result.profile.path;
      }
      return result;
    }, 'X 连接正常', {
      xOperation: true,
      statusKind: 'x',
      busyText: '正在测试 Firefox…',
      pendingTitle: '正在测试 Firefox 登录',
      pendingMessage: '正在后台逐个验证 Firefox 资料，找到可用项后读取最近动态并自动记住。',
      failureTitle: (result) => xFailurePresentation(result).title,
      failureState: (result) => xFailurePresentation(result).state,
      successStatusTitle: 'Firefox 登录与读取均正常',
      formatSuccess: (result) => `${result.message}${result.newestAt ? ` 最新动态：${formatTime(result.newestAt)}` : ''} 临时资料快照已删除。`,
    });
  };
  const runAiTest = (button, saveFirst = false) => withBusy(button, async () => {
    if (saveFirst && !await saveFromForm({ silent: true })) return { ok: false, message: '请先保存有效配置。' };
    return window.tibo.testAi();
  }, 'DeepSeek 连接正常', {
    statusKind: 'ai',
    busyText: '正在测试 AI…',
    pendingTitle: '正在测试 DeepSeek',
    pendingMessage: '正在发送一条不会触发通知的分类样例。',
    failureTitle: 'DeepSeek 测试失败',
    formatSuccess: formatAiTest,
  });

  $('#check-now').addEventListener('click', (event) => runCheck(event.currentTarget));
  $('#activity-refresh').addEventListener('click', (event) => runCheck(event.currentTarget));
  $('#quick-test-x').addEventListener('click', (event) => runXTest(event.currentTarget));
  $('#quick-test-ai').addEventListener('click', (event) => runAiTest(event.currentTarget));
  $('#test-x').addEventListener('click', (event) => runXTest(event.currentTarget, true));
  const runXLogin = (button) => withBusy(button, async () => {
    if (!await saveFromForm({ silent: true })) return { ok: false, message: '请先保存有效配置。' };
    return window.tibo.openXLogin();
  }, 'Firefox 已打开', {
    xOperation: true,
    statusKind: 'x',
    successState: 'waiting',
    successStatusTitle: '请在 Firefox 中完成登录',
    busyText: '正在打开 Firefox…',
    pendingTitle: '正在打开 Firefox 登录资料',
    pendingMessage: '将打开上次成功或自动优先的现有资料，不创建软件专用登录。',
    failureTitle: (result) => xFailurePresentation(result).title,
    failureState: (result) => xFailurePresentation(result).state,
  });
  $('#open-x-login').addEventListener('click', (event) => runXLogin(event.currentTarget));
  $('#test-ai').addEventListener('click', (event) => runAiTest(event.currentTarget, true));
  $('#test-mail').addEventListener('click', (event) => withBusy(event.currentTarget, async () => {
    if (!await saveFromForm({ silent: true })) return { ok: false, message: '请先保存有效配置。' };
    return window.tibo.testMail();
  }, '测试邮件已发送', {
    statusKind: 'mail',
    busyText: '正在连接 SMTP…',
    pendingTitle: '正在测试 QQ SMTP',
    pendingMessage: '正在登录邮箱服务器并发送测试邮件，通常需要数秒。',
    failureTitle: 'QQ 邮件测试失败',
    formatSuccess: formatMailTest,
  }));
  $('#refresh-firefox-profiles').addEventListener('click', () => loadBrowserProfiles({ announce: true }));
  $('#accept-risk').addEventListener('change', () => {
    syncXActionButtons();
    if ($('#accept-risk').checked) {
      setTestStatus('x', 'idle', '可以测试 Firefox 登录', '测试时会自动逐个验证已检测到的 Firefox 资料。');
    } else {
      setTestStatus('x', 'waiting', '请先勾选风险确认', '勾选“我了解”后，测试与登录按钮才会启用。');
    }
  });
  $('#choose-firefox-executable').addEventListener('click', async () => {
    const result = await window.tibo.chooseFirefoxExecutable();
    if (result?.canceled) return;
    if (!result?.ok) {
      showToast('Firefox 选择失败', result?.message || '没有选择有效的 firefox.exe。', 'error', 10000);
      return;
    }
    $('#firefox-executable').value = result.path;
    await loadBrowserProfiles({ announce: false });
    setTestStatus('x', 'idle', `已选择 ${result.label}`, '测试时会自动查找已登录 X 的 Firefox 资料。');
    showToast('Firefox 程序已选择', `${result.label} · ${result.path}`);
    syncXActionButtons();
  });
  $('#clear-firefox-executable').addEventListener('click', () => {
    $('#firefox-executable').value = '';
    setTestStatus('x', 'idle', '已恢复 Firefox 自动检测', '测试时会自动查找已登录 X 的 Firefox 资料。');
    showToast('已清除 Firefox 程序路径', '保存后将从系统自动检测 Mozilla Firefox。');
    syncXActionButtons();
  });
  $('#add-smtp-recipient').addEventListener('click', () => { void addRecipientAndSave(); });
  $('#smtp-recipient-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void addRecipientAndSave();
    }
  });
  $('#smtp-recipient-list').addEventListener('click', (event) => {
    const button = event.target.closest('.recipient-remove');
    if (!button) return;
    const index = Number(button.dataset.recipientIndex);
    if (!Number.isInteger(index) || index < 0 || index >= smtpRecipients.length) return;
    smtpRecipients.splice(index, 1);
    renderRecipientList();
    void persistRecipientList('收件人删除结果已写入本地文档。');
  });
  $('#open-data').addEventListener('click', () => window.tibo.openData());
  $('#create-shortcut').addEventListener('click', (event) => withBusy(event.currentTarget, () => window.tibo.createShortcut(), '快捷方式已创建'));
  $('#settings-form').addEventListener('submit', async (event) => { event.preventDefault(); await saveFromForm(); });
}

function updateCountdown() {
  if (!snapshot) return;
  const next = snapshot.runtime.nextCheckAt ? new Date(snapshot.runtime.nextCheckAt).getTime() : 0;
  if (!next || !snapshot.settings.app.monitoringEnabled) {
    $('#metric-next').textContent = '—';
    return;
  }
  const seconds = Math.max(0, Math.floor((next - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  $('#metric-next').textContent = `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

async function init() {
  bindEvents();
  const initial = await window.tibo.getState();
  render(initial);
  await loadBrowserProfiles();
  if (initial.secrets?.warning) {
    showToast('本地密钥需要重新保存', initial.secrets.warning, true);
    setPage('settings');
  }
  window.tibo.onUpdate((next) => render(next, { fillSettings: false }));
  setInterval(updateCountdown, 1000);
  updateCountdown();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    alertHistoryView,
    clampPollInterval,
    eventNotificationLabel,
    formatPollResult,
    isExcludedPost,
    isSupersededEvent,
    itemTimeValue,
    pollCounts,
    pollDisplaySource,
    sortNewestFirst,
  };
}

if (typeof window !== 'undefined' && window.tibo) {
  init().catch((error) => showToast('界面初始化失败', error.message, true));
}
