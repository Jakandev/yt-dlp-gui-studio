'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
  },
  getState: () => ipcRenderer.invoke('state:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  backupSettings: (filePath) => ipcRenderer.invoke('settings:backup', filePath),
  restoreSettings: (filePath) => ipcRenderer.invoke('settings:restore', filePath),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  pickFile: (opts) => ipcRenderer.invoke('dialog:file', opts),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  revealPath: (p) => ipcRenderer.invoke('shell:reveal', p),
  openExternal: (u) => ipcRenderer.invoke('shell:external', u),
  fetchInfo: (url) => ipcRenderer.invoke('yt:info', url),
  download: (payload) => ipcRenderer.invoke('yt:download', payload),
  cancel: (id) => ipcRenderer.invoke('yt:cancel', id),
  retry: (id) => ipcRenderer.invoke('yt:retry', id),
  remove: (id) => ipcRenderer.invoke('yt:remove', id),
  clearDone: () => ipcRenderer.invoke('yt:clearDone'),
  removeAll: () => ipcRenderer.invoke('queue:removeAll'),
  retryFailed: () => ipcRenderer.invoke('queue:retryFailed'),
  pauseSelected: (ids) => ipcRenderer.invoke('queue:pauseSelected', ids),
  resumeSelected: (ids) => ipcRenderer.invoke('queue:resumeSelected', ids),
  folderFor: (ids, dir) => ipcRenderer.invoke('queue:folderFor', ids, dir),
  paused: () => ipcRenderer.invoke('yt:paused'),
  pauseAll: () => ipcRenderer.invoke('yt:pauseAll'),
  resumeAll: () => ipcRenderer.invoke('yt:resumeAll'),
  clipboardRead: () => ipcRenderer.invoke('clipboard:read'),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text),
  thumb: (url, pageUrl) => ipcRenderer.invoke('thumb:get', url, pageUrl),
  scanFiles: (payload) => ipcRenderer.invoke('files:scan', payload),
  saveCookies: (payload) => ipcRenderer.invoke('cookies:save', payload),
  testCookies: (payload) => ipcRenderer.invoke('cookies:test', payload),
  vkCapture: (url, opts) => ipcRenderer.invoke('vk:capture', url, opts),
  listCookies: () => ipcRenderer.invoke('cookies:list'),
  clearCookies: (domain) => ipcRenderer.invoke('cookies:clear', domain),
  engDebug: () => ipcRenderer.invoke('eng:debug'),
  resDebug: (u) => ipcRenderer.invoke('res:debug', u),
  sniffDebug: (u) => ipcRenderer.invoke('sniff:debug', u),
  pageProbe: (u) => ipcRenderer.invoke('page:probe', u),
  schema: () => ipcRenderer.invoke('yt:schema'),
  update: () => ipcRenderer.invoke('yt:update'),
  enginesInfo: () => ipcRenderer.invoke('engines:info'),
  restoreEngines: () => ipcRenderer.invoke('engines:restore'),
  importData: (folder) => ipcRenderer.invoke('data:import', folder),
  history: () => ipcRenderer.invoke('history:get'),
  historyThumb: (filepath) => ipcRenderer.invoke('history:thumb', filepath),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  events: {
    queue: (cb) => on('queue:update', cb),
    log: (cb) => on('queue:log', cb),
    toast: (cb) => on('app:toast', cb),
    settings: (cb) => on('settings:changed', cb),
    paused: (cb) => on('engine:paused', cb),
  },
});
