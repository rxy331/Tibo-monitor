'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { orderedFirefoxProfiles } = require('./firefox-profiles.cjs');
const { safeError } = require('./utils.cjs');
const {
  createXError,
  dedupeAndSortTweets,
  friendlyXError,
  normalizeTargetHandle,
  scrapeRecentTweets,
} = require('./xactions-tweets.cjs');

const FIREFOX_LABEL = 'Mozilla Firefox';
const RECENT_POST_WINDOW_MS = 30 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 2 * 60 * 1000;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function newestPostTimestamp(posts) {
  let newest = null;
  let newestMilliseconds = -Infinity;
  for (const post of Array.isArray(posts) ? posts : []) {
    const timestamp = post?.tweetAt || post?.createdAt || post?.timestamp || null;
    const milliseconds = Date.parse(timestamp || '');
    if (Number.isFinite(milliseconds) && milliseconds > newestMilliseconds) {
      newest = timestamp;
      newestMilliseconds = milliseconds;
    }
  }
  return newest;
}

function postTimestamp(post) {
  return post?.tweetAt || post?.createdAt || post?.timestamp || null;
}

function isPostInsideRecentWindow(post, nowMilliseconds) {
  const timestampMilliseconds = Date.parse(postTimestamp(post) || '');
  return Number.isFinite(timestampMilliseconds) &&
    timestampMilliseconds >= nowMilliseconds - RECENT_POST_WINDOW_MS &&
    timestampMilliseconds <= nowMilliseconds + FUTURE_CLOCK_SKEW_MS;
}

function attachPostMetadata(posts, metadata) {
  Object.defineProperties(posts, {
    observedHighWaterId: {
      configurable: false,
      enumerable: false,
      value: metadata.observedHighWaterId || null,
      writable: false,
    },
    newestAt: {
      configurable: false,
      enumerable: false,
      value: metadata.newestAt || null,
      writable: false,
    },
  });
  return posts;
}

function firefoxCandidates() {
  return [
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Mozilla Firefox', 'firefox.exe') : null,
    process.env['PROGRAMFILES(X86)'] ? path.join(process.env['PROGRAMFILES(X86)'], 'Mozilla Firefox', 'firefox.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Mozilla Firefox', 'firefox.exe') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Mozilla Firefox', 'firefox.exe') : null,
  ].filter(Boolean);
}

function isFirefoxExecutable(executablePath) {
  return path.basename(String(executablePath || '')).toLowerCase() === 'firefox.exe';
}

function readRegisteredFirefoxPath() {
  if (process.platform !== 'win32') return null;
  const keys = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe',
  ];
  for (const key of keys) {
    try {
      const output = execFileSync('reg.exe', ['query', key, '/ve'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const match = output.match(/REG_SZ\s+(.+)$/mi);
      const candidate = match?.[1]?.trim().replace(/^"|"$/g, '');
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // Try the next registry hive or normal install location.
    }
  }
  return null;
}

function findFirefoxExecutable(customPath = '') {
  const configuredPath = String(customPath || '').trim();
  if (configuredPath && isFirefoxExecutable(configuredPath) && fs.existsSync(configuredPath)) {
    return { kind: 'firefox', label: FIREFOX_LABEL, executablePath: configuredPath, source: 'custom' };
  }
  const registered = readRegisteredFirefoxPath();
  const executablePath = [registered, ...firefoxCandidates()].find((candidate) => candidate && fs.existsSync(candidate));
  if (executablePath) {
    return { kind: 'firefox', label: FIREFOX_LABEL, executablePath, source: registered === executablePath ? 'registry' : 'standard' };
  }
  return null;
}

function buildInteractiveLoginArgs(profile, url = 'https://x.com/home') {
  const identity = typeof profile === 'object' && profile ? profile : { path: profile, name: '', profileDirectory: '' };
  return identity.name ? ['-P', identity.name, '-new-window', url] : ['-profile', identity.path, '-new-window', url];
}

function profileLockPaths(profilePath) {
  return [path.join(profilePath, 'parent.lock'), path.join(profilePath, '.parentlock')];
}

function isLockFileOccupied(lockPath, fileSystem = fs) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(lockPath, fs.constants.O_RDONLY);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    if (['EACCES', 'EBUSY', 'EPERM'].includes(error?.code)) return true;
    return true;
  }

  try {
    fileSystem.closeSync(descriptor);
    return false;
  } catch {
    return true;
  }
}

function isProfileLocked(profilePath, fileSystem = fs) {
  if (!profilePath) return false;
  return profileLockPaths(profilePath).some((candidate) => isLockFileOccupied(candidate, fileSystem));
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(String(value || ''));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return Boolean(left && right) && normalize(left) === normalize(right);
}

class XActionsSource {
  constructor({
    profilePath,
    firefoxAppDataPath = '',
    getSettings,
    log,
    spawnBrowser = spawn,
    getPuppeteer = async () => (await import('puppeteer')).default,
    now = Date.now,
  }) {
    this.profilePath = profilePath;
    this.firefoxAppDataPath = firefoxAppDataPath || (process.env.APPDATA
      ? path.join(process.env.APPDATA, 'Mozilla', 'Firefox')
      : '');
    this.getSettings = getSettings;
    this.log = log;
    this.spawnBrowser = spawnBrowser;
    this.getPuppeteer = getPuppeteer;
    this.now = typeof now === 'function' ? now : () => Number(now);
    this.browser = null;
    this.browserProcess = null;
    this.page = null;
    this.activeOperation = null;
    this.activePromise = null;
    this.closePromise = null;
    this.browserLabel = null;
    this.firefoxExecutablePath = null;
    this.activeSnapshotRoot = null;
    this.activeProfileIdentity = null;
    this.lastProfileIdentity = null;
    this.preferredProfilePath = null;
    this.lastBrowserLabel = null;
    this.scrapeTweets = scrapeRecentTweets;
    this.lastFetchMetadata = { observedHighWaterId: null, newestAt: null };
  }

  selectedBrowser() {
    const settings = this.getSettings().x;
    return findFirefoxExecutable(settings.firefoxExecutablePath || '');
  }

  candidateProfiles() {
    const settings = this.getSettings().x;
    return orderedFirefoxProfiles({
      firefoxAppDataPath: this.firefoxAppDataPath,
      savedPath: settings.firefoxProfilePath || '',
      preferredPath: this.preferredProfilePath || '',
      tiboProfilePath: path.join(this.profilePath, 'firefox'),
    }).map((profile) => ({
      ...profile,
      mode: 'existing-snapshot',
      kind: 'firefox',
    }));
  }

  resolveProfileFor() {
    return this.candidateProfiles()[0];
  }

  profilePathFor(selected) {
    return this.resolveProfileFor(selected).path;
  }

  profileIsLocked(kind, profilePath) {
    return isProfileLocked(profilePath);
  }

  async waitForProfileRelease(kind, profilePath, attempts = 20) {
    if (!profilePath) return true;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!this.profileIsLocked(kind, profilePath)) return true;
      await sleep(250);
    }
    return !this.profileIsLocked(kind, profilePath);
  }

  firefoxProfileInUseError() {
    return createXError(
      'X_FIREFOX_PROFILE_IN_USE',
      'Firefox 日常登录资料正在被使用。请关闭所有 Firefox 窗口，等待几秒后重试；Tibo Monitor 不会终止普通 Firefox。',
    );
  }

  async waitForChildExit(child, timeoutMilliseconds) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        child.removeListener('error', onError);
        resolve(value);
      };
      const onExit = () => finish(true);
      // A failed spawn has no owned PID and therefore nothing to terminate.
      // Once a PID exists, an `error` event alone is not proof of exit.
      const onError = () => finish(
        !child.pid || child.exitCode !== null || child.signalCode !== null,
      );
      const timer = setTimeout(() => finish(false), timeoutMilliseconds);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  }

  async terminateOwnedFirefoxProcess(child) {
    if (!child) return true;
    let exited = await this.waitForChildExit(child, 5000);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      try { child.kill(); }
      catch { /* The exact child may have exited between the checks. */ }
      exited = await this.waitForChildExit(child, 5000);
    }
    if (!exited) this.log('warn', `Owned Firefox process ${child.pid || 'unknown'} did not confirm exit.`);
    if (exited && this.browserProcess === child) this.browserProcess = null;
    return exited;
  }

  snapshotCopyFilter(sourcePath) {
    const name = path.basename(sourcePath).toLowerCase();
    const excludedNames = new Set([
      'cache', 'code cache', 'gpucache', 'dawncache', 'shadercache', 'grshadercache',
      'crashpad', 'singletonlock', 'singletoncookie', 'singletonsocket',
      'parent.lock', '.parentlock', 'lock', 'lockfile',
      'login data', 'login data for account', 'logins.json', 'key3.db', 'key4.db',
      'history', 'history-journal', 'downloads', 'downloads-journal',
    ]);
    if (excludedNames.has(name)) return false;
    const portable = sourcePath.replaceAll('\\', '/').toLowerCase();
    return !portable.includes('/service worker/cachestorage/') && !portable.includes('/storage/default/http');
  }

  cleanupSnapshot(snapshotRoot = this.activeSnapshotRoot) {
    if (!snapshotRoot) return;
    try { fs.rmSync(snapshotRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); }
    catch (error) { this.log('warn', `Temporary browser snapshot cleanup failed: ${safeError(error)}`); }
    if (this.activeSnapshotRoot === snapshotRoot) this.activeSnapshotRoot = null;
  }

  createProfileSnapshot(profileIdentity) {
    const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-monitor-browser-'));
    try {
      const snapshotProfile = path.join(snapshotRoot, 'profile');
      fs.cpSync(profileIdentity.path, snapshotProfile, {
        recursive: true,
        filter: (sourcePath) => this.snapshotCopyFilter(sourcePath),
      });
      return { snapshotRoot, userDataDir: snapshotProfile };
    } catch (error) {
      this.cleanupSnapshot(snapshotRoot);
      throw createXError(
        'X_BROWSER_PROFILE_COPY_FAILED',
        '无法读取 Firefox 的现有登录资料。请关闭 Firefox 后重试。',
        error,
      );
    }
  }

  async start(requestedProfile = null) {
    const selected = this.selectedBrowser();
    if (!selected) {
      throw createXError('X_BROWSER_NOT_FOUND', '未找到 Mozilla Firefox。请点击“选择 Firefox EXE”指定 firefox.exe。');
    }
    const profileIdentity = requestedProfile || this.resolveProfileFor(selected);
    const connected = this.browser && (typeof this.browser.isConnected !== 'function' || this.browser.isConnected());
    const pageReady = this.page && (typeof this.page.isClosed !== 'function' || !this.page.isClosed());
    if (
      connected &&
      pageReady &&
      this.firefoxExecutablePath === selected.executablePath &&
      this.activeProfileIdentity?.mode === profileIdentity.mode &&
      samePath(this.activeProfileIdentity?.path, profileIdentity.path)
    ) return;
    if (this.browser || this.browserProcess) await this._close();

    const snapshot = this.createProfileSnapshot(profileIdentity);
    this.activeSnapshotRoot = snapshot.snapshotRoot;
    this.activeProfileIdentity = profileIdentity;
    try {
      const puppeteer = await this.getPuppeteer();
      this.browser = await puppeteer.launch({
        browser: 'firefox',
        executablePath: selected.executablePath,
        userDataDir: snapshot.userDataDir,
        headless: true,
        args: [],
      });
    } catch (error) {
      this.cleanupSnapshot(snapshot.snapshotRoot);
      this.activeProfileIdentity = null;
      throw createXError('X_BROWSER_START_FAILED', `${selected.label} 无法使用现有登录资料启动后台读取。`, error);
    }
    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1320, height: 860 });
    this.browserLabel = selected.label;
    this.firefoxExecutablePath = selected.executablePath;
    this.lastProfileIdentity = { ...profileIdentity };
    this.lastBrowserLabel = selected.label;
    this.log('info', `XActions browser started with a temporary ${selected.label} profile snapshot (headless).`);
  }

  shouldTryNextProfile(error) {
    return new Set([
      'X_AUTH_REQUIRED',
      'X_CHALLENGE_REQUIRED',
      'X_TIMELINE_EMPTY_OR_BLOCKED',
      'X_BROWSER_PROFILE_COPY_FAILED',
      'X_BROWSER_START_FAILED',
    ]).has(error?.code);
  }

  async runExclusive(label, action) {
    if (this.activeOperation) {
      throw createXError('X_BUSY', `X 正在${this.activeOperation}，请等待当前操作完成后再试。`);
    }
    this.activeOperation = label;
    const active = Promise.resolve().then(action);
    this.activePromise = active;
    try {
      return await active;
    } finally {
      if (this.activePromise === active) {
        this.activeOperation = null;
        this.activePromise = null;
      }
    }
  }

  async inspectHealth(posts) {
    const currentUrl = this.page?.url?.() || '';
    const authWall = this.page
      ? await this.page.$('a[href="/login"], input[autocomplete="username"], [data-testid="loginButton"]')
      : null;
    if (authWall || /\/i\/flow\/login/i.test(currentUrl)) {
      throw createXError(
        'X_AUTH_REQUIRED',
        '所选浏览器资料尚未登录 X。请点击“打开浏览器登录 X”，完成登录后再验证。',
      );
    }
    const profileShell = this.page
      ? await this.page.$('article[data-testid="tweet"], [data-testid="emptyState"]')
      : null;
    if ((!Array.isArray(posts) || posts.length === 0) && !profileShell) {
      throw createXError(
        'X_TIMELINE_EMPTY_OR_BLOCKED',
        `已连接 X，但没有读到 @${this.getSettings().x.handle} 的动态。请检查账号、网络，或登录窗口是否有验证提示。`,
      );
    }
  }

  async _fetchLatest({ limit, confirmLogin = false } = {}) {
    const settings = this.getSettings().x;
    const candidates = this.candidateProfiles();
    const failures = [];
    for (const [index, profile] of candidates.entries()) {
      try {
        await this.start(profile);
      const posts = await this.scrapeTweets(this.page, settings.handle, {
        limit: Number(limit || settings.fetchLimit),
      });
      await this.inspectHealth(posts);
      const targetHandle = normalizeTargetHandle(settings.handle);
      const fetchLimit = Number(limit || settings.fetchLimit);
      const observedOriginals = dedupeAndSortTweets(posts
        .filter((post) => post?.id)
        .filter((post) => normalizeTargetHandle(post.author) === targetHandle)
        .filter((post) => post.isReply === false)
        .filter((post) => post.isRetweet === false), fetchLimit);
      const observedHighWaterId = observedOriginals[0]?.id ? String(observedOriginals[0].id) : null;
      const normalized = observedOriginals
        .filter((post) => Boolean(String(post?.text || '').trim()))
        .map((post) => ({
          id: String(post.id),
          author: normalizeTargetHandle(post.author),
          text: String(post.text || '').trim(),
          timestamp: postTimestamp(post),
          tweetAt: postTimestamp(post),
          createdAt: postTimestamp(post),
          url: post.url || `https://x.com/${settings.handle}/status/${post.id}`,
          likes: Number(post.likes || 0),
          retweets: Number(post.retweets || 0),
          replies: Number(post.replies || 0),
          views: Number(post.views || 0),
          isQuote: Boolean(post.isQuote),
          isReply: false,
          isRetweet: false,
        }));
      const nowMilliseconds = Number(this.now());
      if (!Number.isFinite(nowMilliseconds)) throw new TypeError('Injected X source clock returned an invalid value.');
      const recentPosts = dedupeAndSortTweets(
        normalized.filter((post) => isPostInsideRecentWindow(post, nowMilliseconds)),
        fetchLimit,
      );
      const metadata = {
        observedHighWaterId,
        newestAt: newestPostTimestamp(recentPosts),
      };
      this.lastFetchMetadata = metadata;
      this.preferredProfilePath = profile.path;
      return attachPostMetadata(recentPosts, metadata);
      } catch (error) {
        const friendly = friendlyXError(error);
        failures.push({ profile, error: friendly });
        this.log('warn', `Firefox profile attempt ${index + 1}/${candidates.length} failed [${friendly.code || 'X_UNKNOWN'}].`);
        if (!this.shouldTryNextProfile(friendly) || index === candidates.length - 1) {
          if (candidates.length === 1 || !this.shouldTryNextProfile(friendly)) throw friendly;
          const summary = failures.map((item) => `${item.profile.name || '未命名资料'}：${item.error.code || 'X_UNKNOWN'}`).join('；');
          throw createXError(
            'X_FIREFOX_PROFILES_FAILED',
            `已自动尝试 ${failures.length} 个 Firefox 资料，均未能验证 X 登录（${summary}）。请先在日常 Firefox 中登录 X，再关闭 Firefox 后重试。`,
            friendly,
          );
        }
      } finally {
        let closeError = null;
        try {
          await this._close();
        } catch (error) {
          closeError = friendlyXError(error);
        }
        if (closeError) throw closeError;
      }
    }
    throw createXError('X_FIREFOX_PROFILES_FAILED', '没有可用于验证 X 登录的 Firefox 资料。');
  }

  async fetchLatest(options = {}) {
    return this.runExclusive('读取最新动态', () => this._fetchLatest(options));
  }

  async test() {
    return this.runExclusive('验证登录与读取动态', async () => {
      const posts = await this._fetchLatest({ limit: 5, confirmLogin: true });
      const handle = `@${this.getSettings().x.handle}`;
      return {
        ok: true,
        handle,
        count: posts.length,
        newestAt: posts.newestAt || null,
        observedHighWaterId: posts.observedHighWaterId || null,
        browser: this.lastBrowserLabel || this.browserLabel || 'Mozilla Firefox',
        profile: this.lastProfileIdentity ? { ...this.lastProfileIdentity } : null,
        message: `登录有效，已通过 ${this.lastBrowserLabel || this.browserLabel || 'Mozilla Firefox'} 读取 ${handle} 的 ${posts.length} 条最近动态。`,
      };
    });
  }

  async openLogin() {
    return this.runExclusive('打开登录窗口', async () => {
      const selected = this.selectedBrowser();
      if (!selected) {
        throw createXError('X_BROWSER_NOT_FOUND', '未找到 Mozilla Firefox。请点击“选择 Firefox EXE”指定 firefox.exe。');
      }
      const profileIdentity = this.resolveProfileFor(selected);
      await this._close();
      let child;
      try {
        child = this.spawnBrowser(
          selected.executablePath,
          buildInteractiveLoginArgs(profileIdentity),
          {
            detached: true,
            stdio: 'ignore',
            windowsHide: false,
            shell: false,
          },
        );
        child.unref?.();
      } catch (error) {
        throw createXError(
          'X_BROWSER_START_FAILED',
          `${selected.label} 无法启动。请检查浏览器安装和程序路径后重试。`,
          error,
        );
      }
      this.log('info', `Opened the selected existing ${selected.label} profile for interactive X login.`);
      return {
        ok: true,
        code: 'X_LOGIN_WINDOW_OPEN',
        browser: selected.label,
        executablePath: selected.executablePath,
        profile: { ...profileIdentity },
        message: `已用所选现有资料打开 ${selected.label}。请完成 X 登录；登录状态会由日常浏览器保存，不会创建软件专用资料。`,
      };
    });
  }

  async _close() {
    const browser = this.browser;
    const ownedFirefoxProcess = this.browserProcess;
    const activeProfileIdentity = this.activeProfileIdentity;
    const snapshotRoot = this.activeSnapshotRoot;
    let browserCloseIssue = null;
    if (browser) {
      const timedOut = Symbol('browser-close-timeout');
      const result = await Promise.race([
        Promise.resolve()
          .then(() => browser.close())
          .then(() => null, (error) => error),
        sleep(5000).then(() => timedOut),
      ]);
      if (result === timedOut) browserCloseIssue = new Error('等待后台浏览器会话关闭超时。');
      else if (result !== null) {
        browserCloseIssue = result instanceof Error ? result : new Error(String(result || '浏览器关闭失败。'));
      }
    }

    const processExited = ownedFirefoxProcess
      ? await this.terminateOwnedFirefoxProcess(ownedFirefoxProcess)
      : true;
    const requiresProfileRelease = activeProfileIdentity?.mode === 'existing' &&
      activeProfileIdentity?.kind === 'firefox' &&
      Boolean(activeProfileIdentity?.path);
    const profileReleased = requiresProfileRelease
      ? await this.waitForProfileRelease('firefox', activeProfileIdentity.path)
      : true;
    this.browser = null;
    this.page = null;
    this.browserLabel = null;
    this.firefoxExecutablePath = null;
    if (processExited && profileReleased) {
      if (this.browserProcess === ownedFirefoxProcess) this.browserProcess = null;
      this.activeProfileIdentity = null;
      this.cleanupSnapshot(snapshotRoot);
      if (browserCloseIssue) {
        this.log('warn', `Browser close reported an issue after its owned process exited: ${safeError(browserCloseIssue)}`);
      }
      return;
    }

    // Keep the retry identity until both the exact child exit and profile-lock
    // release have been confirmed. A later close() call can safely retry.
    if (!processExited) this.browserProcess = ownedFirefoxProcess;
    this.activeProfileIdentity = activeProfileIdentity;
    if (!processExited) {
      throw createXError(
        'X_FIREFOX_PROCESS_CLOSE_FAILED',
        `Tibo Monitor 启动的 Firefox 进程（PID ${ownedFirefoxProcess?.pid || '未知'}）未能确认退出。软件已保留该进程句柄供重试，不会终止普通 Firefox。请稍等后再次关闭或退出软件。`,
        browserCloseIssue,
      );
    }
    this.log('warn', 'Firefox profile lock remained active after the owned headless browser exited.');
    throw this.firefoxProfileInUseError();
  }

  close() {
    if (this.closePromise) return this.closePromise;
    const closing = (async () => {
      if (this.activePromise) {
        try { await this.activePromise; }
        catch { /* Closing after a failed operation is still required. */ }
      }
      await this._close();
    })();
    this.closePromise = closing;
    const clearClosing = () => {
      if (this.closePromise === closing) this.closePromise = null;
    };
    // Attach both handlers so clearing the shared identity cannot create an
    // unhandled rejection, while callers still receive the original promise.
    closing.then(clearClosing, clearClosing);
    return closing;
  }
}

module.exports = {
  FIREFOX_LABEL,
  XActionsSource,
  firefoxCandidates,
  buildInteractiveLoginArgs,
  findFirefoxExecutable,
  FUTURE_CLOCK_SKEW_MS,
  isLockFileOccupied,
  isPostInsideRecentWindow,
  isProfileLocked,
  newestPostTimestamp,
  postTimestamp,
  RECENT_POST_WINDOW_MS,
  isFirefoxExecutable,
  readRegisteredFirefoxPath,
};
