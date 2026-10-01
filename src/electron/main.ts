import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, safeStorage } from 'electron';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { AppService } from '../core/service';
import { Store, StorageCodec } from '../core/store';
import type { Command } from '../shared/types';

// Separate profiles are used by automated multi-instance tests. Normal launches share one profile.
const profile = process.argv.find((v) => v.startsWith('--profile='))?.slice('--profile='.length);
if (profile) app.setPath('userData', profile);
const testing = process.argv.includes('--e2e');
if (!testing && !app.requestSingleInstanceLock()) app.quit();
let window: BrowserWindow | undefined;
let service: AppService | undefined;
let quitting = false;
function assertSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error('잘못된 앱 요청입니다.');
}
app.on('second-instance', () => {
  window?.show();
  window?.focus();
});
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const encrypted =
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
  const codec: StorageCodec = {
    protected: encrypted,
    encode: (value) =>
      encrypted
        ? Buffer.concat([Buffer.from('LSE1'), safeStorage.encryptString(value)])
        : Buffer.concat([Buffer.from('LSP1'), Buffer.from(value)]),
    decode: (value) => {
      const header = value.subarray(0, 4).toString();
      if (header === 'LSE1') {
        if (!encrypted) throw new Error('Windows 보호 저장을 사용할 수 없습니다.');
        return safeStorage.decryptString(value.subarray(4));
      }
      if (header === 'LSP1') return value.subarray(4).toString();
      throw new Error('저장 파일 형식이 다릅니다.');
    },
  };
  try {
    const store = new Store(app.getPath('userData'), codec);
    service = new AppService(store, {
      readText: () => clipboard.readText(),
      writeText: (text) => clipboard.writeText(text),
    });
    // Startup integration is reconciled with the saved preference on each Windows launch.
    if (process.platform === 'win32')
      app.setLoginItemSettings({
        openAtLogin: store.data.settings.autoStart,
        path: process.execPath,
      });
    window = new BrowserWindow({
      width: 1180,
      height: 800,
      minWidth: 850,
      minHeight: 600,
      backgroundColor: store.data.settings.theme === 'dark' ? '#111923' : '#f6f8fa',
      title: 'Local Sync Notepad',
      icon: join(__dirname, '../../../assets/icon.png'),
      show: false,
      webPreferences: {
        preload: join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
      },
    });
    window.once('ready-to-show', () => window?.show());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    );
    ipcMain.handle('app:state', (event) => {
      assertSender(event);
      return service!.state();
    });
    ipcMain.handle('app:document', (event) => {
      assertSender(event);
      return { data: [...service!.document()], revision: service!.documentRevision() };
    });
    ipcMain.handle('app:command', async (event, command: Command) => {
      assertSender(event);
      if (!command || typeof command.type !== 'string') throw new Error('잘못된 요청입니다.');
      if (command.type === 'exportNote') {
        const result = await dialog.showSaveDialog(window!, {
          title: '메모 내보내기',
          defaultPath: '공동메모.txt',
          filters: [{ name: '텍스트 문서', extensions: ['txt'] }],
        });
        if (!result.canceled && result.filePath)
          writeFileSync(result.filePath, '\uFEFF' + service!.text(), 'utf8');
        return;
      }
      if (command.type === 'settings' && command.settings.autoStart !== undefined) {
        if (typeof command.settings.autoStart !== 'boolean')
          throw new Error('잘못된 자동 실행 설정입니다.');
        if (process.platform !== 'win32' && !testing)
          throw new Error('자동 실행은 Windows 설치 버전에서 지원합니다.');
        if (process.platform === 'win32') {
          if (!app.isPackaged) throw new Error('자동 실행은 설치한 프로그램에서 설정하세요.');
          app.setLoginItemSettings({
            openAtLogin: command.settings.autoStart,
            path: process.execPath,
          });
        }
      }
      return service!.command(command);
    });
    ipcMain.on('app:update', (event, update: { data: number[]; revision: number }) => {
      try {
        assertSender(event);
        if (!update || update.revision !== service!.documentRevision()) return;
        service!.applyRendererUpdate(update.data);
      } catch (error) {
        window?.webContents.send('app:state', {
          ...service!.state(),
          error: error instanceof Error ? error.message : String(error),
        });
        window?.webContents.send('app:reset');
      }
    });
    service.on('state', (state) => {
      if (!window?.isDestroyed()) window?.webContents.send('app:state', state);
    });
    service.on('document', (data) => {
      if (!window?.isDestroyed())
        window?.webContents.send('app:update', { data, revision: service!.documentRevision() });
    });
    service.on('reset', () => {
      if (!window?.isDestroyed()) window?.webContents.send('app:reset');
    });
    await window.loadFile(join(__dirname, '../../renderer/index.html'));
    await service.start();
  } catch (error) {
    dialog.showErrorBox(
      '프로그램을 시작하지 못했습니다',
      error instanceof Error ? error.message : String(error),
    );
    app.quit();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (quitting || !service) return;
  event.preventDefault();
  quitting = true;
  service
    .close()
    .catch((error) => {
      console.error('저장 실패:', error.message);
    })
    .finally(() => app.quit());
});
