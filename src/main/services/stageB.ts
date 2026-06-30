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

/** Lỗi nội bộ báo "user đã bấm Dừng" — KHÔNG đánh job 'error', chỉ thoát vòng lặp êm. */
class CancelledError extends Error {
  constructor() {
    super('Đã dừng theo yêu cầu')
    this.name = 'CancelledError'
  }
}

/** Hủy Pha B. Nếu truyền runId, chỉ hủy khi đúng run đang chạy.
 *  CHỜ TASK HIỆN TẠI CHẠY XONG rồi mới dừng: chỉ bật cờ, không cắt ngang job GPT đang bay.
 *  generateContent kiểm tra cờ TRƯỚC mỗi task → task đang chạy hoàn thành + checkpoint, rồi dừng
 *  trước task kế (không phí công, không để trạng thái dở). */
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
 * Mỗi task xong là lưu DB ngay. CUỐI CÙNG nếu CHƯA đủ cả 4 → đánh 'error' NGAY (KHÔNG throw, KHÔNG
 * tự chạy lại) rồi return false. Đủ cả 4 → set 'content', return true để runner upsert.
 * User bấm "chạy lại" (retryErrors) sẽ đưa job error về pending; nhờ checkpoint chỉ làm nốt task thiếu.
 */
async function generateContent(
  job: JobRow,
  client: SiteClient,
  emit: (p: StageProgress) => void,
  isCancelled: () => boolean
): Promise<boolean> {
  const draft = queueStore.getDraft(job)
  const base: StageProgress = { jobId: job.id, rowIndex: job.row_index, title: job.title, status: '' }
  // Chốt hủy: gọi trước mỗi task để thoát ngay khi user bấm Dừng (không khởi động task GPT kế).
  const ckCancel = (): void => {
    if (isCancelled()) throw new CancelledError()
  }

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
  ckCancel()
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
      emit({ ...base, status: 'content', message: '✓ Xong mô tả' })
    }
  }
  const detailOk = !!rawDetail && validateDetail(rawDetail).ok

  // Mô tả là GỐC của cả lượt (4 task chung 1 conversation, tạo bởi newChat của detail).
  // Detail lỗi (rỗng/no-html — thường do extension chốt turn sớm khi GPT đang research) → DỪNG cả SP NGAY,
  // KHÔNG gửi tiếp thông số/ảnh/SEO (tránh chen ngang khi GPT còn đang trả lời mô tả). User "Chạy lại" sau.
  if (!detailOk) {
    const msg = failures.length ? failures.join('; ') : 'Mô tả rỗng/quá ngắn'
    queueStore.markStageB(job.id, { stage_b: 'error', last_error: msg })
    emit({ ...base, status: 'error', message: msg })
    return false
  }

  // ===== Task 2: attributes (JSON) — prompt tự chứa ngữ cảnh, chạy lại lẻ được =====
  ckCancel()
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
        emit({ ...base, status: 'content', message: `✓ Xong thông số (${attributes.length} dòng)` })
      } else {
        const m = parsed.warning || 'Thông số rỗng/không parse được'
        failures.push(m)
        emit({ ...base, status: 'warn', message: `✗ Thông số lỗi: ${m}` })
      }
    } catch (e) {
      const m = (e as Error).message
      failures.push(`Thông số lỗi: ${m}`)
      emit({ ...base, status: 'warn', message: `✗ Thông số lỗi: ${m}` })
    }
  }

  // ===== Task 3: SEO (title + desc + tags) — prompt tự chứa ngữ cảnh =====
  ckCancel()
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
        emit({ ...base, status: 'content', message: `✓ Xong SEO (${seo.tags.length} tags)` })
      } else {
        const m = 'SEO thiếu dữ liệu (cần đủ tiêu đề, mô tả và tags)'
        failures.push(m)
        emit({ ...base, status: 'warn', message: `✗ ${m}` })
      }
    } catch (e) {
      const m = (e as Error).message
      failures.push(`SEO lỗi: ${m}`)
      emit({ ...base, status: 'warn', message: `✗ SEO lỗi: ${m}` })
    }
  }

  // ===== Task 4: ảnh sơ đồ — CHẠY CUỐI; chỉ chạy khi đã có detail; mỗi placeholder = 1 ảnh =====
  // Để cuối vì ảnh là task chậm/dễ timeout nhất: các task text (mô tả/thông số/SEO) đã chốt xong
  // trước → dù ảnh lỗi vẫn giữ được nội dung text đã checkpoint.
  if (detailOk) {
    const descs = extractImagePlaceholders(rawDetail)
    // đồng bộ slot theo placeholder hiện tại, GIỮ url đã có (theo index) để không vẽ lại ảnh đã xong
    images = descs.map((desc, i) => ({ desc, url: images[i]?.url ?? null }))
    for (let i = 0; i < descs.length; i++) {
      ckCancel()
      if (images[i].url) continue // đã có ảnh → bỏ qua
      if (!job.product_id) {
        // Ảnh là BEST-EFFORT → KHÔNG đẩy vào failures (không chặn đăng), chỉ log.
        emit({ ...base, status: 'warn', message: '✗ Thiếu product_id để upload ảnh — bỏ qua ảnh' })
        break
      }
      emit({ ...base, status: 'generating', message: `Đang tạo ảnh ${i + 1}/${descs.length} (AI)...` })
      try {
        const imgRes = await embeddedBridge.ask(buildDetailImagePrompt(draft, descs[i]), {
          conversationId: conversationId || undefined,
          image: true,
          // Trần chờ ảnh = cấu hình (Settings → tạo ảnh), tối thiểu 60s. Giá trị này được truyền
          // xuống extension làm trần render DALL-E; extension gửi heartbeat 5s giữ idle-timer này sống.
          timeoutMs: Math.max(60, cfg.detailImageTimeoutSec || 300) * 1000
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
        emit({ ...base, status: 'content', message: `✓ Xong ảnh ${i + 1}/${descs.length}` })
      } catch (e) {
        // Ảnh là BEST-EFFORT → KHÔNG đẩy vào failures (không chặn đăng); placeholder ảnh này
        // sẽ được upsertContent gỡ bỏ, SP vẫn đăng bình thường. Chỉ log để theo dõi.
        const m = (e as Error).message
        emit({ ...base, status: 'warn', message: `✗ Ảnh ${i + 1}/${descs.length} lỗi: ${m} — bỏ ảnh này, vẫn đăng` })
      }
    }
  }

  // ===== Chốt: chỉ TEXT (mô tả + thông số + SEO) mới ràng buộc; ẢNH là best-effort =====
  // Ảnh nào tạo được thì chèn, ảnh nào fail thì upsertContent gỡ placeholder & đăng bình thường.
  const totalImgs = detailOk ? extractImagePlaceholders(rawDetail).length : 0
  const okImgs = images.filter((s) => !!s?.url).length
  const contentOk = detailOk && attributes.length > 0 && isSeoComplete(seoJson)

  if (contentOk) {
    queueStore.markStageB(job.id, { stage_b: 'content', last_error: null })
    const imgNote = totalImgs ? `, ${okImgs}/${totalImgs} ảnh` : ''
    emit({ ...base, status: 'content', message: `✓ Đủ nội dung (${attributes.length} thông số${imgNote}) — chờ đăng` })
    return true
  }
  // Thiếu task TEXT → đánh 'error' NGAY, KHÔNG upsert, KHÔNG tự chạy lại. Vẫn giữ phần đã checkpoint;
  // user bấm "chạy lại" → retryErrors đưa về pending, lần sau chỉ làm nốt task còn thiếu.
  // (failures chỉ còn lỗi text vì lỗi ảnh không được đẩy vào — ảnh không chặn đăng.)
  const msg = failures.length ? failures.join('; ') : 'Thiếu dữ liệu nội dung'
  queueStore.markStageB(job.id, { stage_b: 'error', last_error: msg })
  emit({ ...base, status: 'error', message: msg })
  return false
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

  try {
    // 1 pha xen kẽ: mỗi sản phẩm sinh content (nếu chưa đủ) rồi UPSERT đăng luôn.
    // → tiến trình tăng theo từng SP; SP lên web ngay; dừng giữa chừng thì SP đã xử lý đã đăng xong.
    // KHÔNG tự retry: thiếu task nào → generateContent đánh 'error' ngay (nextStageB sẽ bỏ qua job
    //   error nên KHÔNG lặp lại job đó). User bấm "chạy lại" mới đưa job error về pending.
    let job = queueStore.nextStageB(runId)
    while (job && !ctrl.cancelled) {
      try {
        const ok = await generateContent(job, client, emit, () => ctrl.cancelled) // đủ 4 task → true
        if (ok) {
          const fresh = queueStore.getJob(job.id)
          if (fresh) await upsertContent(fresh, client, emit)
        }
      } catch (e) {
        // User bấm Dừng (CancelledError, hoặc lỗi cứng xảy ra ngay sau khi abort) → KHÔNG đánh 'error':
        // giữ checkpoint, để stage_b='generating' (nextStageB sẽ nhặt lại khi user "Chạy Pha B" tiếp).
        if (e instanceof CancelledError || ctrl.cancelled) {
          emit({ jobId: job.id, rowIndex: job.row_index, title: job.title, status: 'content', message: '⏸ Đã dừng' })
          break
        }
        // lỗi cứng (extension rớt, mạng, upsert lỗi...) → đánh 'error', KHÔNG tự chạy lại.
        const msg = (e as Error).message
        queueStore.markStageB(job.id, { stage_b: 'error', last_error: msg })
        emit({ jobId: job.id, rowIndex: job.row_index, title: job.title, status: 'error', message: msg })
      }
      await sleep(throttle)
      job = queueStore.nextStageB(runId)
    }
  } finally {
    activeStageB = null
  }
}
