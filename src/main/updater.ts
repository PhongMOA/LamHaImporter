// ============================================================================
// Auto-update qua GitHub Releases (repo PhongMOA/LamHaImporter, public).
//
// Luồng: mở app → tự check → có bản mới thì tải ngầm → tải xong thì CÀI + THOÁT app
// (không tự mở lại; người dùng mở lại sẽ là bản mới). Chỉ chạy ở bản đóng gói.
// ============================================================================

import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '@shared/ipc'
import { IPC } from '@shared/ipc'

// electron-updater là CommonJS → lấy autoUpdater qua default import (ESM interop).
const { autoUpdater } = electronUpdater

function notify(s: UpdateStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.evtUpdateStatus, s)
  }
}

/** Khởi tạo auto-update. Gọi sau khi cửa sổ đã tạo. */
export function initAutoUpdate(): void {
  // Dev (chưa đóng gói) không có app-update.yml → bỏ qua, tránh ném lỗi gây nhiễu.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = true // có bản mới là tải ngầm luôn
  autoUpdater.autoInstallOnAppQuit = true // phòng khi chưa kịp cài: lần thoát sau tự cài
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => notify({ state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    notify({ state: 'available', version: info.version })
  )
  autoUpdater.on('update-not-available', () => notify({ state: 'none' }))
  autoUpdater.on('download-progress', (p) =>
    notify({ state: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('error', (e) =>
    notify({ state: 'error', message: (e as Error)?.message || 'unknown' })
  )
  autoUpdater.on('update-downloaded', (info) => {
    notify({ state: 'downloaded', version: info.version })
    // Tải xong → cài im lặng & THOÁT app (isSilent=true, isForceRunAfter=false).
    // Trễ 1.5s để renderer kịp hiển thị thông báo trước khi đóng.
    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(true, false)
      } catch (e) {
        console.error('[update] quitAndInstall lỗi:', (e as Error).message)
      }
    }, 1500)
  })

  autoUpdater.checkForUpdates().catch((e) =>
    console.error('[update] check lỗi:', (e as Error).message)
  )
}
