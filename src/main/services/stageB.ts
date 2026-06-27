// ============================================================================
// Pha B — Enrich nội dung AI + upsert (durable, resumable).
//
// State machine:
//   pending → generating → content(detail+attributes) → enriched(PUT) → done
// Sinh đủ nội dung là tự upsert luôn (không còn cổng duyệt tay).
//
// Tuần tự (Bridge 1 job/lần), throttle né rate-limit, retry backoff, resume qua queue.
// ============================================================================

import type { JobRow, Attribute } from '@shared/types'
import { queueStore } from './queueStore'
import { SiteClient } from './siteClient'
import { configStore } from './config'
import { embeddedBridge } from '../bridge/embeddedBridge'
import { buildDetailPrompt, buildSpecPrompt, buildDetailImagePrompt, buildSeoPrompt } from '@shared/prompts'
import {
  parseAttributes,
  parseSeo,
  validateDetail,
  sanitizeDetail,
  extractImagePlaceholders,
  replaceImagePlaceholder
} from './contentValidator'
import type { StageProgress, RunController } from './stageA'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Tách buffer + đuôi file từ data URL base64 (data:image/png;base64,....). */
function decodeDataUrl(dataUrl: string): { buffer: Buffer; ext: string } {
  const comma = dataUrl.indexOf(',')
  const meta = comma >= 0 ? dataUrl.slice(0, comma) : ''
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const m = meta.match(/image\/(\w+)/)
  const ext = m ? (m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()) : 'png'
  return { buffer: Buffer.from(b64, 'base64'), ext }
}

/** Escape giá trị thuộc tính HTML (cho alt="..."). */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

let activeStageB: { runId: string; ctrl: RunController } | null = null

/** Hủy Pha B. Nếu truyền runId, chỉ hủy khi đúng run đang chạy. */
export function cancelStageB(runId?: string): void {
  if (!activeStageB) return
  if (runId && activeStageB.runId !== runId) return
  activeStageB.ctrl.cancelled = true
}

/** Sinh detail + attributes cho 1 job (nếu chưa có content). */
async function generateContent(
  job: JobRow,
  client: SiteClient,
  emit: (p: StageProgress) => void
): Promise<void> {
  const draft = queueStore.getDraft(job)
  const base: StageProgress = { jobId: job.id, rowIndex: job.row_index, title: job.title, status: '' }

  // đã có content (resume) → bỏ qua sinh lại
  if (job.detail && job.attributes_json) return

  // Thông tin site để CTA "nơi mua hàng" trỏ đúng về web mình (tên + URL).
  const cfg = configStore.get()
  const site = configStore.getSite(job.site_id)
  const sitePromptInfo = { name: site?.label, url: site?.baseUrl }
  // Tắt cấu hình tạo ảnh → không truyền yêu cầu ảnh → prompt không chèn placeholder, Pha B không vẽ ảnh.
  const imageRequests = cfg.detailImageEnabled === false ? [] : cfg.detailImageRequests || []

  const health = embeddedBridge.health()
  if (!health.extensionConnected) {
    throw new Error('Extension chưa kết nối — bật addon + mở tab ChatGPT đã đăng nhập.')
  }

  queueStore.markStageB(job.id, { stage_b: 'generating' })
  emit({ ...base, status: 'generating', message: 'Đang sinh mô tả (AI)...' })

  // 1) detail (HTML) — conversation mới
  const detailRes = await embeddedBridge.ask(buildDetailPrompt(draft, sitePromptInfo, imageRequests), {
    newChat: true,
    extract: { type: 'code', lang: 'html' }
  })
  let detail = detailRes.answer
  if (!detail || !validateDetail(detail).ok) {
    // fallback: dùng rawAnswer nếu extract rỗng nhưng có nội dung
    if (detailRes.rawAnswer && validateDetail(detailRes.rawAnswer).ok) detail = detailRes.rawAnswer
  }
  // Gate: KHÔNG cho qua 'content' với detail rỗng/quá ngắn — nếu không job sẽ kẹt vĩnh viễn
  // ở 'content' (nextStageBGenerate chỉ chọn pending/generating) và đăng nội dung rỗng.
  // Ném lỗi để withRetry thử lại; quá số lần thì chuyển 'error' (thấy được, không im lặng).
  if (!validateDetail(detail).ok) {
    throw new Error(`AI trả mô tả rỗng/quá ngắn${detailRes.extractWarning ? ` (${detailRes.extractWarning})` : ''}`)
  }
  // Bỏ mọi <img> AI tự chèn (URL bịa → ảnh vỡ); chỉ giữ phần chữ.
  detail = sanitizeDetail(detail)
  const conversationId = detailRes.conversationId

  // 2) attributes (JSON) — cùng conversation
  emit({ ...base, status: 'generating', message: 'Đang sinh thông số (AI)...' })
  const specRes = await embeddedBridge.ask(buildSpecPrompt(draft), {
    conversationId: conversationId || undefined,
    extract: { type: 'code', lang: 'json' }
  })
  const { attributes, warning } = parseAttributes(specRes.answer, specRes.rawAnswer)

  // 3) ảnh sơ đồ (mỗi placeholder = 1 ảnh): tách mô tả → nhờ AI vẽ → tải về → up lên server → chèn URL.
  //    Best-effort: ảnh lỗi thì gỡ placeholder đó (không chặn upsert), gộp cảnh báo vào last_error.
  //    Xử lý tuần tự theo thứ tự xuất hiện; replaceImagePlaceholder luôn thay placeholder ĐẦU còn lại
  //    → khớp đúng mô tả đang xử lý (cái đã chèn <img> không còn match nữa).
  const imgDescs = extractImagePlaceholders(detail)
  const imgWarnings: string[] = []
  for (let i = 0; i < imgDescs.length; i++) {
    const imgDesc = imgDescs[i]
    if (!job.product_id) {
      // thiếu product_id (bất thường) → gỡ token để không đăng thô
      detail = replaceImagePlaceholder(detail, '')
      continue
    }
    emit({ ...base, status: 'generating', message: `Đang tạo ảnh ${i + 1}/${imgDescs.length} (AI)...` })
    try {
      const imgRes = await embeddedBridge.ask(buildDetailImagePrompt(draft, imgDesc), {
        conversationId: conversationId || undefined,
        image: true,
        timeoutMs: 220_000
      })
      const dataUrl = (imgRes.images || []).find((u) => !!u)
      if (!dataUrl) throw new Error('AI không trả ảnh')
      const { buffer, ext } = decodeDataUrl(dataUrl)
      const url = await client.uploadDetailImage(
        job.product_id,
        buffer,
        `so-do-${job.row_index}-${i + 1}.${ext}`
      )
      detail = replaceImagePlaceholder(detail, `<img src="${url}" alt="${escapeAttr(imgDesc)}">`)
      emit({ ...base, status: 'content', message: `Đã chèn ảnh ${i + 1}/${imgDescs.length}` })
    } catch (e) {
      const w = `Ảnh ${i + 1} lỗi: ${(e as Error).message}`
      imgWarnings.push(w)
      detail = replaceImagePlaceholder(detail, '') // gỡ placeholder để không lộ token thô
      emit({ ...base, status: 'content', message: w })
    }
  }
  const imgWarning = imgWarnings.length ? imgWarnings.join('; ') : null
  detail = sanitizeDetail(detail) // chốt: giữ <img> nội bộ, dọn <p> rỗng nếu đã gỡ placeholder

  // 4) SEO: Title SEO + Meta description + tags (cùng conversation → AI bám ngữ cảnh bài vừa viết).
  //    Best-effort: lỗi/parse fail thì bỏ qua (SEO rỗng → web giữ meta_title auto theo title), không chặn upsert.
  emit({ ...base, status: 'generating', message: 'Đang sinh SEO (AI)...' })
  let seoJson: string | null = null
  let seoWarning: string | null = null
  try {
    const seoRes = await embeddedBridge.ask(buildSeoPrompt(draft), {
      conversationId: conversationId || undefined,
      extract: { type: 'code', lang: 'json' }
    })
    const seo = parseSeo(seoRes.answer, seoRes.rawAnswer)
    seoWarning = seo.warning
    if (seo.meta_title || seo.meta_desc || seo.tags.length) {
      seoJson = JSON.stringify({ meta_title: seo.meta_title, meta_desc: seo.meta_desc, tags: seo.tags })
    }
  } catch (e) {
    seoWarning = `SEO lỗi: ${(e as Error).message}`
    emit({ ...base, status: 'content', message: seoWarning })
  }

  queueStore.markStageB(job.id, {
    stage_b: 'content',
    detail,
    attributes_json: JSON.stringify(attributes),
    seo_json: seoJson,
    conversation_id: conversationId,
    last_error: [imgWarning, warning, seoWarning].filter(Boolean).join('; ') || null
  })
  emit({ ...base, status: 'content', message: `Có nội dung (${attributes.length} thông số)` })
}

/** Upsert detail + attributes vào SP đã tạo ở Pha A. */
async function upsertContent(job: JobRow, client: SiteClient, emit: (p: StageProgress) => void): Promise<void> {
  const base: StageProgress = { jobId: job.id, rowIndex: job.row_index, title: job.title, status: '' }
  if (!job.product_id) throw new Error('Thiếu product_id (Pha A chưa xong)')

  const detail = sanitizeDetail(job.detail || '') // dọn lại <img> kể cả content sinh từ trước
  const attributes: Attribute[] = job.attributes_json ? JSON.parse(job.attributes_json) : []

  // chỉ gửi field bổ sung để không đụng field Pha A đã set
  const form: Record<string, unknown> = { detail, attributes }
  const extra: Record<string, unknown> = {}
  if (job.seo_json) {
    try {
      const seo = JSON.parse(job.seo_json) as { meta_title?: string; meta_desc?: string; tags?: string[] }
      if (seo.meta_title) form.meta_title = seo.meta_title
      if (seo.meta_desc) form.meta_desc = seo.meta_desc
      const tags = (seo.tags || []).map((t) => String(t).trim()).filter(Boolean)
      if (tags.length) {
        // tag là taxonomy: gửi tempId trong form.tag + new_tag (controller resolve-or-create theo meta_slug).
        form.tag = tags.map((_, i) => `tmp_tag_${job.row_index}_${i}`)
        extra.new_tag = tags.map((t, i) => ({
          id: `tmp_tag_${job.row_index}_${i}`,
          text: t,
          tax_type: 'tag',
          tax_for: 'product'
        }))
      }
    } catch {
      /* seo_json hỏng → bỏ qua, vẫn upsert detail/attributes */
    }
  }

  emit({ ...base, status: 'enriched', message: 'Đang cập nhật nội dung...' })
  await client.updateProduct(job.product_id, form, extra)
  queueStore.markStageB(job.id, { stage_b: 'done' })
  emit({ ...base, status: 'done', message: 'Đã enrich xong' })
}

/** Chạy Pha B cho run: pass 1 sinh content (tất cả), pass 2 tự upsert.
 *  Tuần tự + throttle + retry. Resume an toàn qua queue. */
export async function runStageB(runId: string, siteId: string, emit: (p: StageProgress) => void): Promise<void> {
  const cfg = configStore.get()
  const site = configStore.getSite(siteId)
  if (!site) throw new Error(`Không tìm thấy site "${siteId}"`)
  const client = new SiteClient(site)
  await client.ensureCsrf()

  const ctrl: RunController = { cancelled: false }
  activeStageB = { runId, ctrl }
  const throttle = cfg.throttleMs ?? 1500

  const withRetry = async (job: JobRow, fn: () => Promise<void>): Promise<boolean> => {
    try {
      await fn()
      return true
    } catch (e) {
      const msg = (e as Error).message
      const attempts = job.attempts + 1
      if (attempts <= 3 && !ctrl.cancelled) {
        queueStore.markStageB(job.id, { attempts, last_error: msg })
        await sleep(Math.min(10_000, 2000 * attempts))
        return false // sẽ được nextStage* trả lại để thử tiếp
      }
      queueStore.markStageB(job.id, { stage_b: 'error', last_error: msg, attempts })
      emit({ jobId: job.id, rowIndex: job.row_index, title: job.title, status: 'error', message: msg })
      return true // coi như "đã xử lý" (error), khỏi lặp vô hạn
    }
  }

  try {
    // 1 pha xen kẽ: mỗi sản phẩm sinh content (nếu chưa có) rồi UPSERT đăng luôn.
    // → tiến trình tăng theo từng SP (không đứng 0% suốt lúc sinh content cả lô),
    //   và SP lên web ngay; nếu dừng giữa chừng thì các SP đã xử lý đã đăng xong.
    let job = queueStore.nextStageB(runId)
    while (job && !ctrl.cancelled) {
      const done = await withRetry(job, async () => {
        await generateContent(job!, client, emit) // idempotent: có content rồi thì bỏ qua sinh lại
        const fresh = queueStore.getJob(job!.id)
        if (fresh) await upsertContent(fresh, client, emit)
      })
      if (!done) {
        // retry transient → reload và thử lại đúng job này (generate sẽ tự bỏ qua)
        job = queueStore.getJob(job.id)
        continue
      }
      await sleep(throttle)
      job = queueStore.nextStageB(runId)
    }
  } finally {
    activeStageB = null
  }
}
