// ============================================================================
// Pha B — Enrich nội dung AI + upsert (durable, resumable).
//
// State machine:
//   pending → generating → content(ĐỦ 4 task) → enriched(PUT) → done
// 4 task: detail (HTML thô, giữ placeholder) · attributes (JSON) · ảnh sơ đồ (mỗi placeholder=1 ảnh) · SEO.
// Mỗi task xong là CHECKPOINT vào DB → chạy lại chỉ làm nốt task còn thiếu.
// CHỈ khi đủ cả 4 task mới upsert lên web; thiếu bất kỳ task nào → đánh 'error', KHÔNG đăng.
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
import { processDetailImageBuffer } from './image'

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

/** 1 ảnh sơ đồ ứng với 1 placeholder trong detail thô. url=null → chưa tạo được. */
interface ImageSlot {
  desc: string
  url: string | null
}

function safeParseAttributes(json: string | null): Attribute[] {
  if (!json) return []
  try {
    const a = JSON.parse(json)
    return Array.isArray(a) ? (a as Attribute[]) : []
  } catch {
    return []
  }
}

function safeParseImages(json: string | null): ImageSlot[] {
  if (!json) return []
  try {
    const a = JSON.parse(json)
    return Array.isArray(a) ? (a as ImageSlot[]) : []
  } catch {
    return []
  }
}

/** SEO "đủ dữ liệu" = có cả meta_title, meta_desc và ít nhất 1 tag. */
function isSeoComplete(seoJson: string | null): boolean {
  if (!seoJson) return false
  try {
    const s = JSON.parse(seoJson) as { meta_title?: string; meta_desc?: string; tags?: unknown }
    return !!(s.meta_title && s.meta_desc && Array.isArray(s.tags) && s.tags.length > 0)
  } catch {
    return false
  }
}

/**
 * Sinh nội dung 4 task cho 1 job, CHECKPOINT từng task → chạy lại chỉ task còn thiếu.
 * Task: 1) detail (HTML thô, giữ placeholder)  2) attributes (JSON)
 *       3) ảnh sơ đồ (mỗi placeholder = 1 ảnh)  4) SEO (title+desc+tags).
 * Mỗi task xong là lưu DB ngay. CUỐI CÙNG nếu CHƯA đủ cả 4 → THROW (để KHÔNG upsert; withRetry
 * thử lại đúng task thiếu, hết lượt thì đánh 'error'). Đủ cả 4 → set 'content' để runner upsert.
 */
async function generateContent(
  job: JobRow,
  client: SiteClient,
  emit: (p: StageProgress) => void
): Promise<void> {
  const draft = queueStore.getDraft(job)
  const base: StageProgress = { jobId: job.id, rowIndex: job.row_index, title: job.title, status: '' }

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

  // ----- nạp checkpoint đã có (để chạy lại chỉ task còn thiếu) -----
  let rawDetail = job.detail || '' // detail THÔ, còn placeholder [[IMAGE: ...]]
  let conversationId = job.conversation_id || null
  let attributes = safeParseAttributes(job.attributes_json)
  let seoJson = job.seo_json
  let images = safeParseImages(job.images_json)
  const failures: string[] = []

  // ===== Task 1: detail (HTML thô) =====
  if (!rawDetail || !validateDetail(rawDetail).ok) {
    emit({ ...base, status: 'generating', message: 'Đang sinh mô tả (AI)...' })
    const detailRes = await embeddedBridge.ask(buildDetailPrompt(draft, sitePromptInfo, imageRequests), {
      newChat: true,
      extract: { type: 'code', lang: 'html' }
    })
    let d = detailRes.answer
    if (!d || !validateDetail(d).ok) {
      if (detailRes.rawAnswer && validateDetail(detailRes.rawAnswer).ok) d = detailRes.rawAnswer
    }
    if (!validateDetail(d).ok) {
      failures.push(`Mô tả rỗng/quá ngắn${detailRes.extractWarning ? ` (${detailRes.extractWarning})` : ''}`)
    } else {
      rawDetail = sanitizeDetail(d) // sanitizeDetail GIỮ placeholder [[IMAGE]], chỉ bỏ <img> bịa
      conversationId = detailRes.conversationId || conversationId
      images = [] // detail mới → placeholder mới → bỏ ảnh cũ, sẽ tạo lại
      queueStore.markStageB(job.id, {
        detail: rawDetail,
        conversation_id: conversationId,
        images_json: JSON.stringify(images)
      })
    }
  }
  const detailOk = !!rawDetail && validateDetail(rawDetail).ok

  // ===== Task 2: attributes (JSON) — prompt tự chứa ngữ cảnh, chạy lại lẻ được =====
  if (attributes.length === 0) {
    emit({ ...base, status: 'generating', message: 'Đang sinh thông số (AI)...' })
    try {
      const specRes = await embeddedBridge.ask(buildSpecPrompt(draft), {
        conversationId: conversationId || undefined,
        extract: { type: 'code', lang: 'json' }
      })
      const parsed = parseAttributes(specRes.answer, specRes.rawAnswer)
      if (parsed.attributes.length > 0) {
        attributes = parsed.attributes
        queueStore.markStageB(job.id, { attributes_json: JSON.stringify(attributes) })
      } else {
        failures.push(parsed.warning || 'Thông số rỗng/không parse được')
      }
    } catch (e) {
      failures.push(`Thông số lỗi: ${(e as Error).message}`)
    }
  }

  // ===== Task 3: ảnh sơ đồ — chỉ chạy khi đã có detail; mỗi placeholder = 1 ảnh =====
  if (detailOk) {
    const descs = extractImagePlaceholders(rawDetail)
    // đồng bộ slot theo placeholder hiện tại, GIỮ url đã có (theo index) để không vẽ lại ảnh đã xong
    images = descs.map((desc, i) => ({ desc, url: images[i]?.url ?? null }))
    for (let i = 0; i < descs.length; i++) {
      if (images[i].url) continue // đã có ảnh → bỏ qua
      if (!job.product_id) {
        failures.push('Thiếu product_id để upload ảnh')
        break
      }
      emit({ ...base, status: 'generating', message: `Đang tạo ảnh ${i + 1}/${descs.length} (AI)...` })
      try {
        const imgRes = await embeddedBridge.ask(buildDetailImagePrompt(draft, descs[i]), {
          conversationId: conversationId || undefined,
          image: true,
          timeoutMs: 220_000
        })
        const dataUrl = (imgRes.images || []).find((u) => !!u)
        if (!dataUrl) throw new Error('AI không trả ảnh')
        const decoded = decodeDataUrl(dataUrl)
        let buffer = decoded.buffer
        let ext = decoded.ext
        if (cfg.imageProcess.enabled) {
          try {
            const opt = await processDetailImageBuffer(decoded.buffer, cfg.imageProcess)
            buffer = opt.buffer
            ext = opt.ext
          } catch {
            /* giữ ảnh gốc */
          }
        }
        const url = await client.uploadDetailImage(
          job.product_id,
          buffer,
          `so-do-${job.row_index}-${i + 1}.${ext}`
        )
        images[i].url = url
        queueStore.markStageB(job.id, { images_json: JSON.stringify(images) }) // checkpoint từng ảnh
        emit({ ...base, status: 'content', message: `Đã tạo ảnh ${i + 1}/${descs.length}` })
      } catch (e) {
        failures.push(`Ảnh ${i + 1} lỗi: ${(e as Error).message}`)
      }
    }
  }

  // ===== Task 4: SEO (title + desc + tags) — prompt tự chứa ngữ cảnh =====
  if (!isSeoComplete(seoJson)) {
    emit({ ...base, status: 'generating', message: 'Đang sinh SEO (AI)...' })
    try {
      const seoRes = await embeddedBridge.ask(buildSeoPrompt(draft), {
        conversationId: conversationId || undefined,
        extract: { type: 'code', lang: 'json' }
      })
      const seo = parseSeo(seoRes.answer, seoRes.rawAnswer)
      if (seo.meta_title && seo.meta_desc && seo.tags.length > 0) {
        seoJson = JSON.stringify({ meta_title: seo.meta_title, meta_desc: seo.meta_desc, tags: seo.tags })
        queueStore.markStageB(job.id, { seo_json: seoJson })
      } else {
        failures.push('SEO thiếu dữ liệu (cần đủ tiêu đề, mô tả và tags)')
      }
    } catch (e) {
      failures.push(`SEO lỗi: ${(e as Error).message}`)
    }
  }

  // ===== Chốt: đủ cả 4 task chưa? =====
  const imagesOk = detailOk && extractImagePlaceholders(rawDetail).every((_, i) => !!images[i]?.url)
  const allOk = detailOk && attributes.length > 0 && imagesOk && isSeoComplete(seoJson)

  if (allOk) {
    queueStore.markStageB(job.id, { stage_b: 'content', last_error: null })
    emit({ ...base, status: 'content', message: `Đủ nội dung (${attributes.length} thông số)` })
    return
  }
  // Chưa đủ → THROW để KHÔNG upsert. withRetry sẽ chạy lại đúng task còn thiếu (đã checkpoint),
  // hết lượt thì đánh 'error' (vẫn giữ phần đã có để "chạy lại" sau chỉ làm nốt phần thiếu).
  const msg = failures.length ? failures.join('; ') : 'Thiếu dữ liệu nội dung'
  queueStore.markStageB(job.id, { last_error: msg })
  throw new Error(msg)
}

/** Upsert detail + attributes vào SP đã tạo ở Pha A. Ghép ảnh (images_json) vào detail thô. */
async function upsertContent(job: JobRow, client: SiteClient, emit: (p: StageProgress) => void): Promise<void> {
  const base: StageProgress = { jobId: job.id, rowIndex: job.row_index, title: job.title, status: '' }
  if (!job.product_id) throw new Error('Thiếu product_id (Pha A chưa xong)')

  // Ghép ảnh đã tạo vào detail thô: thay từng placeholder ĐẦU còn lại bằng <img> tương ứng (đúng thứ tự).
  let detail = job.detail || ''
  for (const slot of safeParseImages(job.images_json)) {
    const tag = slot.url ? `<img src="${slot.url}" alt="${escapeAttr(slot.desc)}">` : ''
    detail = replaceImagePlaceholder(detail, tag)
  }
  detail = sanitizeDetail(detail) // dọn <img> bịa + gỡ placeholder sót (nếu có) qua bước kế
  detail = detail.replace(/<p>\s*\[\[IMAGE:[\s\S]*?\]\]\s*<\/p>/gi, '').replace(/\[\[IMAGE:[\s\S]*?\]\]/gi, '')
  const attributes: Attribute[] = safeParseAttributes(job.attributes_json)

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

/** Chạy Pha B cho run: mỗi SP sinh đủ 4 task (checkpoint từng task) rồi mới upsert.
 *  Thiếu bất kỳ task nào → KHÔNG upsert, đánh 'error'; "chạy lại" chỉ làm nốt task thiếu.
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
