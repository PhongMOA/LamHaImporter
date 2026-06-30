// contentValidator — validate/parse output AI (attributes JSON, detail HTML).

import type { Attribute } from '@shared/types'

export interface ParsedSpecs {
  attributes: Attribute[]
  warning: string | null
}

/** Dọn text TRƯỚC khi JSON.parse: gỡ marker citation ChatGPT (chứa [ ] { } phá JSON)
 *  + bỏ dấu phẩy thừa (trailing comma) GPT hay sót. KHÔNG đụng gạch ngang/khoảng trắng trong value. */
function cleanJsonForParse(s: string): string {
  if (!s) return ''
  return s
    .replace(/:contentReference\[oaicite:\d+\]\{index=\d+\}/gi, '')
    .replace(/\[oaicite:\d+\]/gi, '')
    .replace(/\{index=\d+\}/gi, '')
    .replace(/[\uE200-\uE2FF]/g, '') // ký tự Private-Use ChatGPT bọc citation
    .replace(/【[^】]*†[^】]*】/g, '') // citation dạng 【..†..】
    .replace(/,\s*([\]}])/g, '$1') // dấu phẩy thừa trước ] hoặc }
}

/** Parse JSON attributes từ answer (đã extract) hoặc rawAnswer fallback. */
export function parseAttributes(answer: string, rawAnswer: string): ParsedSpecs {
  const r = cleanJsonForParse(rawAnswer)
  const candidates = [cleanJsonForParse(answer), extractJsonLoose(r)]
  for (const c of candidates) {
    if (!c) continue
    try {
      const arr = JSON.parse(c)
      const attributes = normalizeAttributes(arr)
      if (attributes.length > 0) {
        return { attributes, warning: attributes.length < 5 ? 'Ít hơn 5 dòng thông số' : null }
      }
    } catch {
      /* thử candidate kế */
    }
  }
  return { attributes: [], warning: 'Không parse được JSON thông số' }
}

function normalizeAttributes(arr: unknown): Attribute[] {
  if (!Array.isArray(arr)) return []
  const out: Attribute[] = []
  for (const it of arr) {
    if (it && typeof it === 'object') {
      const title = String((it as Record<string, unknown>).title ?? '').trim()
      const value = String((it as Record<string, unknown>).value ?? '').trim()
      if (title && value) out.push({ title, value })
    }
  }
  return out
}

/** Tìm mảng JSON đầu tiên trong text (fallback khi extract không ra code block). */
function extractJsonLoose(text: string): string | null {
  if (!text) return null
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return null
}

export interface ParsedSeo {
  meta_title: string
  meta_desc: string
  tags: string[]
  warning: string | null
}

/** Parse JSON SEO {meta_title, meta_desc, tags[]} từ answer (đã extract) hoặc rawAnswer fallback. */
export function parseSeo(answer: string, rawAnswer: string): ParsedSeo {
  const a = cleanJsonForParse(answer)
  const r = cleanJsonForParse(rawAnswer)
  const candidates = [a, extractJsonObjectLoose(a), extractJsonObjectLoose(r)]
  for (const c of candidates) {
    if (!c) continue
    try {
      const obj = JSON.parse(c) as Record<string, unknown>
      const meta_title = stripCitations(String(obj.meta_title ?? '').trim())
      const meta_desc = stripCitations(String(obj.meta_desc ?? '').trim())
      const tags = normalizeTags(obj.tags)
      if (meta_title || meta_desc || tags.length) {
        return { meta_title, meta_desc, tags, warning: null }
      }
    } catch {
      /* thử candidate kế */
    }
  }
  return { meta_title: '', meta_desc: '', tags: [], warning: 'Không parse được JSON SEO' }
}

/** Chuẩn hoá tags: ép string, trim, gỡ citation, bỏ rỗng, khử trùng (không phân biệt hoa/thường). */
function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw) {
    const s = stripCitations(String(t ?? '').trim()).trim()
    const key = s.toLowerCase()
    if (s && !seen.has(key)) {
      seen.add(key)
      out.push(s)
    }
  }
  return out
}

/** Tìm object JSON đầu tiên trong text (fallback khi extract không ra code block). */
function extractJsonObjectLoose(text: string): string | null {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) return text.slice(start, end + 1)
  return null
}

/**
 * Gỡ marker trích dẫn nội bộ của ChatGPT lọt vào text khi lấy thô qua bridge.
 * Trên web các marker này render thành icon nguồn bấm được; text thô thì trơ cú pháp:
 *   - ":contentReference[oaicite:0]{index=0}"  (citation chuẩn)
 *   - "[oaicite:0]" / "{index=0}" lẻ (phòng khi đứt đôi)
 *   - "[12†nguon]" dạng turn-citation dùng ngoặc góc đặc biệt (U+3010 ... U+3011, dấu U+2020)
 *   - ký tự Private-Use (U+E200..U+E2FF) mà UI dùng bọc citation
 * Gộp luôn khoảng trắng thừa đứng trước marker để không để lại "  ." cuối câu.
 */
export function stripCitations(text: string): string {
  if (!text) return text
  return text
    .replace(/[ \t]*:contentReference\[oaicite:\d+\]\{index=\d+\}/gi, '')
    .replace(/[ \t]*\[oaicite:\d+\]/gi, '')
    .replace(/\{index=\d+\}/gi, '')
    .replace(/[ \t]*【[^】]*†[^】]*】/g, '')
    .replace(/[\uE200-\uE2FF]/g, '') // ký tự Private-Use ChatGPT bọc citation
    .replace(/[ \t]+([.,;:!?)])/g, '$1') // dọn khoảng trắng lẻ trước dấu câu sau khi gỡ
}

/** Token placeholder ảnh do AI chèn trong detail: `[[IMAGE: mô tả sơ đồ...]]`. */
const IMG_PLACEHOLDER = /\[\[IMAGE:\s*([\s\S]*?)\]\]/i
const IMG_PLACEHOLDER_G = /\[\[IMAGE:\s*([\s\S]*?)\]\]/gi

/** Tách mô tả của TẤT CẢ placeholder ảnh trong bài, theo thứ tự xuất hiện (mảng rỗng nếu không có). */
export function extractImagePlaceholders(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(IMG_PLACEHOLDER_G)) out.push((m[1] || '').trim())
  return out
}

/** Thay placeholder ảnh ĐẦU TIÊN còn lại bằng `replacement` (thẻ <img> có URL server, hoặc '' để gỡ).
 *  Xử lý tuần tự (replace từng cái) giữ đúng thứ tự khớp với extractImagePlaceholders. */
export function replaceImagePlaceholder(html: string, replacement: string): string {
  return html.replace(IMG_PLACEHOLDER, replacement)
}

/** Gỡ vỏ markdown lẫn trong HTML khi GPT bọc bài bằng code fence (```html ... ```) hoặc
 *  in nhãn ngôn ngữ "HTML" trơ ở đầu — nếu không gỡ, chữ "HTML"/dấu ``` lọt vào bài đăng.
 *  - Xoá MỌI dòng chỉ chứa fence markdown (```lang / ``` / ~~~ ...), kể cả fence mở lẫn đóng.
 *  - Xoá nhãn ngôn ngữ trơ "HTML"/"html" nếu đứng RIÊNG 1 dòng ở ĐẦU (trước thẻ HTML đầu tiên). */
export function unwrapCodeFence(html: string): string {
  if (typeof html !== 'string' || !html) return html || ''
  return html
    .replace(/^[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*\n?/gim, '') // dòng fence markdown bất kỳ
    .replace(/^\s*html\s*(\r?\n|$)/i, '') // nhãn "HTML" trơ đầu bài (detail luôn mở đầu bằng thẻ)
    .trimStart()
}

/** Làm sạch detail HTML trước khi đăng:
 *  - Gỡ vỏ markdown (code fence ```html```, nhãn "HTML" trơ) GPT hay bọc quanh bài.
 *  - Gỡ marker trích dẫn ChatGPT (:contentReference[oaicite...], 【…†…】, ký tự PUA).
 *  - Bỏ <img> có src TUYỆT ĐỐI (http/https/data/protocol-relative) — AI hay bịa URL ngoài → ảnh vỡ.
 *  - GIỮ <img> src NỘI BỘ (bắt đầu '/...') vì đó là ảnh sơ đồ ta tự tải về & upload lên server.
 *  - Bỏ vỏ <figure>/<picture> rỗng và các <p></p> rỗng (ví dụ sau khi gỡ placeholder). */
export function sanitizeDetail(html: string): string {
  return stripCitations(unwrapCodeFence(html))
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const m = tag.match(/\bsrc\s*=\s*["']([^"']*)["']/i)
      const src = (m ? m[1] : '').trim()
      const isInternal = /^\/(?!\/)/.test(src) // '/...' nhưng không phải '//host'
      return isInternal ? tag : ''
    })
    .replace(/<\/?(figure|picture)\b[^>]*>/gi, '') // vỏ figure/picture rỗng còn lại
    .replace(/<p>\s*<\/p>/gi, '') // đoạn rỗng sau khi gỡ placeholder/img
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

/** Kiểm tra detail HTML có nội dung tối thiểu. */
export function validateDetail(html: string): { ok: boolean; warning: string | null } {
  const text = html.replace(/<[^>]+>/g, '').trim()
  if (text.length < 50) return { ok: false, warning: 'Mô tả quá ngắn (<50 ký tự)' }
  return { ok: true, warning: null }
}
