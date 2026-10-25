// 웹앱에 꼭 필요한 기능만 열어줘요.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('replayDesktop', {
  isDesktop: true,
  startAuth: () => ipcRenderer.invoke('start-auth'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  setMini: (on) => ipcRenderer.invoke('set-mini', !!on),
  onAuthCode: (cb) => ipcRenderer.on('auth-code', (_e, code) => cb(code)),
  onAuthError: (cb) => ipcRenderer.on('auth-error', (_e, msg) => cb(msg)),
  onMediaKey: (cb) => ipcRenderer.on('media-key', (_e, key) => cb(key)),
});
