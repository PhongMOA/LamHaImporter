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

    let blocks = parseCodeBlocks(raw)
    if (lang) blocks = blocks.filter((b) => b.lang === lang)

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
