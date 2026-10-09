const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  // 数据
  getData: () => ipcRenderer.invoke('data:get'),
  refreshData: (opts = {}) => ipcRenderer.invoke('data:refresh', opts),
  bootstrap: () => ipcRenderer.invoke('data:bootstrapFromSite'),
  onDataProgress: on('data:progress'),

  // 状态
  getState: () => ipcRenderer.invoke('state:get'),
  setState: (patch) => ipcRenderer.invoke('state:set', patch),
  resetState: () => ipcRenderer.invoke('app:resetState'),

  // 下载
  downloadStart: (payload) => ipcRenderer.invoke('download:start', payload),
  downloadCancel: (payload) => ipcRenderer.invoke('download:cancel', payload),
  downloadDelete: (payload) => ipcRenderer.invoke('download:delete', payload),
  onDownloadProgress: on('download:progress'),

  // 运行
  launch: (payload) => ipcRenderer.invoke('launch:trainer', payload),
  launchPickFile: (payload) => ipcRenderer.invoke('launch:pickFile', payload),

  // 封面与系统
  coverEnsure: (payload) => ipcRenderer.invoke('cover:ensure', payload),
  openExternal: (payload) => ipcRenderer.invoke('shell:openExternal', payload),
  showItem: (payload) => ipcRenderer.invoke('shell:showItem', payload),
  pickDir: (payload) => ipcRenderer.invoke('dialog:pickDir', payload),
  openPath: (payload) => ipcRenderer.invoke('app:openPath', payload),
  appInfo: () => ipcRenderer.invoke('app:info'),

  // 诊断
  log: (payload) => ipcRenderer.invoke('log:renderer', payload),
});
