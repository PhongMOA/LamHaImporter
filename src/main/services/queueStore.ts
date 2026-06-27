// ============================================================================
// QueueStore — durable queue (SQLite) chống crash/cúp điện (D8/R9).
// State machine 2 pha; mỗi chuyển trạng thái = 1 transaction nguyên tử.
// DB ở userData/queue.db, bật WAL.
// ============================================================================

import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import type {
  JobRow,
  RunRow,
  ProductDraft,
  QueueStats,
  StageAStatus,
  StageBStatus
} from '@shared/types'

const STAGE_A: StageAStatus[] = ['pending', 'creating', 'created', 'images', 'done', 'error']
const STAGE_B: StageBStatus[] = ['pending', 'generating', 'content', 'enriched', 'done', 'error']

class QueueStore {
  private db: Database.Database | null = null

  private conn(): Database.Database {
    if (this.db) return this.db
    const file = join(app.getPath('userData'), 'queue.db')
    const db = new Database(file)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, site_id TEXT, file TEXT, image_folder TEXT, created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        run_id TEXT, site_id TEXT, row_index INTEGER,
        model TEXT, title TEXT, draft_json TEXT,
        product_id TEXT, images_done INTEGER DEFAULT 0, images_total INTEGER DEFAULT 0,
        stage_a TEXT DEFAULT 'pending',
        conversation_id TEXT, detail TEXT, attributes_json TEXT, seo_json TEXT,
        reviewed INTEGER DEFAULT 0, stage_b TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0, last_error TEXT, updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_run ON jobs(run_id);
    `)
    // Migration: thêm cột seo_json cho DB tạo trước khi có bước SEO (ALTER idempotent qua table_info).
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]
    if (!cols.some((c) => c.name === 'seo_json')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN seo_json TEXT`)
    }
    this.db = db
    return db
  }

  // ----------------------------------------------------------------- enqueue

  enqueue(run: Omit<RunRow, 'created_at'>, drafts: ProductDraft[]): void {
    const db = this.conn()
    const now = Date.now()
    const insRun = db.prepare(
      `INSERT OR REPLACE INTO runs (id, site_id, file, image_folder, created_at) VALUES (?,?,?,?,?)`
    )
    const insJob = db.prepare(`
      INSERT OR REPLACE INTO jobs
        (id, run_id, site_id, row_index, model, title, draft_json, images_total, updated_at)
      VALUES (@id, @run_id, @site_id, @row_index, @model, @title, @draft_json, @images_total, @updated_at)
    `)
    const tx = db.transaction(() => {
      insRun.run(run.id, run.site_id, run.file, run.image_folder, now)
      for (const d of drafts) {
        insJob.run({
          id: `${run.id}:${d.rowIndex}`,
          run_id: run.id,
          site_id: run.site_id,
          row_index: d.rowIndex,
          model: d.model,
          title: d.title,
          draft_json: JSON.stringify(d),
          images_total: d.imageFiles.length,
          updated_at: now
        })
      }
    })
    tx()
  }

  /** Xóa hẳn 1 lần chạy (run + toàn bộ job của nó) khỏi queue. Không đụng tới sản phẩm đã đăng. */
  deleteRun(runId: string): void {
    const db = this.conn()
    db.transaction(() => {
      db.prepare(`DELETE FROM jobs WHERE run_id = ?`).run(runId)
      db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId)
    })()
  }

  /** Re-roll: đưa toàn bộ job của 1 run về mốc ban đầu để chạy lại từ đầu
   *  (sau khi đã xóa sản phẩm + media của run trên website). */
  resetRun(runId: string): void {
    this.conn()
      .prepare(
        `UPDATE jobs SET
           stage_a = 'pending', stage_b = 'pending',
           product_id = NULL, images_done = 0,
           conversation_id = NULL, detail = NULL, attributes_json = NULL, seo_json = NULL,
           reviewed = 0, attempts = 0, last_error = NULL,
           updated_at = @now
         WHERE run_id = @runId`
      )
      .run({ runId, now: Date.now() })
  }

  /** Đưa các job ĐANG LỖI về mốc chạy lại được (giữ checkpoint đã có để idempotent):
   *   - stage_a='error' → 'pending' (Pha A tự bỏ qua bước đã xong theo product_id/images_done).
   *   - stage_a='done' & stage_b='error' → stage_b='pending' (sinh/đăng lại nội dung).
   *  Trả về số job được reset. */
  retryErrors(runId: string): number {
    const db = this.conn()
    const now = Date.now()
    const a = db
      .prepare(
        `UPDATE jobs SET stage_a='pending', attempts=0, last_error=NULL, updated_at=@now
         WHERE run_id=@runId AND stage_a='error'`
      )
      .run({ runId, now })
    const b = db
      .prepare(
        `UPDATE jobs SET stage_b='pending', attempts=0, last_error=NULL, updated_at=@now
         WHERE run_id=@runId AND stage_a='done' AND stage_b='error'`
      )
      .run({ runId, now })
    return a.changes + b.changes
  }

  // ------------------------------------------------------------------ reads

  listRuns(): RunRow[] {
    return this.conn().prepare(`SELECT * FROM runs ORDER BY created_at DESC`).all() as RunRow[]
  }

  listJobs(runId: string): JobRow[] {
    return this.conn()
      .prepare(`SELECT * FROM jobs WHERE run_id = ? ORDER BY row_index ASC`)
      .all(runId) as JobRow[]
  }

  getJob(id: string): JobRow | undefined {
    return this.conn().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined
  }

  getDraft(job: JobRow): ProductDraft {
    return JSON.parse(job.draft_json) as ProductDraft
  }

  /** Job kế tiếp cho Pha A (chưa done/error). */
  nextStageA(runId: string): JobRow | undefined {
    return this.conn()
      .prepare(
        `SELECT * FROM jobs WHERE run_id = ? AND stage_a NOT IN ('done','error')
         ORDER BY row_index ASC LIMIT 1`
      )
      .get(runId) as JobRow | undefined
  }

  /** Job kế tiếp cho Pha B: Pha A đã xong, Pha B chưa done/error.
   *  1 pha xen kẽ — sinh content (nếu chưa có) rồi upsert ngay trong cùng lượt. */
  nextStageB(runId: string): JobRow | undefined {
    return this.conn()
      .prepare(
        `SELECT * FROM jobs WHERE run_id = ? AND stage_a = 'done'
         AND stage_b NOT IN ('done','error')
         ORDER BY row_index ASC LIMIT 1`
      )
      .get(runId) as JobRow | undefined
  }

  // ----------------------------------------------------------------- writes

  markStageA(id: string, patch: Partial<Pick<JobRow, 'stage_a' | 'product_id' | 'images_done' | 'images_total' | 'attempts' | 'last_error'>>): void {
    this.patchJob(id, patch)
  }

  markStageB(
    id: string,
    patch: Partial<Pick<JobRow, 'stage_b' | 'conversation_id' | 'detail' | 'attributes_json' | 'seo_json' | 'attempts' | 'last_error'>>
  ): void {
    this.patchJob(id, patch)
  }

  private patchJob(id: string, patch: Record<string, unknown>): void {
    const keys = Object.keys(patch)
    if (keys.length === 0) return
    const db = this.conn()
    const setSql = keys.map((k) => `${k} = @${k}`).join(', ')
    db.prepare(`UPDATE jobs SET ${setSql}, updated_at = @updated_at WHERE id = @id`).run({
      ...patch,
      id,
      updated_at: Date.now()
    })
  }

  // ---------------------------------------------------------------- recovery

  /** Đưa job đang "*-ing" (bị cắt giữa chừng) về mốc an toàn để chạy lại idempotent. */
  recoverOnStartup(): void {
    const db = this.conn()
    db.transaction(() => {
      // creating → pending (chưa chắc tạo xong); created/images giữ nguyên (idempotent theo product_id)
      db.prepare(`UPDATE jobs SET stage_a = 'pending' WHERE stage_a = 'creating'`).run()
      db.prepare(`UPDATE jobs SET stage_b = 'pending' WHERE stage_b = 'generating'`).run()
    })()
  }

  // ------------------------------------------------------------------- stats

  stats(runId: string): QueueStats {
    const db = this.conn()
    const stageA = Object.fromEntries(STAGE_A.map((s) => [s, 0])) as Record<StageAStatus, number>
    const stageB = Object.fromEntries(STAGE_B.map((s) => [s, 0])) as Record<StageBStatus, number>
    const out: QueueStats = { total: 0, stageA, stageB }

    const rows = db
      .prepare(`SELECT stage_a, stage_b, COUNT(*) AS c FROM jobs WHERE run_id = ? GROUP BY stage_a, stage_b`)
      .all(runId) as { stage_a: StageAStatus; stage_b: StageBStatus; c: number }[]
    for (const r of rows) {
      out.total += r.c
      out.stageA[r.stage_a] = (out.stageA[r.stage_a] || 0) + r.c
      out.stageB[r.stage_b] = (out.stageB[r.stage_b] || 0) + r.c
    }
    return out
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}

export const queueStore = new QueueStore()
