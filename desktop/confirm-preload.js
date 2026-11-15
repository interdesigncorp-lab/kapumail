// A letöltés megerősítő rétegének hídja: az adatokat lekérni és igent vagy nemet mondani tud, semmi mást.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('kapuConfirm', {
  info: () => ipcRenderer.invoke('confirm:info'),
  answer: yes => ipcRenderer.invoke('confirm:answer', yes === true),
});
