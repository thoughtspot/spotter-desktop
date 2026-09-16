const { contextBridge, ipcRenderer } = require('electron');

// Wrap main-process pushes so the renderer never sees the raw IpcRendererEvent,
// and hand back an unsubscribe function for effect cleanup.
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  // arm64 vs x64 — which of the two Mac builds this user is actually running.
  arch: process.arch,
  logout: () => ipcRenderer.invoke('logout'),
  getHostUrl: () => ipcRenderer.invoke('get-host-url'),
  setHostUrl: (url) => ipcRenderer.invoke('set-host-url', url),
  clearHostUrl: () => ipcRenderer.invoke('clear-host-url'),
  openAuthWindow: () => ipcRenderer.invoke('open-auth-window'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Fire and forget — nothing to await, no reply.
  notifyResponseComplete: () => ipcRenderer.send('notify-response-complete'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getOrgs: () => ipcRenderer.invoke('get-orgs'),
  getCurrentUser: () => ipcRenderer.invoke('get-current-user'),
  switchOrg: (id) => ipcRenderer.invoke('switch-org', id),
  confirmOrgSwitch: (name) => ipcRenderer.invoke('confirm-org-switch', name),
  getLoggedIn: () => ipcRenderer.invoke('get-logged-in'),
  setLoggedIn: (v) => ipcRenderer.invoke('set-logged-in', v),
  onMenuAction: (callback) => subscribe('menu-action', callback),
  onUpdateAvailable: (callback) => subscribe('update-available', callback),
});
