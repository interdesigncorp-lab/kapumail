// A zárképernyő hídja: csak állapotot kérdezni és feloldást kérni tud. A PIN ellenőrzése a főfolyamatban történik.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('kapuLock', {
  state: () => ipcRenderer.invoke('lockscreen:state'),
  touch: () => ipcRenderer.invoke('lockscreen:touch'),
  pin: pin => ipcRenderer.invoke('lockscreen:pin', String(pin)),
  recover: (code, pin) => ipcRenderer.invoke('lockscreen:recover', String(code), String(pin)),
});
