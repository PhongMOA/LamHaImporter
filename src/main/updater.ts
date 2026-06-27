// ============================================================================
// Auto-update qua GitHub Releases (repo PhongMOA/LamHaImporter, public).
//
// Luồng MỚI (không tự ý thoát app):
//   mở app → tự check ngầm → CÓ bản mới thì báo renderer (state 'available')
//   → renderer hiện modal hỏi người dùng → người dùng bấm "Cập nhật" → download()
//   → tải xong (state 'downloaded') → người dùng bấm "Cài & khởi động lại" → install()
//   → quitAndInstall(false, true): cài rồi TỰ MỞ LẠI app (hết cảnh phải tắt mở tay).
// Settings có nút "Kiểm tra cập nhật" gọi checkForUpdate() thủ công.
// Chỉ tải/cài ở bản đóng gói; dev trả về { dev: true }.
// ============================================================================

import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus, UpdateCheckResult } from '@shared/ipc'
import { IPC } from '@shared/ipc'

// electron-updater là CommonJS → lấy autoUpdater qua default import (ESM interop).
const { autoUpdater } = electronUpdater

let wired = false
let lastAvailableVersion: string | undefined

function notify(s: UpdateStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(IPC.evtUpdateStatus, s)
  }
}

/** Gắn event listener (1 lần). Tải về phải do người dùng đồng ý → autoDownload=false. */
function wire(): void {
  if (wired) return
  wired = true

  autoUpdater.autoDownload = false // KHÔNG tải ngầm — chờ người dùng bấm trong modal
  autoUpdater.autoInstallOnAppQuit = true // đã tải xong mà chưa cài: lần thoát sau tự cài
  autoUpdater.logger = null

  autoUpdater.on('checking-for-update', () => notify({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => {
    lastAvailableVersion = info.version
    notify({ state: 'available', version: info.version })
  })
  autoUpdater.on('update-not-available', () => notify({ state: 'none' }))
  autoUpdater.on('download-progress', (p) =>
    notify({ state: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('error', (e) =>
    notify({ state: 'error', message: (e as Error)?.message || 'unknown' })
  )
  autoUpdater.on('update-downloaded', (info) => {
    notify({ state: 'downloaded', version: info.version })
  })
}

/**
 * Kiểm tra cập nhật (auto lúc khởi động & nút thủ công trong Settings).
 * KHÔNG tải về — chỉ trả kết quả để renderer quyết định hiện modal.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = app.getVersion()
  // Dev (chưa đóng gói) không có app-update.yml → không thể check thật.
  if (!app.isPackaged) return { available: false, current, dev: true }

  wire()
  lastAvailableVersion = undefined
  try {
    const res = await autoUpdater.checkForUpdates()
    const version = res?.updateInfo?.version
    // checkForUpdates() chỉ resolve khi xong; sự kiện 'update-available' (nếu có bản mới hơn)
    // đã set lastAvailableVersion. Coi là có bản mới khi version remote khác bản hiện tại
    // VÀ event 'update-available' đã bắn.
    const available = !!version && version !== current && lastAvailableVersion === version
    return { available, version, current }
  } catch (e) {
    const message = (e as Error)?.message || 'Lỗi kiểm tra cập nhật'
    notify({ state: 'error', message })
    return { available: false, current, error: message }
  }
}

/** Tải bản cập nhật (sau khi người dùng đồng ý trong modal). */
export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) return
  wire()
  notify({ state: 'downloading', percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (e) {
    const message = (e as Error)?.message || 'Lỗi tải cập nhật'
    notify({ state: 'error', message })
    throw e
  }
}

/** Cài bản đã tải & TỰ KHỞI ĐỘNG LẠI app (isSilent=false để hiện trình cài, isForceRunAfter=true). */
export function installUpdate(): void {
  if (!app.isPackaged) return
  // isForceRunAfter=true → cài xong tự mở lại app, người dùng không phải tắt/mở tay.
  setTimeout(() => {
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (e) {
      console.error('[update] quitAndInstall lỗi:', (e as Error).message)
    }
  }, 300)
}

/** Khởi tạo: tự kiểm tra 1 lần lúc khởi động (không tải). Gọi sau khi cửa sổ đã tạo. */
export function initAutoUpdate(): void {
  if (!app.isPackaged) return
  checkForUpdate().catch((e) =>
    console.error('[update] check lỗi:', (e as Error).message)
  )
}
