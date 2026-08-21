
// --- SandustryMP by Kamil Padula: network bridge (appended by patch.js) ---
contextBridge.exposeInMainWorld('sandustrympNet', {
  hostSteam: () => ipcRenderer.invoke('smp:host-steam'),
  joinSteam: (lobbyId) => ipcRenderer.invoke('smp:join-steam', lobbyId),
  invite: () => ipcRenderer.invoke('smp:invite'),
  hostWs: (port) => ipcRenderer.invoke('smp:host-ws', port),
  joinWs: (host, port) => ipcRenderer.invoke('smp:join-ws', host, port),
  stop: () => ipcRenderer.invoke('smp:stop'),
  status: () => ipcRenderer.invoke('smp:status'),
  send: (payload, toId) => ipcRenderer.send('smp:send', payload, toId),
  onMsg: (cb) => { ipcRenderer.on('smp:msg', (ev, data) => cb(data)); },
  onEvent: (cb) => { ipcRenderer.on('smp:event', (ev, data) => cb(data)); },
});
// --- /SandustryMP ---
