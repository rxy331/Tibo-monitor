'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { DEFAULT_SETTINGS, DEFAULT_STATE } = require('../src/lib/defaults.cjs');
const { backupLegacyJsonFile, sanitizeSettings } = require('../src/lib/utils.cjs');
const { parseJsonContent, validateClassification } = require('../src/lib/deepseek.cjs');
const { MonitorService } = require('../src/lib/monitor.cjs');
const { Storage } = require('../src/lib/storage.cjs');
const { getElectronDataPaths } = require('../src/lib/electron-paths.cjs');
const { listFirefoxProfiles, orderedFirefoxProfiles, resolveFirefoxProfile } = require('../src/lib/firefox-profiles.cjs');
const {
  XActionsSource,
  firefoxCandidates,
  buildInteractiveLoginArgs,
  findFirefoxExecutable,
  isLockFileOccupied,
  isProfileLocked,
  readRegisteredFirefoxPath,
} = require('../src/lib/xactions-source.cjs');
const { friendlyXError, safeScroll } = require('../src/lib/xactions-tweets.cjs');

function createFakeFirefoxChild({ killExits = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.finish = (code = 0, signal = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  child.kill = () => {
    child.killed = true;
    if (killExits) child.finish(null, 'SIGTERM');
    return true;
  };
  return child;
}

test('X health accepts a loaded profile when reply filtering leaves zero originals', async () => {
  const source = new XActionsSource({
    profilePath: 'unused',
    getSettings: () => ({ x: { handle: 'thsottiaux' } }),
    log: () => {},
  });
  source.page = {
    url: () => 'https://x.com/thsottiaux',
    $: async (selector) => selector.includes('article[data-testid="tweet"]') ? {} : null,
  };
  await source.inspectHealth([]);

  source.page.$ = async () => null;
  await assert.rejects(
    () => source.inspectHealth([]),
    (error) => error.code === 'X_TIMELINE_EMPTY_OR_BLOCKED',
  );
});

function createExistingFirefoxFixture(prefix = 'tibo-existing-bidi-') {
  const firefoxRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dailyProfile = path.join(firefoxRoot, 'Profiles', 'daily.default-release');
  const isolatedRoot = path.join(firefoxRoot, 'tibo-isolated');
  const fakeFirefox = path.join(firefoxRoot, 'firefox.exe');
  fs.mkdirSync(dailyProfile, { recursive: true });
  fs.writeFileSync(fakeFirefox, 'test-only');
  fs.writeFileSync(path.join(firefoxRoot, 'profiles.ini'),
    '[Profile0]\nName=daily\nIsRelative=1\nPath=Profiles/daily.default-release\nDefault=1\n', 'utf8');
  const settings = {
    x: {
      handle: 'thsottiaux',
      firefoxExecutablePath: fakeFirefox,
      firefoxProfilePath: dailyProfile,
      fetchLimit: 5,
      includeReplies: true,
      includeRetweets: false,
    },
  };
  return { firefoxRoot, dailyProfile, isolatedRoot, fakeFirefox, settings };
}

test('settings are normalized and unsafe numeric ranges are clamped', () => {
  const settings = sanitizeSettings({
    x: { handle: '@thi!sottiaux', pollIntervalMinutes: 0, fetchLimit: 999 },
    ai: { announcedThreshold: 0.1, completedThreshold: 2 },
  }, DEFAULT_SETTINGS);
  assert.equal(settings.x.handle, 'thisottiaux');
  assert.equal(settings.x.pollIntervalMinutes, 5);
  assert.equal(settings.x.fetchLimit, 100);
  assert.equal(settings.x.firefoxProfilePath, '');
  assert.equal(settings.x.firefoxExecutablePath, '');
  assert.equal(Object.hasOwn(settings.x, 'browser'), false);
  assert.equal(Object.hasOwn(settings.x, 'firefoxProfileMode'), false);
  assert.deepEqual(settings.mail.recipients, []);
  assert.equal(settings.ai.announcedThreshold, 0.5);
  assert.equal(settings.ai.completedThreshold, 1);

  const legacySixtyMinutePoll = sanitizeSettings({
    schemaVersion: 1,
    x: { pollIntervalMinutes: 60 },
  }, DEFAULT_SETTINGS);
  assert.equal(legacySixtyMinutePoll.x.pollIntervalMinutes, 30);

  const previousDefaultPoll = sanitizeSettings({
    schemaVersion: 3,
    x: { pollIntervalMinutes: 5 },
  }, DEFAULT_SETTINGS);
  assert.equal(previousDefaultPoll.x.pollIntervalMinutes, 15);
});

test('legacy settings and state are atomically backed up before schema migration', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-v2-backup-'));
  const settingsPath = path.join(tempRoot, 'settings.json');
  const statePath = path.join(tempRoot, 'state.json');
  const legacySettings = '{"schemaVersion":1,"x":{"includeReplies":true}}\n';
  const legacyState = '{"schemaVersion":1,"events":[{"id":"evt_old"}]}\n';
  fs.writeFileSync(settingsPath, legacySettings, 'utf8');
  fs.writeFileSync(statePath, legacyState, 'utf8');
  try {
    const settingsBackup = backupLegacyJsonFile(settingsPath);
    const stateBackup = backupLegacyJsonFile(statePath);
    assert.equal(path.basename(settingsBackup), 'settings.v1.backup.json');
    assert.equal(path.basename(stateBackup), 'state.v1.backup.json');
    assert.equal(fs.readFileSync(settingsBackup, 'utf8'), legacySettings);
    assert.equal(fs.readFileSync(stateBackup, 'utf8'), legacyState);

    fs.writeFileSync(settingsPath, '{"schemaVersion":2}\n', 'utf8');
    assert.equal(backupLegacyJsonFile(settingsPath), null);
    assert.equal(fs.readFileSync(settingsBackup, 'utf8'), legacySettings);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Firefox is the only supported browser and legacy browser choices are removed', () => {
  assert.ok(firefoxCandidates().every((candidate) => candidate.toLowerCase().endsWith('firefox.exe')));
  const migrated = sanitizeSettings({ x: { browser: 'edge', browserExecutablePath: 'C:\\Edge\\msedge.exe', browserProfilePath: 'C:\\Edge\\Default' } }, DEFAULT_SETTINGS);
  assert.equal(Object.hasOwn(migrated.x, 'browser'), false);
  assert.equal(Object.hasOwn(migrated.x, 'browserExecutablePath'), false);
  assert.equal(Object.hasOwn(migrated.x, 'browserProfilePath'), false);
  assert.equal(migrated.x.firefoxExecutablePath, '');
  assert.equal(migrated.x.firefoxProfilePath, '');
});

test('legacy Firefox settings migrate to a direct profile and isolated mode is removed', () => {
  const migrated = sanitizeSettings({
    x: { browser: 'firefox', firefoxProfileMode: 'isolated', firefoxProfilePath: '  C:\\Profiles\\Daily  ' },
    mail: { recipients: 'a@example.com, B@example.com; a@example.com' },
  }, DEFAULT_SETTINGS);
  assert.equal(migrated.x.firefoxProfilePath, 'C:\\Profiles\\Daily');
  assert.equal(Object.hasOwn(migrated.x, 'firefoxProfileMode'), false);
  assert.equal(Object.hasOwn(migrated.x, 'browserProfilePath'), false);
  assert.deepEqual(migrated.mail.recipients, ['a@example.com', 'B@example.com']);
});

test('Firefox profiles parse BOM and CRLF read-only and prefer a unique install default', () => {
  const firefoxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-firefox-profiles-'));
  const relativeProfile = path.join(firefoxRoot, 'Profiles', 'relative.default-release');
  const backgroundProfile = path.join(firefoxRoot, 'Profiles', 'background-task');
  const absoluteProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-firefox-absolute-'));
  fs.mkdirSync(relativeProfile, { recursive: true });
  fs.mkdirSync(backgroundProfile, { recursive: true });
  const profilesIni = path.join(firefoxRoot, 'profiles.ini');
  const installsIni = path.join(firefoxRoot, 'installs.ini');
  const profilesText = '\uFEFF[Profile7]\r\nName=relative-release\r\nIsRelative=1\r\nPath=Profiles/relative.default-release\r\n\r\n' +
    `[Profile2]\r\nName=absolute\r\nIsRelative=0\r\nPath=${absoluteProfile}\r\n\r\n` +
    '[InstallABC123]\r\nDefault=Profiles/relative.default-release\r\nLocked=1\r\n\r\n' +
    '[BackgroundTasksProfiles]\r\nTask=background-task\r\n';
  const installsText = '[ABC123]\r\nDefault=Profiles/relative.default-release\r\nLocked=1\r\n';
  fs.writeFileSync(profilesIni, profilesText, 'utf8');
  fs.writeFileSync(installsIni, installsText, 'utf8');
  const beforeProfiles = fs.readFileSync(profilesIni);
  const beforeInstalls = fs.readFileSync(installsIni);
  try {
    const listed = listFirefoxProfiles({ firefoxAppDataPath: firefoxRoot });
    assert.equal(listed.profiles.length, 2);
    assert.equal(listed.profiles.find((profile) => profile.id === 'Profile7').path, relativeProfile);
    assert.equal(listed.profiles.find((profile) => profile.id === 'Profile2').path, absoluteProfile);
    assert.equal(listed.profiles.find((profile) => profile.id === 'Profile7').isInstallDefault, true);

    const automatic = resolveFirefoxProfile({ firefoxAppDataPath: firefoxRoot });
    assert.equal(automatic.path, relativeProfile);
    assert.equal(automatic.selectionReason, 'install-default');

    const saved = resolveFirefoxProfile({ firefoxAppDataPath: firefoxRoot, savedPath: absoluteProfile });
    assert.equal(saved.path, absoluteProfile);
    assert.equal(saved.selectionReason, 'saved');
    assert.deepEqual(fs.readFileSync(profilesIni), beforeProfiles);
    assert.deepEqual(fs.readFileSync(installsIni), beforeInstalls);
  } finally {
    fs.rmSync(firefoxRoot, { recursive: true, force: true });
    fs.rmSync(absoluteProfile, { recursive: true, force: true });
  }
});

test('Firefox profile resolution uses a legacy default and then a sole registered profile', () => {
  const firefoxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-firefox-legacy-'));
  const first = path.join(firefoxRoot, 'Profiles', 'first');
  const second = path.join(firefoxRoot, 'Profiles', 'second');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  try {
    fs.writeFileSync(path.join(firefoxRoot, 'profiles.ini'),
      '[Profile9]\nName=first\nIsRelative=1\nPath=Profiles/first\nDefault=1\n\n' +
      '[Profile3]\nName=second\nIsRelative=1\nPath=Profiles/second\n', 'utf8');
    const legacy = resolveFirefoxProfile({ firefoxAppDataPath: firefoxRoot });
    assert.equal(legacy.path, first);
    assert.equal(legacy.selectionReason, 'legacy-default');

    fs.writeFileSync(path.join(firefoxRoot, 'profiles.ini'),
      '[Profile3]\nName=second\nIsRelative=1\nPath=Profiles/second\n', 'utf8');
    const only = resolveFirefoxProfile({ firefoxAppDataPath: firefoxRoot });
    assert.equal(only.path, second);
    assert.equal(only.selectionReason, 'only-profile');
  } finally {
    fs.rmSync(firefoxRoot, { recursive: true, force: true });
  }
});

test('Firefox automatic profile order prefers last success, saved, install default, and default-release', () => {
  const firefoxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-firefox-order-'));
  const names = ['plain', 'daily.default-release', 'install', 'remembered'];
  for (const name of names) fs.mkdirSync(path.join(firefoxRoot, 'Profiles', name), { recursive: true });
  fs.writeFileSync(path.join(firefoxRoot, 'profiles.ini'), names.map((name, index) =>
    `[Profile${index}]\nName=${name}\nIsRelative=1\nPath=Profiles/${name}\n`).join('\n'), 'utf8');
  fs.writeFileSync(path.join(firefoxRoot, 'installs.ini'), '[ABC]\nDefault=Profiles/install\nLocked=1\n', 'utf8');
  try {
    const ordered = orderedFirefoxProfiles({
      firefoxAppDataPath: firefoxRoot,
      savedPath: path.join(firefoxRoot, 'Profiles', 'plain'),
      preferredPath: path.join(firefoxRoot, 'Profiles', 'remembered'),
    });
    assert.deepEqual(ordered.map((profile) => profile.name), ['remembered', 'plain', 'install', 'daily.default-release']);
  } finally {
    fs.rmSync(firefoxRoot, { recursive: true, force: true });
  }
});

test('Firefox profile resolution rejects ambiguity, unregistered paths, missing paths, and Tibo profiles', () => {
  const firefoxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-firefox-reject-'));
  const first = path.join(firefoxRoot, 'Profiles', 'first');
  const second = path.join(firefoxRoot, 'Profiles', 'second');
  const missing = path.join(firefoxRoot, 'Profiles', 'missing');
  const unregistered = path.join(firefoxRoot, 'Profiles', 'unregistered');
  const tiboProfile = path.join(firefoxRoot, 'Documents', 'Tibo Monitor', 'browser-profile', 'firefox');
  for (const directory of [first, second, unregistered, tiboProfile]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(firefoxRoot, 'profiles.ini'),
    '[Profile0]\nName=first\nIsRelative=1\nPath=Profiles/first\n\n' +
    '[Profile1]\nName=second\nIsRelative=1\nPath=Profiles/second\n\n' +
    '[Profile2]\nName=missing\nIsRelative=1\nPath=Profiles/missing\n\n' +
    `[Profile3]\nName=tibo\nIsRelative=0\nPath=${tiboProfile}\n`, 'utf8');
  try {
    const options = { firefoxAppDataPath: firefoxRoot, tiboProfilePath: tiboProfile };
    const listed = listFirefoxProfiles(options);
    assert.deepEqual(listed.profiles.map((profile) => profile.name).sort(), ['first', 'second']);
    assert.deepEqual(listed.excludedProfiles.map((profile) => profile.reason).sort(), ['missing', 'tibo-profile']);
    assert.throws(() => resolveFirefoxProfile(options), (error) => error.code === 'X_FIREFOX_PROFILE_AMBIGUOUS');
    assert.throws(
      () => resolveFirefoxProfile({ ...options, savedPath: unregistered }),
      (error) => error.code === 'X_FIREFOX_PROFILE_NOT_REGISTERED',
    );
    assert.throws(
      () => resolveFirefoxProfile({ ...options, savedPath: missing }),
      (error) => error.code === 'X_FIREFOX_PROFILE_NOT_FOUND',
    );
    assert.throws(
      () => resolveFirefoxProfile({ ...options, savedPath: tiboProfile }),
      (error) => error.code === 'X_FIREFOX_PROFILE_FORBIDDEN',
    );
  } finally {
    fs.rmSync(firefoxRoot, { recursive: true, force: true });
  }
});

test('ordinary Firefox login arguments contain no automation flags', () => {
  const firefoxArgs = buildInteractiveLoginArgs({ path: 'C:\\Firefox\\Daily', name: 'daily' });
  assert.deepEqual(firefoxArgs.slice(0, 3), ['-P', 'daily', '-new-window']);
  assert.equal(firefoxArgs.some((item) => /enable-automation|remote-debugging|headless/i.test(item)), false);
});

test.skip('legacy interactive Firefox profile TOCTOU path was removed', async () => {
  const fixture = createExistingFirefoxFixture('tibo-login-profile-race-');
  const child = createFakeFirefoxChild();
  let lockChecks = 0;
  let spawnOptions = null;
  try {
    const source = new XActionsSource({
      profilePath: fixture.isolatedRoot,
      firefoxAppDataPath: fixture.firefoxRoot,
      getSettings: () => fixture.settings,
      log: () => {},
      spawnBrowser: (_executablePath, _args, options) => {
        spawnOptions = options;
        setImmediate(() => {
          child.stderr.write('Firefox startup stopped before opening a window.\n');
          child.finish(0, null);
        });
        return child;
      },
    });
    source.profileIsLocked = () => {
      lockChecks += 1;
      return lockChecks >= 2;
    };

    await assert.rejects(() => source.openLogin(), (error) => error.code === 'X_FIREFOX_PROFILE_IN_USE');
    assert.deepEqual(spawnOptions.stdio, ['ignore', 'ignore', 'pipe']);
    assert.equal(lockChecks, 2);
    assert.equal(source.awaitingLogin, false);
    assert.equal(source.activeOperation, null);
  } finally {
    fs.rmSync(fixture.firefoxRoot, { recursive: true, force: true });
  }
});

test.skip('legacy interactive Firefox startup arbitration was removed', async () => {
  const fixture = createExistingFirefoxFixture('tibo-login-start-failure-');
  const child = createFakeFirefoxChild();
  try {
    const source = new XActionsSource({
      profilePath: fixture.isolatedRoot,
      firefoxAppDataPath: fixture.firefoxRoot,
      getSettings: () => fixture.settings,
      log: () => {},
      spawnBrowser: () => {
        setImmediate(() => {
          child.stderr.write('unrelated fatal startup error\n');
          child.finish(2, null);
        });
        return child;
      },
    });
    source.profileIsLocked = () => false;

    await assert.rejects(() => source.openLogin(), (error) => error.code === 'X_BROWSER_START_FAILED');
    assert.equal(source.awaitingLogin, false);
    assert.equal(source.activeOperation, null);
  } finally {
    fs.rmSync(fixture.firefoxRoot, { recursive: true, force: true });
  }
});

test.skip('legacy in-place Firefox profile launch was replaced by temporary snapshots', async () => {
  const firefoxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-source-existing-'));
  const dailyProfile = path.join(firefoxRoot, 'Profiles', 'daily.default-release');
  const isolatedRoot = path.join(firefoxRoot, 'tibo-isolated');
  const fakeFirefox = path.join(firefoxRoot, 'firefox.exe');
  fs.mkdirSync(dailyProfile, { recursive: true });
  fs.writeFileSync(fakeFirefox, 'test-only');
  fs.writeFileSync(path.join(firefoxRoot, 'profiles.ini'),
    '[Profile0]\nName=daily\nIsRelative=1\nPath=Profiles/daily.default-release\nDefault=1\n', 'utf8');
  const settings = {
    x: {
      handle: 'thsottiaux',
      browser: 'chrome',
      browserExecutablePath: fakeFirefox,
      firefoxProfileMode: 'existing',
      firefoxProfilePath: dailyProfile,
      fetchLimit: 5,
      includeReplies: true,
      includeRetweets: false,
    },
  };
  try {
    const source = new XActionsSource({
      profilePath: isolatedRoot,
      firefoxAppDataPath: firefoxRoot,
      getSettings: () => settings,
      log: () => {},
    });
    const selected = source.selectedBrowser();
    assert.equal(selected.kind, 'firefox');
    assert.equal(source.profilePathFor(selected), dailyProfile);
    assert.equal(fs.existsSync(path.join(isolatedRoot, 'firefox')), false);

    source.profileIsLocked = () => true;
    await assert.rejects(() => source.start(), (error) => error.code === 'X_FIREFOX_PROFILE_IN_USE');
    assert.equal(source.activeProfileIdentity, null);
    assert.equal(fs.existsSync(path.join(isolatedRoot, 'firefox')), false);
  } finally {
    fs.rmSync(firefoxRoot, { recursive: true, force: true });
  }
});

test.skip('legacy in-place Firefox BiDi launch was replaced by temporary snapshots', async () => {
  const fixture = createExistingFirefoxFixture();
  const child = createFakeFirefoxChild();
  const profilesBefore = fs.readFileSync(path.join(fixture.firefoxRoot, 'profiles.ini'));
  let spawnCall = null;
  let connectOptions = null;
  let launchCalls = 0;
  let createBrowserCalls = 0;
  let source;
  try {
    source = new XActionsSource({
      profilePath: fixture.isolatedRoot,
      firefoxAppDataPath: fixture.firefoxRoot,
      getSettings: () => fixture.settings,
      log: () => {},
      spawnBrowser: (executablePath, args, options) => {
        assert.equal(source.activeProfileIdentity.path, fixture.dailyProfile);
        spawnCall = { executablePath, args, options };
        setImmediate(() => child.stderr.write('WebDriver BiDi listening on ws://127.0.0.1:3333\n'));
        return child;
      },
      getPuppeteer: async () => ({
        launch: async () => {
          launchCalls += 1;
          assert.fail('existing mode must not call puppeteer.launch');
        },
        connect: async (options) => {
          connectOptions = options;
          return {
            isConnected: () => child.exitCode === null && child.signalCode === null,
            newPage: async () => ({
              isClosed: () => false,
              setViewport: async () => {},
            }),
            close: async () => child.finish(0, null),
          };
        },
      }),
    });
    source.loadApi = async () => {
      createBrowserCalls += 1;
      assert.fail('existing mode must not load XActions createBrowser');
    };

    await source.start();

    assert.equal(launchCalls, 0);
    assert.equal(createBrowserCalls, 0);
    assert.equal(spawnCall.executablePath, fixture.fakeFirefox);
    assert.deepEqual(spawnCall.args, buildExistingFirefoxArgs(fixture.dailyProfile));
    assert.deepEqual(spawnCall.options, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    assert.equal(connectOptions.browserWSEndpoint, 'ws://127.0.0.1:3333/session');
    assert.equal(connectOptions.protocol, 'webDriverBiDi');
    assert.equal(fs.existsSync(path.join(fixture.dailyProfile, 'user.js')), false);
    assert.equal(fs.existsSync(path.join(fixture.dailyProfile, 'prefs.js')), false);
    assert.deepEqual(fs.readFileSync(path.join(fixture.firefoxRoot, 'profiles.ini')), profilesBefore);

    await source._close();
    assert.equal(child.exitCode, 0);
    assert.equal(source.browserProcess, null);
    assert.equal(source.activeProfileIdentity, null);
  } finally {
    if (source?.browser || source?.browserProcess) await source._close().catch(() => {});
    fs.rmSync(fixture.firefoxRoot, { recursive: true, force: true });
  }
});

test.skip('legacy Firefox BiDi newPage cleanup path was removed', async () => {
  const fixture = createExistingFirefoxFixture('tibo-existing-new-page-');
  const child = createFakeFirefoxChild();
  let source;
  try {
    source = new XActionsSource({
      profilePath: fixture.isolatedRoot,
      firefoxAppDataPath: fixture.firefoxRoot,
      getSettings: () => fixture.settings,
      log: () => {},
      spawnBrowser: () => {
        assert.equal(source.activeProfileIdentity.path, fixture.dailyProfile);
        setImmediate(() => child.stdout.write('WebDriver BiDi listening on ws://127.0.0.1:4444\n'));
        return child;
      },
      getPuppeteer: async () => ({
        connect: async () => ({
          newPage: async () => { throw new Error('simulated newPage failure'); },
          close: async () => child.finish(0, null),
        }),
      }),
    });

    await assert.rejects(() => source._fetchLatest({ limit: 5 }), /simulated newPage failure/);
    assert.equal(child.exitCode, 0);
    assert.equal(source.browser, null);
    assert.equal(source.browserProcess, null);
    assert.equal(source.activeProfileIdentity, null);
  } finally {
    if (source?.browser || source?.browserProcess) await source._close().catch(() => {});
    fs.rmSync(fixture.firefoxRoot, { recursive: true, force: true });
  }
});

test.skip('legacy Firefox pre-endpoint arbitration path was removed', async () => {
  const fixture = createExistingFirefoxFixture('tibo-existing-arbitration-');
  const child = createFakeFirefoxChild();
  let source;
  try {
    source = new XActionsSource({
      profilePath: fixture.isolatedRoot,
      firefoxAppDataPath: fixture.firefoxRoot,
      getSettings: () => fixture.settings,
      log: () => {},
      spawnBrowser: () => {
        setImmediate(() => {
          child.stderr.write('Firefox is already running for this profile.\n');
          child.finish(1, null);
        });
        return child;
      },
      getPuppeteer: async () => assert.fail('connect must not run without a BiDi endpoint'),
    });

    await assert.rejects(
      () => source._fetchLatest({ limit: 5 }),
      (error) => error.code === 'X_FIREFOX_PROFILE_IN_USE',
    );
    assert.equal(child.exitCode, 1);
    assert.equal(source.browserProcess, null);
    assert.equal(source.activeProfileIdentity, null);
  } finally {
    if (source?.browser || source?.browserProcess) await source._close().catch(() => {});
    fs.rmSync(fixture.firefoxRoot, { recursive: true, force: true });
  }
});

test.skip('legacy Firefox BiDi damaged-start path was removed', async () => {
  const fixture = createExistingFirefoxFixture('tibo-existing-damaged-start-');
  const child = createFakeFirefoxChild();
  let source;
  try {
    source = new XActionsSource({
      profilePath: fixture.isolatedRoot,
      firefoxAppDataPath: fixture.firefoxRoot,
      getSettings: () => fixture.settings,
      log: () => {},
      spawnBrowser: () => {
        setImmediate(() => {
          child.stderr.write('XPCOMGlueLoad error: incompatible or damaged installation.\n');
          child.finish(1, null);
        });
        return child;
      },
      getPuppeteer: async () => assert.fail('connect must not run without a BiDi endpoint'),
    });

    await assert.rejects(
      () => source._fetchLatest({ limit: 5 }),
      (error) => error.code === 'X_BROWSER_START_FAILED',
    );
    assert.equal(child.exitCode, 1);
    assert.equal(source.browserProcess, null);
    assert.equal(source.activeProfileIdentity, null);
  } finally {
    if (source?.browser || source?.browserProcess) await source._close().catch(() => {});
    fs.rmSync(fixture.firefoxRoot, { recursive: true, force: true });
  }
});

test.skip('legacy Firefox BiDi endpoint path was removed', async () => {
  const fixture = createExistingFirefoxFixture('tibo-existing-no-bidi-');
  const child = createFakeFirefoxChild();
  let source;
  try {
    source = new XActionsSource({
      profilePath: fixture.isolatedRoot,
      firefoxAppDataPath: fixture.firefoxRoot,
      getSettings: () => fixture.settings,
      log: () => {},
      spawnBrowser: () => child,
      getPuppeteer: async () => assert.fail('connect must not run without a BiDi endpoint'),
    });
    const waitForEndpoint = source.waitForFirefoxBiDiEndpoint.bind(source);
    source.waitForFirefoxBiDiEndpoint = (spawnedChild) => waitForEndpoint(spawnedChild, 5);
    source.waitForChildExit = async (spawnedChild) => Boolean(spawnedChild.killed);

    await assert.rejects(
      () => source._fetchLatest({ limit: 5 }),
      (error) => error.code === 'X_BROWSER_START_FAILED',
    );
    assert.equal(child.killed, true);
    assert.equal(source.browserProcess, null);
    assert.equal(source.activeProfileIdentity, null);
  } finally {
    if (source?.browser || source?.browserProcess) await source._close().catch(() => {});
    fs.rmSync(fixture.firefoxRoot, { recursive: true, force: true });
  }
});

test('failed owned Firefox termination keeps its handle and profile identity for a safe retry', async () => {
  const source = new XActionsSource({
    profilePath: 'unused',
    getSettings: () => ({ x: { handle: 'thsottiaux', firefoxProfileMode: 'existing', fetchLimit: 5 } }),
    log: () => {},
  });
  const child = createFakeFirefoxChild({ killExits: false });
  const identity = { mode: 'existing', kind: 'firefox', path: 'daily-profile' };
  source.browser = { close: async () => {} };
  source.browserProcess = child;
  source.activeProfileIdentity = identity;
  source.waitForChildExit = async (target) => target.exitCode !== null || target.signalCode !== null;

  await assert.rejects(
    () => source._close(),
    (error) => error.code === 'X_FIREFOX_PROCESS_CLOSE_FAILED' && /PID 4242/.test(error.message),
  );
  assert.equal(child.killed, true);
  assert.equal(source.browser, null);
  assert.equal(source.browserProcess, child);
  assert.equal(source.activeProfileIdentity, identity);

  child.finish(0, null);
  await source._close();
  assert.equal(source.browserProcess, null);
  assert.equal(source.activeProfileIdentity, null);
});

test('existing Firefox close waits for its profile lock and retains identity until release', async () => {
  const source = new XActionsSource({
    profilePath: 'unused',
    getSettings: () => ({ x: { handle: 'thsottiaux', firefoxProfileMode: 'existing', fetchLimit: 5 } }),
    log: () => {},
  });
  const identity = { mode: 'existing', kind: 'firefox', path: 'daily-profile' };
  let released = false;
  let releaseChecks = 0;
  source.activeProfileIdentity = identity;
  source.waitForProfileRelease = async (kind, profilePath) => {
    releaseChecks += 1;
    assert.equal(kind, 'firefox');
    assert.equal(profilePath, identity.path);
    return released;
  };

  await assert.rejects(() => source._close(), (error) => error.code === 'X_FIREFOX_PROFILE_IN_USE');
  assert.equal(releaseChecks, 1);
  assert.equal(source.activeProfileIdentity, identity);

  released = true;
  await source._close();
  assert.equal(releaseChecks, 2);
  assert.equal(source.activeProfileIdentity, null);
});

test.skip('legacy interactive login tracking path was removed', async () => {
  const source = new XActionsSource({
    profilePath: 'unused',
    getSettings: () => ({ x: { handle: 'thsottiaux', firefoxProfileMode: 'existing', fetchLimit: 5 } }),
    log: () => {},
  });
  let closeCalls = 0;
  let releaseClose;
  let ordinaryKillCalls = 0;
  source.awaitingLogin = true;
  source.loginProcess = { exitCode: null, killed: false, kill: () => { ordinaryKillCalls += 1; } };
  source.loginProfilePath = 'old-profile';
  source.loginProfileIdentity = { path: 'old-profile' };
  source.loginProfileMode = 'existing';
  source.loginBrowserKind = 'firefox';
  source.loginBrowserLabel = 'Mozilla Firefox';
  source.loginExecutablePath = 'old-firefox.exe';
  source._close = async () => {
    closeCalls += 1;
    await new Promise((resolve) => { releaseClose = resolve; });
  };

  const first = source.close();
  const second = source.close();
  assert.equal(first, second);
  assert.equal(closeCalls, 1);
  releaseClose();
  await Promise.all([first, second]);

  assert.equal(closeCalls, 1);
  assert.equal(ordinaryKillCalls, 0);
  assert.equal(source.awaitingLogin, false);
  assert.equal(source.loginProcess, null);
  assert.equal(source.loginProfilePath, null);
  assert.equal(source.loginProfileIdentity, null);
  assert.equal(source.loginBrowserKind, null);
  assert.equal(source.loginExecutablePath, null);
  assert.equal(source.closePromise, null);
});

test('existing mode closes its headless Firefox after every successful or failed fetch', async () => {
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-fetch-existing-'));
  const settings = {
    x: {
      handle: 'thsottiaux',
      firefoxProfileMode: 'existing',
      fetchLimit: 5,
      includeReplies: true,
      includeRetweets: false,
    },
  };
  let closeCount = 0;
  let shouldFail = false;
  const source = new XActionsSource({
    profilePath,
    firefoxAppDataPath: profilePath,
    getSettings: () => settings,
    log: () => {},
    now: () => Date.parse('2026-07-28T06:00:00.000Z'),
  });
  source.candidateProfiles = () => [{ mode: 'existing-snapshot', kind: 'firefox', id: 'Profile0', name: 'daily', path: profilePath }];
  source.start = async () => {
    source.browser = { close: async () => { closeCount += 1; } };
    source.page = {};
    source.browserKind = 'firefox';
    source.browserLabel = 'Mozilla Firefox';
    source.lastBrowserLabel = 'Mozilla Firefox';
    source.activeProfileIdentity = { mode: 'existing', kind: 'firefox', id: 'Profile0', name: 'daily', path: profilePath };
    source.lastProfileIdentity = { ...source.activeProfileIdentity };
  };
  source.scrapeTweets = async () => {
    if (shouldFail) throw new Error('simulated timeline failure');
    return [{ id: '1', author: 'thsottiaux', text: 'safe test post', timestamp: '2026-07-28T06:00:00.000Z', url: 'https://x.com/thsottiaux/status/1', isReply: false, isRetweet: false }];
  };
  source.inspectHealth = async () => {};
  try {
    const posts = await source._fetchLatest({ limit: 5 });
    assert.equal(posts.length, 1);
    assert.equal(closeCount, 1);
    assert.equal(source.browser, null);
    assert.equal(source.activeProfileIdentity, null);

    shouldFail = true;
    await assert.rejects(() => source._fetchLatest({ limit: 5 }), /simulated timeline failure/);
    assert.equal(closeCount, 2);
    assert.equal(source.browser, null);
    assert.equal(source.activeProfileIdentity, null);
  } finally {
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
});

test('X test automatically falls through to a logged-in Firefox profile and remembers it', async () => {
  const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-profile-fallback-'));
  const first = { mode: 'existing-snapshot', kind: 'firefox', name: 'default', path: path.join(profilePath, 'default') };
  const release = { mode: 'existing-snapshot', kind: 'firefox', name: 'default-release', path: path.join(profilePath, 'default-release') };
  const attempts = [];
  const source = new XActionsSource({
    profilePath,
    firefoxAppDataPath: profilePath,
    getSettings: () => ({ x: { handle: 'thsottiaux', fetchLimit: 5, firefoxProfilePath: '' } }),
    log: () => {},
    now: () => Date.parse('2026-07-28T06:00:00.000Z'),
  });
  source.candidateProfiles = () => source.preferredProfilePath ? [release, first] : [first, release];
  source.start = async (profile) => {
    attempts.push(profile.name);
    source.browser = { close: async () => {} };
    source.page = { profileName: profile.name };
    source.browserLabel = 'Mozilla Firefox';
    source.lastBrowserLabel = 'Mozilla Firefox';
    source.activeProfileIdentity = profile;
    source.lastProfileIdentity = { ...profile };
  };
  source.scrapeTweets = async (page) => {
    if (page.profileName === 'default') {
      const error = new Error('not logged in');
      error.code = 'X_AUTH_REQUIRED';
      throw error;
    }
    return [{ id: '1', author: 'thsottiaux', text: 'safe test post', timestamp: '2026-07-28T06:00:00.000Z', isReply: false, isRetweet: false }];
  };
  source.inspectHealth = async () => {};
  try {
    const result = await source.test();
    assert.equal(result.ok, true);
    assert.deepEqual(attempts, ['default', 'default-release']);
    assert.equal(result.profile.name, 'default-release');
    assert.equal(source.preferredProfilePath, release.path);
  } finally {
    await source.close().catch(() => {});
    fs.rmSync(profilePath, { recursive: true, force: true });
  }
});

test.skip('persistent isolated browser mode was removed', async () => {
  const settings = {
    x: {
      handle: 'thsottiaux',
      firefoxProfileMode: 'isolated',
      fetchLimit: 5,
      includeReplies: true,
      includeRetweets: false,
    },
  };
  let closeCount = 0;
  const source = new XActionsSource({
    profilePath: 'unused',
    getSettings: () => settings,
    log: () => {},
    now: () => Date.parse('2026-07-28T06:00:00.000Z'),
  });
  source.start = async () => {
    source.browser = { close: async () => { closeCount += 1; } };
    source.page = {};
    source.browserKind = 'firefox';
    source.browserLabel = 'Mozilla Firefox';
    source.activeProfileIdentity = { mode: 'isolated', kind: 'firefox', path: 'unused' };
  };
  source.scrapeTweets = async () => [{ id: '1', author: 'thsottiaux', text: 'safe test post', timestamp: '2026-07-28T06:00:00.000Z', url: 'https://x.com/thsottiaux/status/1', isReply: false, isRetweet: false }];
  source.inspectHealth = async () => {};
  const posts = await source._fetchLatest({ limit: 5 });
  assert.equal(posts.length, 1);
  assert.equal(closeCount, 0);
  assert.ok(source.browser);
  await source._close();
  assert.equal(closeCount, 1);
});

test('a stale Firefox parent.lock that can be opened does not keep the profile locked', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-firefox-lock-'));
  const parentLock = path.join(tempRoot, 'parent.lock');
  fs.writeFileSync(parentLock, Buffer.alloc(0));
  try {
    assert.equal(isProfileLocked(tempRoot), false);
    assert.equal(fs.existsSync(parentLock), true);
    assert.equal(fs.statSync(parentLock).size, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Firefox lock probe treats occupancy errors as locked and ENOENT as unlocked', () => {
  const throwingFileSystem = (code) => ({
    openSync() {
      const error = new Error(`simulated ${code}`);
      error.code = code;
      throw error;
    },
    closeSync() {
      assert.fail('closeSync must not run when openSync fails');
    },
  });

  assert.equal(isLockFileOccupied('parent.lock', throwingFileSystem('ENOENT')), false);
  for (const code of ['EACCES', 'EBUSY', 'EPERM']) {
    assert.equal(isLockFileOccupied('parent.lock', throwingFileSystem(code)), true);
  }
  assert.equal(isProfileLocked('simulated-profile', throwingFileSystem('EBUSY')), true);
  assert.equal(isLockFileOccupied('parent.lock', throwingFileSystem('EIO')), true);
});

test('custom Firefox executable and Windows App Paths are discoverable', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-browser-'));
  const customFirefox = path.join(tempRoot, 'firefox.exe');
  fs.writeFileSync(customFirefox, 'test-only');
  try {
    const custom = findFirefoxExecutable(customFirefox);
    assert.equal(custom.executablePath, customFirefox);
    assert.equal(custom.kind, 'firefox');
    if (process.platform === 'win32') {
      const registered = readRegisteredFirefoxPath();
      assert.ok(registered, 'Firefox App Paths registration should be detected on this machine');
      assert.equal(fs.existsSync(registered), true);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('X page transition errors are translated without leaking raw scrollHeight failures', () => {
  const friendly = friendlyXError(new TypeError("Cannot read properties of null (reading 'scrollHeight')"));
  assert.equal(friendly.code, 'X_PAGE_NOT_READY');
  assert.match(friendly.message, /页面正在跳转|尚未加载完成/);
  assert.doesNotMatch(friendly.message, /scrollHeight/);
});

test('Firefox profile lock failures receive a dedicated actionable error', () => {
  const friendly = friendlyXError(new Error('Firefox parent.lock is held by another process'));
  assert.equal(friendly.code, 'X_FIREFOX_PROFILE_IN_USE');
  assert.match(friendly.message, /关闭所有 Firefox 窗口/);
});

test('safe X scrolling handles a missing document root as an actionable error', async () => {
  const page = {
    evaluate: async (callback) => {
      const previousDocument = global.document;
      const previousWindow = global.window;
      global.document = { scrollingElement: null, documentElement: null, body: null };
      global.window = { scrollTo: () => { throw new Error('must not scroll'); } };
      try { return callback(); }
      finally {
        global.document = previousDocument;
        global.window = previousWindow;
      }
    },
  };
  await assert.rejects(() => safeScroll(page), (error) => error.code === 'X_PAGE_NOT_READY');
});

test('X source rejects concurrent page operations before they can race navigation', async () => {
  const source = new XActionsSource({
    profilePath: 'unused',
    getSettings: () => ({ x: { handle: 'thsottiaux', browser: 'auto', fetchLimit: 5 } }),
    log: () => {},
  });
  let release;
  source._fetchLatest = () => new Promise((resolve) => { release = resolve; });
  const first = source.fetchLatest();
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => source.test(), (error) => error.code === 'X_BUSY');
  release([]);
  await first;
});

test.skip('legacy tracked login-window verification path was removed', async () => {
  const source = new XActionsSource({
    profilePath: 'unused',
    getSettings: () => ({ x: { handle: 'thsottiaux', browser: 'chrome', fetchLimit: 5 } }),
    log: () => {},
  });
  source.awaitingLogin = true;
  source.loginProcess = { exitCode: null, killed: false };
  source.loginBrowserLabel = 'Google Chrome';
  await assert.rejects(() => source.test(), (error) => error.code === 'X_LOGIN_WINDOW_STILL_OPEN');
  assert.equal(source.loginProcess.killed, false);
});

test.skip('legacy Firefox login-window tracking was removed', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-firefox-login-'));
  const parentLock = path.join(tempRoot, 'parent.lock');
  fs.writeFileSync(parentLock, Buffer.alloc(0));
  try {
    const source = new XActionsSource({
      profilePath: tempRoot,
      getSettings: () => ({ x: { handle: 'thsottiaux', browser: 'firefox', fetchLimit: 5 } }),
      log: () => {},
    });
    source.awaitingLogin = true;
    source.loginProcess = { exitCode: 0, killed: false };
    source.loginProfilePath = tempRoot;
    source.loginBrowserKind = 'firefox';
    source.loginBrowserLabel = 'Mozilla Firefox';

    assert.equal(source.loginWindowIsRunning(), false);
    assert.equal(fs.existsSync(parentLock), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test.skip('legacy Firefox login verification state was removed', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-firefox-verify-'));
  const parentLock = path.join(tempRoot, 'parent.lock');
  fs.writeFileSync(parentLock, Buffer.alloc(0));
  try {
    const source = new XActionsSource({
      profilePath: tempRoot,
      getSettings: () => ({ x: { handle: 'thsottiaux', browser: 'firefox', fetchLimit: 5 } }),
      log: () => {},
    });
    source.awaitingLogin = true;
    source.loginProcess = { exitCode: 0, killed: false };
    source.loginProfilePath = tempRoot;
    source.loginBrowserKind = 'firefox';
    source.loginBrowserLabel = 'Mozilla Firefox';
    source.loginExecutablePath = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

    await source.prepareLoginVerification();

    assert.equal(source.awaitingLogin, false);
    assert.equal(source.loginProcess, null);
    assert.equal(source.loginProfilePath, null);
    assert.equal(fs.existsSync(parentLock), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('DeepSeek JSON is parsed and normalized without trusting arbitrary event types', () => {
  const raw = parseJsonContent('```json\n{"events":[{"type":"made_up","confidence":4,"summary":"x"}]}\n```');
  const result = validateClassification(raw);
  assert.equal(result.events[0].type, 'uncertain');
  assert.equal(result.events[0].confidence, 1);
});

test('Electron encryption paths remain stable across development and packaged launches', () => {
  const paths = getElectronDataPaths('C:\\Users\\Demo\\Documents');
  assert.equal(paths.userData, path.join('C:\\Users\\Demo\\Documents', 'Tibo Monitor', 'electron-data'));
  assert.equal(paths.sessionData, path.join('C:\\Users\\Demo\\Documents', 'Tibo Monitor', 'electron-session'));
});

test('an unreadable secrets file is quarantined instead of crashing startup', () => {
  const tempDocuments = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-monitor-storage-'));
  const root = path.join(tempDocuments, 'Tibo Monitor');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'secrets.dat'), 'not-valid-ciphertext', 'utf8');
  const safeStorage = {
    isEncryptionAvailable: () => true,
    decryptString: () => { throw new Error('cannot decrypt'); },
    encryptString: (value) => Buffer.from(value, 'utf8'),
  };
  try {
    const storage = new Storage({ documentsPath: tempDocuments, safeStorage }).init();
    assert.deepEqual(storage.secrets, {});
    assert.match(storage.secretsWarning, /无法解密/);
    assert.equal(fs.existsSync(path.join(root, 'secrets.dat')), false);
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith('secrets.unreadable.')), true);
  } finally {
    fs.rmSync(tempDocuments, { recursive: true, force: true });
  }
});

test('multiple mail recipients survive a full storage restart', () => {
  const tempDocuments = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-monitor-recipients-'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    decryptString: (value) => value.toString('utf8'),
    encryptString: (value) => Buffer.from(value, 'utf8'),
  };
  try {
    const first = new Storage({ documentsPath: tempDocuments, safeStorage }).init();
    first.saveSettings({
      ...first.settings,
      mail: {
        ...first.settings.mail,
        recipients: ['first@example.com', 'Second@example.com'],
      },
    });

    const restarted = new Storage({ documentsPath: tempDocuments, safeStorage }).init();

    assert.deepEqual(restarted.settings.mail.recipients, ['first@example.com', 'Second@example.com']);
  } finally {
    fs.rmSync(tempDocuments, { recursive: true, force: true });
  }
});

function fakeStorage() {
  const storage = {
    settings: structuredClone(DEFAULT_SETTINGS),
    state: structuredClone(DEFAULT_STATE),
    getPublicSnapshot() { return { settings: this.settings, state: this.state, secrets: {}, dataPath: 'test' }; },
    saveSettings(next) { this.settings = next; },
    saveState() {},
    log() {},
  };
  storage.settings.app.acceptedXActionsRisk = true;
  return storage;
}

test('first poll establishes a baseline; later new post is analyzed and notified once', async () => {
  const storage = fakeStorage();
  storage.settings.mail.enabled = true;
  storage.settings.app.monitoringEnabled = false;
  const batches = [
    [{ id: '100', text: 'old post', timestamp: '2026-07-28T00:00:00Z', url: 'https://x.com/thsottiaux/status/100', authorHandle: 'thsottiaux' }],
    [
      { id: '101', text: 'We will reset limits in the next hour', timestamp: '2026-07-28T01:00:00Z', url: 'https://x.com/thsottiaux/status/101', authorHandle: 'thsottiaux' },
      { id: '100', text: 'old post', timestamp: '2026-07-28T00:00:00Z', url: 'https://x.com/thsottiaux/status/100', authorHandle: 'thsottiaux' },
    ],
    [
      { id: '101', text: 'We will reset limits in the next hour', timestamp: '2026-07-28T01:00:00Z', url: 'https://x.com/thsottiaux/status/101', authorHandle: 'thsottiaux' },
      { id: '100', text: 'old post', timestamp: '2026-07-28T00:00:00Z', url: 'https://x.com/thsottiaux/status/100', authorHandle: 'thsottiaux' },
    ],
  ];
  let fetchIndex = 0;
  let sent = 0;
  const source = { fetchLatest: async () => batches[Math.min(fetchIndex++, batches.length - 1)], close: async () => {} };
  const ai = { classify: async () => ({ events: [{ type: 'reset_announced', confidence: 0.95, explicit: true, effective_at: null, summary: '即将重置', evidence: ['reset limits'], reason: 'future tense' }] }) };
  const mailer = { sendEvent: async () => { sent += 1; return { messageId: 'ok' }; } };
  const monitor = new MonitorService({
    storage,
    source,
    ai,
    mailer,
    now: () => Date.parse('2026-07-28T01:05:00Z'),
  });

  const baseline = await monitor.checkNow('test');
  assert.equal(baseline.fresh, 0);
  assert.equal(storage.state.posts.length, 0);
  assert.equal(sent, 0);

  const update = await monitor.checkNow('test');
  assert.equal(update.fresh, 1);
  assert.equal(storage.state.posts.length, 1);
  assert.equal(storage.state.events.length, 1);
  assert.equal(sent, 1);

  await monitor.checkNow('test');
  assert.equal(storage.state.events.length, 1);
  assert.equal(sent, 1);
  monitor.stop();
});

test('an event below the configured threshold is recorded but not emailed', async () => {
  const storage = fakeStorage();
  storage.settings.mail.enabled = true;
  storage.state.baselineEstablished = true;
  storage.state.baselineCutoffId = '199';
  storage.state.highWaterId = '199';
  let sent = 0;
  const source = { fetchLatest: async () => [{ id: '200', text: 'maybe reset limits later', timestamp: '2026-07-28T01:00:00Z', url: 'https://x.com/thsottiaux/status/200', authorHandle: 'thsottiaux' }], close: async () => {} };
  const ai = { classify: async () => ({ events: [{ type: 'reset_announced', confidence: 0.6, explicit: false, effective_at: null, summary: '可能重置', evidence: ['reset limits'], reason: 'unclear' }] }) };
  const mailer = { sendEvent: async () => { sent += 1; return {}; } };
  const monitor = new MonitorService({
    storage,
    source,
    ai,
    mailer,
    now: () => Date.parse('2026-07-28T01:05:00Z'),
  });
  await monitor.checkNow('test');
  assert.equal(storage.state.events[0].notificationStatus, 'not_required');
  assert.equal(sent, 0);
  monitor.stop();
});
