const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('pocket', {
  invoke: (method, ...args) => {
    if (typeof method !== 'string' || method === 'importPaths')
      return Promise.reject(new Error('Use dropped files or Add Files to import audio.'));
    return ipcRenderer.invoke('pocket:' + method, ...args);
  },
  importFiles: (files) => {
    const paths = Array.from(files, (file) => webUtils.getPathForFile(file));
    if (!paths.length || paths.some((p) => !p))
      return Promise.reject(new Error('Drop files from Finder to import them.'));
    return ipcRenderer.invoke('pocket:importPaths', paths);
  },
  subscribe: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('pocket:state', listener);
    return () => ipcRenderer.removeListener('pocket:state', listener);
  },
});
