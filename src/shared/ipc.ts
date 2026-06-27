// ============================================================================
// Hợp đồng IPC: tên kênh + kiểu API mà preload expose ra window.api.
// ============================================================================

import type {
  AppConfig,
  SiteTarget,
  BridgeHealth,
  AskResult,
  ExtractRule,
  QueueStats,
  RunRow,
  JobRow,
  ProductDraft,
  SitePingResult
} from './types'

export const IPC = {
  // app
  appGetVersion: 'app:getVersion',
  // config
  configGet: 'config:get',
  configUpdate: 'config:update',
  configAddSite: 'config:addSite',
  configRemoveSite: 'config:removeSite',
  configSetActiveSite: 'config:setActiveSite',
  // dialog
  pickExcel: 'dialog:pickExcel',
  pickImageFolder: 'dialog:pickImageFolder',
  // bridge
  bridgeHealth: 'bridge:health',
  bridgeAsk: 'bridge:ask',
  // site
  sitePing: 'site:ping',
  // excel/import
  importParse: 'import:parse',
  importEnqueue: 'import:enqueue',
  // queue
  queueStats: 'queue:stats',
  queueListRuns: 'queue:listRuns',
  queueListJobs: 'queue:listJobs',
  queueRecover: 'queue:recover',
  queueDeleteRun: 'queue:deleteRun',
  queueRerollRun: 'queue:rerollRun',
  queueRetryErrors: 'queue:retryErrors',
  // batch
  batchRunStageA: 'batch:runStageA',
  batchRunStageB: 'batch:runStageB',
  batchCancel: 'batch:cancel',
  // events (main → renderer)
  evtBatchProgress: 'evt:batchProgress',
  evtBridgeStatus: 'evt:bridgeStatus',
  evtUpdateStatus: 'evt:updateStatus'
} as const

/** Trạng thái tự cập nhật app (auto-update qua GitHub Releases). */
export interface UpdateStatus {
  state: 'checking' | 'available' | 'none' | 'downloading' | 'downloaded' | 'error'
  version?: string
  percent?: number
  message?: string
}

export interface ImportParseResult {
  drafts: ProductDraft[]
  skipped: number // số note/template rows bỏ
  total: number
}

export interface BatchProgressEvent {
  runId: string
  phase: 'A' | 'B'
  jobId: string
  rowIndex: number
  title: string
  status: string
  message?: string
  stats: QueueStats
}

/** API expose qua window.api (preload). */
export interface Api {
  app: {
    getVersion(): Promise<string>
  }
  config: {
    get(): Promise<AppConfig>
    update(partial: Partial<AppConfig>): Promise<AppConfig>
    addSite(site: SiteTarget): Promise<AppConfig>
    removeSite(siteId: string): Promise<AppConfig>
    setActiveSite(siteId: string): Promise<AppConfig>
  }
  dialog: {
    pickExcel(): Promise<string | null>
    pickImageFolder(): Promise<string | null>
  }
  bridge: {
    health(): Promise<BridgeHealth>
    ask(
      prompt: string,
      opts?: { newChat?: boolean; conversationId?: string; timeoutMs?: number; extract?: ExtractRule }
    ): Promise<AskResult>
  }
  site: {
    ping(siteId: string): Promise<SitePingResult>
  }
  import: {
    parse(filePath: string, imageFolder: string, siteId: string): Promise<ImportParseResult>
    enqueue(siteId: string, filePath: string, imageFolder: string, drafts: ProductDraft[]): Promise<{ runId: string }>
  }
  queue: {
    stats(runId: string): Promise<QueueStats>
    listRuns(): Promise<RunRow[]>
    listJobs(runId: string): Promise<JobRow[]>
    recover(): Promise<void>
    deleteRun(runId: string): Promise<void>
    rerollRun(runId: string): Promise<{ products: number; media: number; errors: string[] }>
    retryErrors(runId: string): Promise<number>
  }
  batch: {
    runStageA(runId: string): Promise<void>
    runStageB(runId: string): Promise<void>
    cancel(runId: string): Promise<void>
  }
  on: {
    batchProgress(cb: (e: BatchProgressEvent) => void): () => void
    bridgeStatus(cb: (h: BridgeHealth) => void): () => void
    updateStatus(cb: (s: UpdateStatus) => void): () => void
  }
}
