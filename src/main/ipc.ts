// ============================================================================
// IPC handlers — cầu nối renderer ↔ main services. Typed qua shared/ipc.ts.
// ============================================================================

import { app, ipcMain, dialog, BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC, type BatchProgressEvent } from '@shared/ipc'
import type { ProductDraft, SiteTarget, AppConfig, ExtractRule } from '@shared/types'
import { configStore } from './services/config'
import { queueStore } from './services/queueStore'
import { embeddedBridge } from './bridge/embeddedBridge'
import { SiteClient } from './services/siteClient'
import { TaxonomyResolver } from './services/taxonomyResolver'
import { parseExcel } from './services/excel'
import { runStageA, cancelStageA, type StageProgress } from './services/stageA'
import { runStageB, cancelStageB } from './services/stageB'
import { rerollRun } from './services/reroll'

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

export function registerIpc(): void {
  // ------------------------------------------------------------------- app
  ipcMain.handle(IPC.appGetVersion, () => app.getVersion())

  // ---------------------------------------------------------------- config
  ipcMain.handle(IPC.configGet, () => configStore.get())
  ipcMain.handle(IPC.configUpdate, async (_e, partial: Partial<AppConfig>) => {
    const cfg = configStore.update(partial)
    // Đổi host/port/token bridge → áp lại hub ngay (start() tự restart nếu host/port đổi,
    // hoặc cập nhật token nóng nếu chỉ đổi token) để không phải khởi động lại app.
    if (
      partial.bridgeHost !== undefined ||
      partial.bridgePort !== undefined ||
      partial.bridgeToken !== undefined
    ) {
      try {
        await embeddedBridge.start({ host: cfg.bridgeHost, port: cfg.bridgePort, token: cfg.bridgeToken })
      } catch (e) {
        console.error('[bridge] áp cấu hình mới lỗi:', (e as Error).message)
      }
      broadcast(IPC.evtBridgeStatus, embeddedBridge.health())
    }
    return cfg
  })
  ipcMain.handle(IPC.configAddSite, (_e, site: SiteTarget) => configStore.addSite(site))
  ipcMain.handle(IPC.configRemoveSite, (_e, id: string) => configStore.removeSite(id))
  ipcMain.handle(IPC.configSetActiveSite, (_e, id: string) => configStore.setActiveSite(id))

  // ---------------------------------------------------------------- dialog
  ipcMain.handle(IPC.pickExcel, async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }]
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle(IPC.pickImageFolder, async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // ---------------------------------------------------------------- bridge
  ipcMain.handle(IPC.bridgeHealth, () => embeddedBridge.health())
  ipcMain.handle(
    IPC.bridgeAsk,
    (_e, prompt: string, opts?: { newChat?: boolean; conversationId?: string; timeoutMs?: number; extract?: ExtractRule }) =>
      embeddedBridge.ask(prompt, opts)
  )

  // ---------------------------------------------------------------- site
  ipcMain.handle(IPC.sitePing, async (_e, siteId: string) => {
    const site = configStore.getSite(siteId)
    if (!site) return { ok: false, csrfToken: false, message: 'Site không tồn tại' }
    return new SiteClient(site).ping()
  })

  // ---------------------------------------------------------------- import
  ipcMain.handle(IPC.importParse, async (_e, filePath: string, imageFolder: string, siteId: string) => {
    const { drafts, skipped, total } = parseExcel(filePath, { imageFolder })
    // annotate taxonomy cate/spec_group cần map
    const site = configStore.getSite(siteId)
    if (site) {
      const resolver = new TaxonomyResolver(new SiteClient(site), siteId)
      // Nạp map sống từ /admin/taxonomies để auto-map cate/spec_group theo slug (nếu có tài khoản admin).
      await resolver.loadLiveMaps()
      const autoCreate = configStore.get().autoCreateSpecGroup
      for (const d of drafts) resolver.annotateNeedCreate(d, autoCreate)
    }
    return { drafts, skipped, total }
  })

  ipcMain.handle(
    IPC.importEnqueue,
    (_e, siteId: string, filePath: string, imageFolder: string, drafts: ProductDraft[]) => {
      const runId = randomUUID()
      queueStore.enqueue({ id: runId, site_id: siteId, file: filePath, image_folder: imageFolder }, drafts)
      return { runId }
    }
  )

  // ---------------------------------------------------------------- queue
  ipcMain.handle(IPC.queueStats, (_e, runId: string) => queueStore.stats(runId))
  ipcMain.handle(IPC.queueListRuns, () => queueStore.listRuns())
  ipcMain.handle(IPC.queueListJobs, (_e, runId: string) => queueStore.listJobs(runId))
  ipcMain.handle(IPC.queueRecover, () => queueStore.recoverOnStartup())
  ipcMain.handle(IPC.queueDeleteRun, (_e, runId: string) => {
    cancelStageA(runId)
    cancelStageB(runId)
    queueStore.deleteRun(runId)
  })
  ipcMain.handle(IPC.queueRerollRun, async (_e, runId: string) => {
    cancelStageA(runId)
    cancelStageB(runId)
    return rerollRun(runId)
  })
  ipcMain.handle(IPC.queueRetryErrors, (_e, runId: string) => queueStore.retryErrors(runId))

  // ---------------------------------------------------------------- batch
  const makeEmit =
    (runId: string, phase: 'A' | 'B') =>
    (p: StageProgress): void => {
      const evt: BatchProgressEvent = {
        runId,
        phase,
        jobId: p.jobId,
        rowIndex: p.rowIndex,
        title: p.title,
        status: p.status,
        message: p.message,
        stats: queueStore.stats(runId)
      }
      broadcast(IPC.evtBatchProgress, evt)
    }

  ipcMain.handle(IPC.batchRunStageA, async (_e, runId: string) => {
    const run = queueStore.listRuns().find((r) => r.id === runId)
    if (!run) throw new Error('Run không tồn tại')
    await runStageA(runId, run.site_id, makeEmit(runId, 'A'))
  })
  ipcMain.handle(IPC.batchRunStageB, async (_e, runId: string) => {
    const run = queueStore.listRuns().find((r) => r.id === runId)
    if (!run) throw new Error('Run không tồn tại')
    await runStageB(runId, run.site_id, makeEmit(runId, 'B'))
  })
  ipcMain.handle(IPC.batchCancel, (_e, runId?: string) => {
    cancelStageA(runId)
    cancelStageB(runId)
  })

  // ---------------------------------------------------------------- bridge status → renderer
  embeddedBridge.on('extension', () => broadcast(IPC.evtBridgeStatus, embeddedBridge.health()))
}
