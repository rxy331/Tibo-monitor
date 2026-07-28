'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tibo', Object.freeze({
  getState: () => ipcRenderer.invoke('app:get-state'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  toggleMonitor: (enabled) => ipcRenderer.invoke('monitor:toggle', enabled),
  checkNow: () => ipcRenderer.invoke('monitor:check'),
  testAi: () => ipcRenderer.invoke('ai:test'),
  testMail: () => ipcRenderer.invoke('mail:test'),
  testX: () => ipcRenderer.invoke('x:test'),
  openXLogin: () => ipcRenderer.invoke('x:login'),
  listFirefoxProfiles: () => ipcRenderer.invoke('x:list-firefox-profiles'),
  chooseFirefoxExecutable: () => ipcRenderer.invoke('x:choose-firefox-executable'),
  openData: () => ipcRenderer.invoke('app:open-data'),
  createShortcut: () => ipcRenderer.invoke('app:create-shortcut-and-confirm'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  onUpdate: (callback) => {
    const handler = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('monitor:update', handler);
    return () => ipcRenderer.removeListener('monitor:update', handler);
  },
}));
