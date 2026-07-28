'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { XActionsSource } = require('../src/lib/xactions-source.cjs');

test('Firefox existing data is copied to a disposable snapshot and removed after close', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tibo-firefox-only-'));
  const firefoxRoot = path.join(root, 'Firefox');
  const profile = path.join(firefoxRoot, 'Profiles', 'daily.default-release');
  const executable = path.join(root, 'firefox.exe');
  fs.mkdirSync(path.join(profile, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(profile, 'cookies.sqlite'), 'cookie-fixture');
  fs.writeFileSync(path.join(profile, 'cache', 'discard-me'), 'cache');
  fs.writeFileSync(path.join(firefoxRoot, 'profiles.ini'),
    '[Profile0]\nName=daily\nIsRelative=1\nPath=Profiles/daily.default-release\nDefault=1\n', 'utf8');
  fs.writeFileSync(executable, 'test-only');
  let launchOptions = null;
  const source = new XActionsSource({
    profilePath: path.join(root, 'legacy-app-profile'),
    firefoxAppDataPath: firefoxRoot,
    getSettings: () => ({ x: {
      handle: 'thsottiaux',
      firefoxExecutablePath: executable,
      firefoxProfilePath: profile,
      fetchLimit: 5,
    } }),
    log: () => {},
    getPuppeteer: async () => ({
      launch: async (options) => {
        launchOptions = options;
        return {
          newPage: async () => ({ setViewport: async () => {}, isClosed: () => false }),
          close: async () => {},
          isConnected: () => true,
        };
      },
    }),
  });
  try {
    await source.start();
    const snapshotRoot = source.activeSnapshotRoot;
    assert.equal(launchOptions.browser, 'firefox');
    assert.equal(launchOptions.headless, true);
    assert.notEqual(path.resolve(launchOptions.userDataDir), path.resolve(profile));
    assert.equal(fs.readFileSync(path.join(launchOptions.userDataDir, 'cookies.sqlite'), 'utf8'), 'cookie-fixture');
    assert.equal(fs.existsSync(path.join(launchOptions.userDataDir, 'cache')), false);
    await source._close();
    assert.equal(fs.existsSync(snapshotRoot), false);
    assert.equal(source.activeSnapshotRoot, null);
  } finally {
    await source._close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
