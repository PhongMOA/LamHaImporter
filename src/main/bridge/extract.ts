// Port từ Add-On GPT/server/src/extract.ts — trích nội dung từ câu trả lời markdown
// của GPT theo quy tắc `extract`. Giữ nguyên hành vi: type:'code' không thấy block
// → answer='' + warning (KHÔNG fallback về raw).

import type { ExtractRule } from '@shared/types'

export interface CodeBlock {
  lang: string
  content: string
  closed: boolean // false = fence mở nhưng KHÔNG có fence đóng (lấy tới hết chuỗi)
}

/**
 * Tách mọi fenced code block trong markdown (``` hoặc ~~~, fence >= 3).
 *
 * Quét THEO KÝ TỰ chứ không theo dòng: text đọc từ DOM ChatGPT hay dính fence vào cuối
 * câu lời dẫn ("...tránh đưa thông số suy đoán.```html") — parser theo dòng sẽ trượt,
 * khiến cả lời dẫn bị coi là bài viết. Fence mở nằm giữa dòng vẫn phải bắt được.
 *
 * Fence mở KHÔNG có fence đóng (câu trả lời bị cắt) vẫn trả về, với closed=false, để
 * bên gọi tự quyết định — bỏ hẳn thì mất trắng bài đã viết gần xong.
 */
export function parseCodeBlocks(md: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  if (typeof md !== 'string' || !md) return blocks

  // fence mở + nhãn ngôn ngữ (nếu có) + nuốt luôn 1 lần xuống dòng ngay sau nhãn
  const openRe = /(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*\r?\n?/g
  let m: RegExpExecArray | null
  while ((m = openRe.exec(md)) !== null) {
    const fence = m[1]
    const lang = (m[2] || '').trim().toLowerCase()
    const bodyStart = openRe.lastIndex

    // fence đóng: cùng loại ký tự, độ dài >= fence mở, ở BẤT KỲ đâu (kể cả giữa dòng)
    const closeRe = new RegExp(`${fence[0] === '`' ? '`' : '~'}{${fence.length},}`, 'g')
    closeRe.lastIndex = bodyStart
    const close = closeRe.exec(md)

    const bodyEnd = close ? close.index : md.length
    const content = md.slice(bodyStart, bodyEnd).replace(/\r?\n[ \t]*$/, '')
    // block rỗng (``` ``` liền nhau) → bỏ, tránh sinh answer rỗng
    if (content.trim()) blocks.push({ lang, content, closed: !!close })

    openRe.lastIndex = close ? close.index + close[0].length : md.length
  }
  return blocks
}

const HTML_LANGS = ['html', 'xml', 'htm', 'xhtml']
const LANG_ALIASES: Record<string, string[]> = { html: HTML_LANGS, htm: HTML_LANGS, xhtml: HTML_LANGS }

export function applyExtract(
  rawAnswer: string,
  extract: ExtractRule | null | undefined
): { answer: string; warning: string | null } {
  const raw = typeof rawAnswer === 'string' ? rawAnswer : ''
  const type = extract && typeof extract.type === 'string' ? extract.type : 'text'

  if (type === 'text') return { answer: raw, warning: null }

  if (type === 'code') {
    const lang = extract?.lang ? String(extract.lang).toLowerCase() : null
    const select = extract?.select === 'first' || extract?.select === 'last' ? extract.select : 'all'
    const join = typeof extract?.join === 'string' ? extract.join : '\n\n'

    // ChatGPT hay gắn nhãn sai cho khối HTML (đoán "XML" lúc đang render) → coi là cùng loại.
    const same = lang ? LANG_ALIASES[lang] || [lang] : null
    const pick = (md: string): CodeBlock[] => {
      const all = parseCodeBlocks(md)
      return same ? all.filter((b) => same.includes(b.lang)) : all
    }
    let blocks = pick(raw)
    // SSE (10-2026) rơi mất token ĐẦU mỗi message → mất fence MỞ: chuỗi về app dạng
    // "html\n<h2>...</p>\n```" hoặc "...lời dẫn suy đoán.html\n<h2>..." (nhãn dính cuối câu dẫn),
    // chỉ còn fence đóng → parser coi nó là fence mở của khối rỗng. Chèn lại fence trước nhãn lang đầu tiên.
    const fenceCount = (raw.match(/`{3,}|~{3,}/g) || []).length
    if (blocks.length === 0 && same && fenceCount % 2 === 1) {
      const label = new RegExp(`(^|[^A-Za-z0-9_])(${same.join('|')})[ \\t]*\\r?\\n`, 'i').exec(raw)
      if (label) {
        const at = label.index + label[1].length
        blocks = pick(raw.slice(0, at) + '\n```' + raw.slice(at))
      }
    }

    if (blocks.length === 0) {
      const where = lang ? `code block ngôn ngữ "${lang}"` : 'code block'
      return { answer: '', warning: `không tìm thấy ${where} trong câu trả lời` }
    }

    let chosen: CodeBlock[]
    if (select === 'first') chosen = [blocks[0]]
    else if (select === 'last') chosen = [blocks[blocks.length - 1]]
    else chosen = blocks

    return { answer: chosen.map((b) => b.content).join(join), warning: null }
  }

  return { answer: raw, warning: `extract.type không hợp lệ: "${type}"` }
}
