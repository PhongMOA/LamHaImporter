// ============================================================================
// Preload — expose window.api typed (khớp shared/ipc.ts Api). contextIsolation.
// ============================================================================

import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type BatchProgressEvent, type UpdateStatus } from '@shared/ipc'
import type { Api } from '@shared/ipc'
import type { BridgeHealth } from '@shared/types'

const api: Api = {
  app: {
    getVersion: () => ipcRenderer.invoke(IPC.appGetVersion)
  },
  config: {
    get: () => ipcRenderer.invoke(IPC.configGet),
    update: (partial) => ipcRenderer.invoke(IPC.configUpdate, partial),
    addSite: (site) => ipcRenderer.invoke(IPC.configAddSite, site),
    removeSite: (siteId) => ipcRenderer.invoke(IPC.configRemoveSite, siteId),
    setActiveSite: (siteId) => ipcRenderer.invoke(IPC.configSetActiveSite, siteId)
  },
  dialog: {
    pickExcel: () => ipcRenderer.invoke(IPC.pickExcel),
    pickImageFolder: () => ipcRenderer.invoke(IPC.pickImageFolder)
  },
  bridge: {
    health: () => ipcRenderer.invoke(IPC.bridgeHealth),
    ask: (prompt, opts) => ipcRenderer.invoke(IPC.bridgeAsk, prompt, opts)
  },
  site: {
    ping: (siteId) => ipcRenderer.invoke(IPC.sitePing, siteId)
  },
  import: {
    parse: (filePath, imageFolder, siteId) => ipcRenderer.invoke(IPC.importParse, filePath, imageFolder, siteId),
    enqueue: (siteId, filePath, imageFolder, drafts) =>
      ipcRenderer.invoke(IPC.importEnqueue, siteId, filePath, imageFolder, drafts)
  },
  queue: {
    stats: (runId) => ipcRenderer.invoke(IPC.queueStats, runId),
    listRuns: () => ipcRenderer.invoke(IPC.queueListRuns),
    listJobs: (runId) => ipcRenderer.invoke(IPC.queueListJobs, runId),
    recover: () => ipcRenderer.invoke(IPC.queueRecover),
    deleteRun: (runId) => ipcRenderer.invoke(IPC.queueDeleteRun, runId),
    rerollRun: (runId) => ipcRenderer.invoke(IPC.queueRerollRun, runId),
    retryErrors: (runId) => ipcRenderer.invoke(IPC.queueRetryErrors, runId)
  },
  batch: {
    runStageA: (runId) => ipcRenderer.invoke(IPC.batchRunStageA, runId),
    runStageB: (runId) => ipcRenderer.invoke(IPC.batchRunStageB, runId),
    cancel: (runId) => ipcRenderer.invoke(IPC.batchCancel, runId)
  },
  update: {
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    download: () => ipcRenderer.invoke(IPC.updateDownload),
    install: () => ipcRenderer.invoke(IPC.updateInstall)
  },
  on: {
    batchProgress: (cb) => {
      const h = (_e: unknown, evt: BatchProgressEvent): void => cb(evt)
      ipcRenderer.on(IPC.evtBatchProgress, h)
      return () => ipcRenderer.removeListener(IPC.evtBatchProgress, h)
    },
    bridgeStatus: (cb) => {
      const h = (_e: unknown, health: BridgeHealth): void => cb(health)
      ipcRenderer.on(IPC.evtBridgeStatus, h)
      return () => ipcRenderer.removeListener(IPC.evtBridgeStatus, h)
    },
    updateStatus: (cb) => {
      const h = (_e: unknown, s: UpdateStatus): void => cb(s)
      ipcRenderer.on(IPC.evtUpdateStatus, h)
      return () => ipcRenderer.removeListener(IPC.evtUpdateStatus, h)
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (fallback khi tắt contextIsolation)
  window.api = api
}
