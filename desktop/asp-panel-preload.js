// Szűk híd az önkormányzati portál osztott ablakának bal oldali vezérlősávjához.
// Csak a főfolyamat saját panelnézetéből érhető el (e.sender.id ellenőrzéssel).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aspPanel', {
  state: () => ipcRenderer.invoke('aspPanel:state'),
  onState: cb => {
    ipcRenderer.removeAllListeners('aspPanel:state');
    ipcRenderer.on('aspPanel:state', (_e, s) => cb(s));
  },
  select: (key, copyValue, copyLabel) => ipcRenderer.invoke('aspPanel:select', String(key || ''), String(copyValue || ''), String(copyLabel || '')),
  readNow: () => ipcRenderer.invoke('aspPanel:readNow'),
  openSwitch: () => ipcRenderer.invoke('aspPanel:openSwitch'),
  manualLogin: () => ipcRenderer.invoke('aspPanel:manualLogin'),
  close: () => ipcRenderer.invoke('aspPanel:close'),
});
