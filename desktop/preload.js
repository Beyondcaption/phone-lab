'use strict';
// Nur die Verbindungsseite (connect.html) braucht diese Brücke. Das Dashboard läuft ohne Sonderrechte.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desk', {
  probe: url => ipcRenderer.invoke('probe', url),
  connect: url => ipcRenderer.invoke('connect', url),
  info: () => ipcRenderer.invoke('info'),
});
