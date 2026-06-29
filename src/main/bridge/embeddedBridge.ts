// ============================================================================
// EmbeddedBridge — NHÚNG GPT Bridge vào Electron main (D10).
// Gộp queue (in-memory) + WS hub (/ws) + worker pump() vào 1 service self-contained.
// App gọi thẳng ask() in-process (không HTTP /v1, không poll).
//
// Port hợp đồng từ Add-On GPT/server/src/{queue.js, extensionHub.js, index.js}.
// Extension nối tới ws://<host>:<port>/ws?token=<token> — KHÔNG cần đổi gì.
// ============================================================================

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { WebSocketServer, WebSocket } from 'ws'
import { applyExtract } from './extract'
import type { AskResult, BridgeHealth, ExtractRule } from '@shared/types'

type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'timeout'

interface InternalJob {
  id: string
  prompt: string
  conversationId: string | null
  newChat: boolean
  image: boolean
  extract: ExtractRule | null
  timeoutMs: number // IDLE window: timeout khi KHÔNG nhận thêm delta nào trong khoảng này (mặc định 3 phút)
  status: JobStatus
  answer: string
  rawAnswer: string
  extractWarning: string | null
  images: string[]
  error: string | null
}

export interface BridgeStartOpts {
  port: number
  host: string
  token: string
  defaultTimeoutMs?: number
}

/** Message extension → server. */
interface ExtMessage {
  type: 'ready' | 'delta' | 'done' | 'error' | 'pong'
  jobId?: string
  text?: string
  answer?: string
  conversationId?: string
  images?: string[]
  message?: string
}

export class EmbeddedBridge extends EventEmitter {
  private wss: WebSocketServer | null = null
  private socket: WebSocket | null = null
  private socketAlive = false
  private heartbeat: NodeJS.Timeout | null = null

  private jobs = new Map<string, InternalJob>()
  private waiting: string[] = []
  private inFlightId: string | null = null
  private inFlightTimer: NodeJS.Timeout | null = null

  private opts: BridgeStartOpts | null = null
  private starting = false

  // --------------------------------------------------------------- lifecycle

  start(opts: BridgeStartOpts): Promise<void> {
    if (this.wss) {
      // đang chạy với cấu hình khác → restart
      if (this.opts && (this.opts.port !== opts.port || this.opts.host !== opts.host)) {
        return this.stop().then(() => this.start(opts))
      }
      this.opts = opts // cập nhật token nếu đổi
      return Promise.resolve()
    }
    this.opts = opts
    this.starting = true

    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port: opts.port, host: opts.host, path: '/ws' })

      wss.on('listening', () => {
        this.starting = false
        this.wss = wss
        this.installHandlers(wss)
        this.startHeartbeat()
        console.log(`[bridge] hub WS đang chạy: ws://${opts.host}:${opts.port}/ws`)
        resolve()
      })

      wss.on('error', (err: NodeJS.ErrnoException) => {
        if (this.starting) {
          this.starting = false
          if (err.code === 'EADDRINUSE') {
            reject(
              new Error(
                `Cổng ${opts.port} đã bị chiếm (có thể server Add-On GPT rời đang chạy). ` +
                  `Hãy tắt server đó hoặc đổi cổng trong Cài đặt.`
              )
            )
          } else {
            reject(err)
          }
          return
        }
        console.warn('[bridge] WSS error:', err.message)
      })
    })
  }

  async stop(): Promise<void> {
    this.stopHeartbeat()
    this.clearInFlightTimer()
    if (this.inFlightId) this.markError(this.inFlightId, 'bridge shutdown')
    if (this.socket) {
      try {
        this.socket.close(4000, 'shutdown')
      } catch {
        /* ignore */
      }
      this.socket = null
    }
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve()
      this.wss.close(() => resolve())
      this.wss = null
    })
  }

  // --------------------------------------------------------------- public API

  health(): BridgeHealth {
    return {
      running: !!this.wss,
      extensionConnected: this.isExtensionConnected(),
      queueDepth: this.waiting.length,
      inFlight: this.inFlightId ? 1 : 0
    }
  }

  /** Gửi prompt, chờ kết quả in-process. Ném lỗi khi error/timeout. */
  ask(
    prompt: string,
    opts?: {
      newChat?: boolean
      conversationId?: string
      timeoutMs?: number
      extract?: ExtractRule
      image?: boolean
    }
  ): Promise<AskResult> {
    if (!this.wss) return Promise.reject(new Error('Bridge hub chưa khởi động.'))
    if (!this.isExtensionConnected()) {
      return Promise.reject(new Error('Extension chưa kết nối — hãy bật addon + mở tab ChatGPT đã đăng nhập.'))
    }

    const job: InternalJob = {
      id: randomUUID(),
      prompt,
      conversationId: opts?.conversationId ?? null,
      newChat: opts?.newChat ?? false,
      image: opts?.image ?? false,
      extract: opts?.extract ?? null,
      timeoutMs: Number.isFinite(opts?.timeoutMs) ? (opts!.timeoutMs as number) : this.opts?.defaultTimeoutMs ?? 180_000,
      status: 'queued',
      answer: '',
      rawAnswer: '',
      extractWarning: null,
      images: [],
      error: null
    }
    this.jobs.set(job.id, job)
    this.waiting.push(job.id)

    return new Promise<AskResult>((resolve, reject) => {
      const onSettled = (settledId: string, status: JobStatus): void => {
        if (settledId !== job.id) return
        this.off('settled', onSettled)
        const j = this.jobs.get(job.id)
        this.jobs.delete(job.id)
        if (!j || status !== 'done') {
          reject(new Error(j?.error || `job ${status}`))
          return
        }
        resolve({
          answer: j.answer,
          rawAnswer: j.rawAnswer,
          extractWarning: j.extractWarning,
          conversationId: j.conversationId,
          images: j.images
        })
      }
      this.on('settled', onSettled)
      this.pump()
    })
  }

  // --------------------------------------------------------------- WS hub

  private isExtensionConnected(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN
  }

  private installHandlers(wss: WebSocketServer): void {
    wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '', 'http://localhost')
      const token =
        url.searchParams.get('token') || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '')

      if (token !== this.opts?.token) {
        ws.close(4001, 'unauthorized')
        return
      }

      // chỉ 1 extension: thay thế connection cũ
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.close(4000, 'replaced')
        } catch {
          /* ignore */
        }
      }
      this.socket = ws
      this.socketAlive = true
      console.log('[bridge] extension đã kết nối.')
      this.emit('extension', true)

      ws.on('pong', () => {
        this.socketAlive = true
      })

      ws.on('message', (raw) => {
        let msg: ExtMessage
        try {
          msg = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (msg.type === 'pong') {
          this.socketAlive = true
          return
        }
        this.handleExtMessage(msg)
      })

      ws.on('close', () => {
        if (this.socket === ws) {
          this.socket = null
          console.log('[bridge] extension đã ngắt.')
          this.emit('extension', false)
          // job đang chạy coi như lỗi
          if (this.inFlightId) this.markError(this.inFlightId, 'extension disconnected khi đang xử lý')
        }
      })

      ws.on('error', (err) => console.warn('[bridge] lỗi WS:', err.message))

      // có extension → thử pump job đang chờ
      this.pump()
    })
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      const ws = this.socket
      if (!ws) return
      if (this.socketAlive === false) {
        try {
          ws.terminate()
        } catch {
          /* ignore */
        }
        return
      }
      this.socketAlive = false
      try {
        ws.ping()
      } catch {
        /* ignore */
      }
    }, 20_000)
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  // --------------------------------------------------------------- queue/pump

  private pump(): void {
    if (!this.isExtensionConnected()) return
    if (this.inFlightId) return

    const id = this.waiting.shift()
    if (!id) return
    const job = this.jobs.get(id)
    if (!job || job.status !== 'queued') return this.pump()

    job.status = 'running'
    this.inFlightId = id

    const sent = this.send({
      type: 'job',
      jobId: job.id,
      prompt: job.prompt,
      conversationId: job.conversationId,
      newChat: job.newChat,
      image: job.image,
      timeoutMs: job.timeoutMs
    })

    if (!sent) {
      this.markError(job.id, 'extension disconnected trước khi gửi job')
      return
    }

    this.armIdleTimer(job)
  }

  /** Đặt/gia hạn timer IDLE: chỉ timeout khi KHÔNG nhận thêm delta nào trong `timeoutMs`
   *  (mặc định 3 phút). Gọi lại mỗi delta để gia hạn → GPT còn đang trả lời thì không bị giết oan;
   *  chỉ khi im lặng đủ lâu (treo/đứt) mới timeout. */
  private armIdleTimer(job: InternalJob): void {
    this.clearInFlightTimer()
    this.inFlightTimer = setTimeout(() => {
      if (this.inFlightId === job.id) this.markTimeout(job.id)
    }, job.timeoutMs)
    this.inFlightTimer.unref?.()
  }

  private handleExtMessage(msg: ExtMessage): void {
    switch (msg.type) {
      case 'ready':
        this.pump()
        break
      case 'delta': {
        const j = msg.jobId ? this.jobs.get(msg.jobId) : null
        if (j && j.status === 'running') {
          j.rawAnswer += msg.text || ''
          j.answer += msg.text || ''
          if (this.inFlightId === j.id) this.armIdleTimer(j) // có hoạt động → gia hạn idle, né timeout oan
        }
        break
      }
      case 'done':
        if (msg.jobId) this.markDone(msg.jobId, msg)
        break
      case 'error':
        if (msg.jobId) this.markError(msg.jobId, msg.message || 'extension error')
        break
    }
  }

  private send(obj: unknown): boolean {
    if (!this.isExtensionConnected()) return false
    try {
      this.socket!.send(JSON.stringify(obj))
      return true
    } catch {
      return false
    }
  }

  private markDone(id: string, msg: ExtMessage): void {
    const job = this.jobs.get(id)
    if (!job) return
    if (typeof msg.answer === 'string' && msg.answer.length) job.rawAnswer = msg.answer
    const { answer, warning } = applyExtract(job.rawAnswer, job.extract)
    job.answer = answer
    job.extractWarning = warning
    if (msg.conversationId) job.conversationId = msg.conversationId
    if (Array.isArray(msg.images) && msg.images.length) job.images = msg.images
    this.settle(job, 'done')
  }

  private markError(id: string, message: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.error = message || 'unknown error'
    this.settle(job, 'error')
  }

  private markTimeout(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    job.error = 'timeout'
    this.settle(job, 'timeout')
  }

  private settle(job: InternalJob, status: JobStatus): void {
    if (job.status === 'done' || job.status === 'error' || job.status === 'timeout') return
    job.status = status
    if (this.inFlightId === job.id) this.inFlightId = null
    this.clearInFlightTimer()
    this.emit('settled', job.id, status)
    this.pump()
  }

  private clearInFlightTimer(): void {
    if (this.inFlightTimer) {
      clearTimeout(this.inFlightTimer)
      this.inFlightTimer = null
    }
  }
}

export const embeddedBridge = new EmbeddedBridge()
