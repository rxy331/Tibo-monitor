'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_SETTINGS } = require('../src/lib/defaults.cjs');
const { XActionsSource } = require('../src/lib/xactions-source.cjs');
const { sanitizeSettings } = require('../src/lib/utils.cjs');

async function main() {
  const dataRoot = path.join(os.homedir(), 'Documents', 'Tibo Monitor');
  const settingsPath = path.join(dataRoot, 'settings.json');
  const rawSettings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : structuredClone(DEFAULT_SETTINGS);
  const settings = sanitizeSettings(rawSettings, DEFAULT_SETTINGS);
  const source = new XActionsSource({
    profilePath: path.join(dataRoot, 'browser-profile'),
    getSettings: () => settings,
    log: () => {},
  });
  try {
    const result = await source.test();
    const outputDir = path.join(__dirname, '..', 'artifacts');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'x-smoke.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(result));
  } finally {
    await source.close();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error.code || null, message: error.message }));
  process.exitCode = 1;
});
