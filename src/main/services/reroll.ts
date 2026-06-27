// ============================================================================
// Re-roll 1 run: xóa toàn bộ sản phẩm + media đã đăng của run trên website,
// rồi reset run về trạng thái ban đầu để chạy lại từ đầu. Không thể hoàn tác.
// ============================================================================

import { queueStore } from './queueStore'
import { SiteClient } from './siteClient'
import { configStore } from './config'

export interface RerollResult {
  products: number // số sản phẩm đã xóa khỏi web
  media: number // số media (ảnh) đã xóa khỏi web
  errors: string[] // lỗi từng sản phẩm (nếu có) — vẫn tiếp tục các SP còn lại
}

export async function rerollRun(runId: string): Promise<RerollResult> {
  const run = queueStore.listRuns().find((r) => r.id === runId)
  if (!run) throw new Error('Run không tồn tại')
  const site = configStore.getSite(run.site_id)
  if (!site) throw new Error(`Không tìm thấy site "${run.site_id}"`)

  const client = new SiteClient(site)
  await client.ensureCsrf()

  const result: RerollResult = { products: 0, media: 0, errors: [] }
  for (const job of queueStore.listJobs(runId)) {
    if (!job.product_id) continue
    try {
      // Xóa media trước (cần product_id còn sống để query target_id), rồi xóa sản phẩm.
      const mediaIds = await client.listMediaIds(job.product_id)
      if (mediaIds.length) {
        await client.deleteMedia(mediaIds)
        result.media += mediaIds.length
      }
      await client.deleteProduct(job.product_id)
      result.products += 1
    } catch (e) {
      result.errors.push(`#${job.row_index} ${job.title}: ${(e as Error).message}`)
    }
  }

  // Reset run dù có lỗi lẻ — phần xóa được đã xóa; chạy lại Pha A sẽ tạo mới idempotent.
  queueStore.resetRun(runId)
  return result
}
