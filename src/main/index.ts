// ============================================================================
// Electron main entry — vòng đời app, cửa sổ, IPC, embedded bridge, queue.
// ============================================================================

import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpc } from './ipc'
import { configStore } from './services/config'
import { queueStore } from './services/queueStore'
import { embeddedBridge } from './bridge/embeddedBridge'
import { initAutoUpdate } from './updater'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1413', // nền tối khớp theme — tránh flash trắng
    title: 'Lamha Importer',
    icon, // logo taskbar (dev); bản đóng gói lấy từ build/icon.ico
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function startBridge(): Promise<void> {
  const cfg = configStore.get()
  try {
    await embeddedBridge.start({
      host: cfg.bridgeHost,
      port: cfg.bridgePort,
      token: cfg.bridgeToken
    })
  } catch (e) {
    // Không chặn app nếu cổng bận — UI sẽ báo health.running=false qua Settings.
    console.error('[bridge] start lỗi:', (e as Error).message)
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('vn.lamha.importer')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Khôi phục job dở dang (crash/cúp điện) về mốc an toàn idempotent.
  queueStore.recoverOnStartup()
  registerIpc()
  await startBridge()
  createWindow()
  initAutoUpdate() // tự kiểm tra & cập nhật qua GitHub Releases (chỉ bản đóng gói)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  embeddedBridge.stop()
  queueStore.close()
})
