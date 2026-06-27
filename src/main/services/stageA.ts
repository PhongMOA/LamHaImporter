// ============================================================================
// Pha A — Upload khung sản phẩm (visible, không cần AI). Idempotent + resumable.
//
// State machine (mỗi bước checkpoint vào SQLite ngay khi chắc chắn xong):
//   pending → creating → created(product_id) → images(images_done++) → done
//
// Idempotent:
//   - product_id đã có ⇒ bỏ qua create.
//   - images_done đã đạt images_total ⇒ bỏ qua upload.
//   - PUT taxonomy resolve-or-create theo meta_slug ⇒ lặp lại an toàn.
// ============================================================================

import type { JobRow, ProductDraft } from '@shared/types'
import { queueStore } from './queueStore'
import { SiteClient } from './siteClient'
import { TaxonomyResolver } from './taxonomyResolver'
import { configStore } from './config'
import { processImage } from './image'

export interface StageProgress {
  jobId: string
  rowIndex: number
  title: string
  status: string
  message?: string
}

export interface RunController {
  cancelled: boolean
}

/** Form tối thiểu để POST tạo sản phẩm (chưa có brand/series/madein — gắn qua PUT new_*). */
function buildCreateForm(draft: ProductDraft, resolver: TaxonomyResolver): Record<string, unknown> {
  const form: Record<string, unknown> = {
    title: draft.title,
    model: draft.model,
    price: draft.price,
    warranty: draft.warranty,
    status_text: draft.status_text,
    manual: draft.manual,
    desc: draft.desc || ''
  }
  const cateId = resolver.resolveCate(draft.cateSlug)
  if (cateId) form.cate = cateId
  const specId = resolver.resolveSpecGroup(draft.specGroupText)
  if (specId) form.spec_group = specId
  return form
}

async function processJob(
  job: JobRow,
  client: SiteClient,
  resolver: TaxonomyResolver,
  ctrl: RunController,
  emit: (p: StageProgress) => void
): Promise<void> {
  const draft = queueStore.getDraft(job)
  const base: StageProgress = { jobId: job.id, rowIndex: job.row_index, title: job.title, status: '' }

  // 1) CREATE (nếu chưa có product_id)
  let productId = job.product_id
  if (!productId) {
    queueStore.markStageA(job.id, { stage_a: 'creating' })
    emit({ ...base, status: 'creating', message: 'Đang tạo sản phẩm...' })
    // Bảo đảm spec_group: tự tạo trên site nếu chưa có (khi bật autoCreateSpecGroup) → resolveSpecGroup
    // bên trong buildCreateForm sẽ thấy id vừa tạo (đã cache vào map sống).
    await resolver.ensureSpecGroupId(draft.specGroupText, configStore.get().autoCreateSpecGroup)
    const { _id } = await client.createProduct(buildCreateForm(draft, resolver))
    productId = _id
    queueStore.markStageA(job.id, { stage_a: 'created', product_id: productId })
    emit({ ...base, status: 'created', message: `Đã tạo SP ${productId}` })

    // 1b) PUT taxonomy brand/series/madein (resolve-or-create idempotent server-side)
    const tax = resolver.buildNewTaxPayload(draft)
    const putBody: Record<string, unknown> = { ...tax.formPatch }
    // create (POST) luôn ghi đè meta_slug theo title; đặt lại slug mong muốn (từ cột Link) qua PUT.
    if (draft.metaSlug) putBody.meta_slug = draft.metaSlug
    const extra: Record<string, unknown> = {}
    if (tax.new_brand) extra.new_brand = tax.new_brand
    if (tax.new_series) extra.new_series = tax.new_series
    if (tax.new_madein) extra.new_madein = tax.new_madein
    if (Object.keys(putBody).length || Object.keys(extra).length) {
      await client.updateProduct(productId, putBody, extra)
    }
  }

  // 2) UPLOAD ảnh qua Media Manager (checkpoint từng ảnh), rồi GẮN vào product.images.
  const total = draft.imageFiles.length
  if (total > 0) {
    const imgCfg = configStore.get().imageProcess
    queueStore.markStageA(job.id, { stage_a: 'images', images_total: total })
    for (let i = job.images_done; i < total; i++) {
      if (ctrl.cancelled) return
      emit({ ...base, status: 'images', message: `Ảnh ${i + 1}/${total}` })
      // Xử lý ảnh (resize vuông + nén webp) trước khi upload. Lỗi xử lý → fallback ảnh gốc.
      const src = draft.imageFiles[i]
      let payload: string | { buffer: Buffer; filename: string } = src
      if (imgCfg.enabled) {
        try {
          payload = await processImage(src, imgCfg)
        } catch (e) {
          payload = src
          emit({ ...base, status: 'images', message: `Ảnh ${i + 1}/${total}: xử lý lỗi (${(e as Error).message.slice(0, 60)}), dùng ảnh gốc` })
        }
      }
      await client.uploadProductImage(productId, payload)
      queueStore.markStageA(job.id, { images_done: i + 1 })
    }

    // 2b) Gắn ảnh vào product: đọc media thật trên server (chuẩn hoá path, đúng thứ tự), set
    // images[] + featured_image=ảnh đầu. Lấy từ server-truth nên idempotent + resume an toàn.
    const images = await client.listProductImages(productId)
    if (images.length) {
      await client.updateProduct(productId, { images, featured_image: images[0] }, {})
      if (images.length < total) {
        emit({ ...base, status: 'images', message: `Cảnh báo: chỉ gắn ${images.length}/${total} ảnh (một số ảnh upload lỗi)` })
      }
    }
  }

  queueStore.markStageA(job.id, { stage_a: 'done' })
  emit({ ...base, status: 'done', message: 'Hoàn tất khung SP' })
}

// Controller của run Pha A đang chạy (1 run/lần). Lưu kèm runId để cancel đúng run.
let activeStageA: { runId: string; ctrl: RunController } | null = null

/** Hủy Pha A. Nếu truyền runId, chỉ hủy khi đúng run đang chạy (tránh hủy nhầm). */
export function cancelStageA(runId?: string): void {
  if (!activeStageA) return
  if (runId && activeStageA.runId !== runId) return
  activeStageA.ctrl.cancelled = true
}

/** Chạy Pha A cho toàn bộ job pending của run. Tuần tự để dễ resume + tránh quá tải. */
export async function runStageA(
  runId: string,
  siteId: string,
  emit: (p: StageProgress) => void
): Promise<void> {
  const site = configStore.getSite(siteId)
  if (!site) throw new Error(`Không tìm thấy site "${siteId}"`)
  const client = new SiteClient(site)
  const resolver = new TaxonomyResolver(client, siteId)
  await client.ensureCsrf()
  // Auto-map cate/spec_group theo slug từ /admin/taxonomies (best-effort, cần tài khoản admin).
  await resolver.loadLiveMaps()

  const ctrl: RunController = { cancelled: false }
  activeStageA = { runId, ctrl }

  try {
    let job = queueStore.nextStageA(runId)
    while (job && !ctrl.cancelled) {
      try {
        await processJob(job, client, resolver, ctrl, emit)
      } catch (e) {
        const msg = (e as Error).message
        queueStore.markStageA(job.id, { stage_a: 'error', last_error: msg, attempts: job.attempts + 1 })
        emit({ jobId: job.id, rowIndex: job.row_index, title: job.title, status: 'error', message: msg })
      }
      job = queueStore.nextStageA(runId)
    }
  } finally {
    activeStageA = null
  }
}
