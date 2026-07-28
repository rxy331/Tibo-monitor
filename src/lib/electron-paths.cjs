'use strict';

const fs = require('node:fs');
const path = require('node:path');

function getElectronDataPaths(documentsPath) {
  const root = path.join(documentsPath, 'Tibo Monitor');
  return {
    root,
    userData: path.join(root, 'electron-data'),
    sessionData: path.join(root, 'electron-session'),
  };
}

function configureElectronDataPaths(app) {
  const paths = getElectronDataPaths(app.getPath('documents'));
  fs.mkdirSync(paths.userData, { recursive: true });
  fs.mkdirSync(paths.sessionData, { recursive: true });
  app.setPath('userData', paths.userData);
  app.setPath('sessionData', paths.sessionData);
  return paths;
}

module.exports = { configureElectronDataPaths, getElectronDataPaths };
