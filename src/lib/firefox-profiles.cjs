'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createProfileError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseIni(text) {
  const sections = [];
  let current = null;
  const normalized = String(text || '').replace(/^\uFEFF/, '');
  for (const rawLine of normalized.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      current = { name: sectionMatch[1].trim(), values: new Map() };
      sections.push(current);
      continue;
    }
    const separator = line.indexOf('=');
    if (!current || separator < 1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    current.values.set(key, line.slice(separator + 1).trim());
  }
  return sections;
}

function readIni(filePath, fileSystem) {
  try {
    return { exists: true, sections: parseIni(fileSystem.readFileSync(filePath, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, sections: [] };
    throw error;
  }
}

function pathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function normalizeSeparators(value) {
  const text = String(value || '');
  return path.sep === '\\' ? text.replaceAll('/', '\\') : text.replaceAll('\\', '/');
}

function resolveIniPath(firefoxAppDataPath, configuredPath, isRelative = true) {
  const portablePath = normalizeSeparators(configuredPath);
  return path.resolve(isRelative ? firefoxAppDataPath : '', portablePath);
}

function directoryExists(directoryPath, fileSystem) {
  try {
    return fileSystem.statSync(directoryPath).isDirectory();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error?.code)) return false;
    throw error;
  }
}

function isTiboProfilePath(profilePath, explicitTiboProfilePath = '') {
  const candidateKey = pathKey(profilePath);
  if (explicitTiboProfilePath && candidateKey === pathKey(explicitTiboProfilePath)) return true;
  const portable = candidateKey.replaceAll('\\', '/').replace(/\/+$/, '');
  return portable.endsWith('/tibo monitor/browser-profile/firefox');
}

function publicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    path: profile.path,
    configuredPath: profile.configuredPath,
    isRelative: profile.isRelative,
    isDefault: profile.isDefault,
    isInstallDefault: profile.isInstallDefault,
    installIds: [...profile.installIds],
    exists: profile.exists,
    registered: true,
  };
}

function scanFirefoxProfiles(options = {}) {
  const fileSystem = options.fileSystem || fs;
  const firefoxAppDataPath = path.resolve(String(options.firefoxAppDataPath || ''));
  if (!options.firefoxAppDataPath) {
    throw createProfileError(
      'X_FIREFOX_PROFILE_NOT_FOUND',
      '未提供 Firefox 配置目录，无法查找现有登录资料。',
    );
  }

  const profilesIniPath = path.join(firefoxAppDataPath, 'profiles.ini');
  const installsIniPath = path.join(firefoxAppDataPath, 'installs.ini');
  const profilesIni = readIni(profilesIniPath, fileSystem);
  const installsIni = readIni(installsIniPath, fileSystem);
  const registeredProfiles = profilesIni.sections
    .filter((section) => /^Profile\d+$/i.test(section.name))
    .map((section) => {
      const configuredPath = section.values.get('path') || '';
      const isRelative = section.values.get('isrelative') === '1';
      const absolutePath = resolveIniPath(firefoxAppDataPath, configuredPath, isRelative);
      return {
        id: section.name,
        name: section.values.get('name') || section.name,
        path: absolutePath,
        configuredPath,
        isRelative,
        isDefault: section.values.get('default') === '1',
        isInstallDefault: false,
        installIds: [],
        exists: Boolean(configuredPath) && directoryExists(absolutePath, fileSystem),
        isTiboProfile: isTiboProfilePath(absolutePath, options.tiboProfilePath),
      };
    });

  const installDefaults = [];
  const collectInstallDefaults = (ini, source) => {
    for (const section of ini.sections) {
      if (source === 'profiles.ini' && !/^Install/i.test(section.name)) continue;
      const configuredPath = section.values.get('default');
      if (!configuredPath) continue;
      const absolutePath = resolveIniPath(
        firefoxAppDataPath,
        configuredPath,
        !path.isAbsolute(normalizeSeparators(configuredPath)),
      );
      const matched = registeredProfiles.find((profile) => pathKey(profile.path) === pathKey(absolutePath));
      installDefaults.push({
        source,
        installId: section.name.replace(/^Install/i, ''),
        configuredPath,
        path: absolutePath,
        profileId: matched?.id || null,
      });
      if (matched) {
        matched.isInstallDefault = true;
        if (!matched.installIds.includes(section.name.replace(/^Install/i, ''))) {
          matched.installIds.push(section.name.replace(/^Install/i, ''));
        }
      }
    }
  };
  collectInstallDefaults(installsIni, 'installs.ini');
  collectInstallDefaults(profilesIni, 'profiles.ini');

  const profiles = registeredProfiles
    .filter((profile) => profile.exists && !profile.isTiboProfile)
    .map(publicProfile);
  const excludedProfiles = registeredProfiles
    .filter((profile) => !profile.exists || profile.isTiboProfile)
    .map((profile) => ({
      ...publicProfile(profile),
      reason: profile.isTiboProfile ? 'tibo-profile' : 'missing',
    }));

  return {
    firefoxAppDataPath,
    profilesIniPath,
    installsIniPath,
    profilesIniExists: profilesIni.exists,
    installsIniExists: installsIni.exists,
    profiles,
    excludedProfiles,
    installDefaults,
    registeredProfiles,
  };
}

function listFirefoxProfiles(options = {}) {
  const catalog = scanFirefoxProfiles(options);
  return {
    firefoxAppDataPath: catalog.firefoxAppDataPath,
    profilesIniPath: catalog.profilesIniPath,
    installsIniPath: catalog.installsIniPath,
    profilesIniExists: catalog.profilesIniExists,
    installsIniExists: catalog.installsIniExists,
    profiles: catalog.profiles,
    excludedProfiles: catalog.excludedProfiles,
    installDefaults: catalog.installDefaults,
  };
}

function orderedFirefoxProfiles(options = {}) {
  const catalog = scanFirefoxProfiles(options);
  if (catalog.profiles.length === 0) {
    throw createProfileError(
      'X_FIREFOX_PROFILE_NOT_FOUND',
      '没有找到可用的 Firefox 日常登录资料。请先正常启动 Firefox 并完成 X 登录。',
    );
  }

  const savedPath = String(options.savedPath || '').trim();
  const preferredPath = String(options.preferredPath || '').trim();
  const rank = (profile) => {
    if (preferredPath && pathKey(profile.path) === pathKey(preferredPath)) return 0;
    if (savedPath && pathKey(profile.path) === pathKey(savedPath)) return 1;
    if (profile.isInstallDefault) return 2;
    if (/default-release/i.test(`${profile.name} ${profile.configuredPath} ${profile.path}`)) return 3;
    if (profile.isDefault) return 4;
    return 5;
  };
  return [...catalog.profiles]
    .sort((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name))
    .map((profile, index) => ({
      ...profile,
      selectionReason: index === 0 && preferredPath && pathKey(profile.path) === pathKey(preferredPath)
        ? 'last-successful'
        : index === 0 && savedPath && pathKey(profile.path) === pathKey(savedPath)
          ? 'saved'
          : profile.isInstallDefault
            ? 'install-default'
            : /default-release/i.test(`${profile.name} ${profile.configuredPath} ${profile.path}`)
              ? 'default-release'
              : profile.isDefault ? 'legacy-default' : 'automatic-fallback',
    }));
}

function resolveFirefoxProfile(options = {}) {
  const catalog = scanFirefoxProfiles(options);
  const savedPath = String(options.savedPath || '').trim();
  if (savedPath) {
    const absoluteSavedPath = path.resolve(savedPath);
    if (isTiboProfilePath(absoluteSavedPath, options.tiboProfilePath)) {
      throw createProfileError(
        'X_FIREFOX_PROFILE_FORBIDDEN',
        '不能把 Tibo Monitor 的专用资料目录当作 Firefox 日常登录资料。',
      );
    }
    const registered = catalog.registeredProfiles.find(
      (profile) => pathKey(profile.path) === pathKey(absoluteSavedPath),
    );
    if (!registered) {
      throw createProfileError(
        'X_FIREFOX_PROFILE_NOT_REGISTERED',
        '保存的 Firefox 资料目录未登记在 profiles.ini 中，请重新选择。',
      );
    }
    if (registered.isTiboProfile) {
      throw createProfileError(
        'X_FIREFOX_PROFILE_FORBIDDEN',
        '不能把 Tibo Monitor 的专用资料目录当作 Firefox 日常登录资料。',
      );
    }
    if (!registered.exists) {
      throw createProfileError(
        'X_FIREFOX_PROFILE_NOT_FOUND',
        '保存的 Firefox 资料目录已经不存在，请重新选择。',
      );
    }
    return { ...publicProfile(registered), selectionReason: 'saved' };
  }

  if (catalog.profiles.length === 0) {
    throw createProfileError(
      'X_FIREFOX_PROFILE_NOT_FOUND',
      '没有找到可用的 Firefox 日常登录资料。请先正常启动 Firefox 并完成 X 登录。',
    );
  }

  const installDefaults = catalog.profiles.filter((profile) => profile.isInstallDefault);
  if (installDefaults.length === 1) {
    return { ...installDefaults[0], selectionReason: 'install-default' };
  }

  const legacyDefaults = catalog.profiles.filter((profile) => profile.isDefault);
  if (legacyDefaults.length === 1) {
    return { ...legacyDefaults[0], selectionReason: 'legacy-default' };
  }

  if (catalog.profiles.length === 1) {
    return { ...catalog.profiles[0], selectionReason: 'only-profile' };
  }

  throw createProfileError(
    'X_FIREFOX_PROFILE_AMBIGUOUS',
    `检测到 ${catalog.profiles.length} 个可用的 Firefox 资料，但无法确定默认项。请在设置中明确选择一个。`,
  );
}

module.exports = {
  listFirefoxProfiles,
  orderedFirefoxProfiles,
  resolveFirefoxProfile,
};
