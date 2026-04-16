'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('runway', {
  getSnapshots:  ()       => ipcRenderer.invoke('get-snapshots'),
  getConfig:     ()       => ipcRenderer.invoke('get-config'),
  saveConfig:    (data)   => ipcRenderer.invoke('save-config', data),
  openSettings:  ()       => ipcRenderer.invoke('open-settings'),
  openClaude:    ()       => ipcRenderer.invoke('open-claude'),
  refresh:       ()       => ipcRenderer.invoke('refresh'),
  onSnapshots:   (fn)     => ipcRenderer.on('snapshots', (_e, data) => fn(data)),
});
