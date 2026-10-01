import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, Command, DesktopApi } from '../shared/types';
function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}
const api: DesktopApi = {
  state: () => ipcRenderer.invoke('app:state'),
  command: (command: Command) => ipcRenderer.invoke('app:command', command),
  document: () => ipcRenderer.invoke('app:document'),
  update: (data: number[]) => ipcRenderer.send('app:update', data),
  onState: callback => subscribe<AppState>('app:state', callback),
  onUpdate: callback => subscribe<number[]>('app:update', callback),
  onReset: callback => subscribe('app:reset', callback),
};
contextBridge.exposeInMainWorld('desktop', api);
