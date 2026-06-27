// Port từ Add-On GPT/server/src/extract.ts — trích nội dung từ câu trả lời markdown
// của GPT theo quy tắc `extract`. Giữ nguyên hành vi: type:'code' không thấy block
// → answer='' + warning (KHÔNG fallback về raw).

import type { ExtractRule } from '@shared/types'

interface CodeBlock {
  lang: string
  content: string
}

/** Tách mọi fenced code block trong markdown (``` hoặc ~~~, fence >= 3). */
export function parseCodeBlocks(md: string): CodeBlock[] {
  const blocks: CodeBlock[] = []
  if (typeof md !== 'string' || !md) return blocks

  const lines = md.split('\n')
  let i = 0
  while (i < lines.length) {
    const open = lines[i].match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/)
    if (!open) {
      i += 1
      continue
    }
    const fenceChar = open[2][0]
    const fenceLen = open[2].length
    const lang = (open[3] || '').trim().split(/\s+/)[0].toLowerCase()

    const body: string[] = []
    let closed = false
    i += 1
    while (i < lines.length) {
      const l = lines[i]
      const close = l.match(/^(\s{0,3})(`{3,}|~{3,})\s*$/)
      if (close && close[2][0] === fenceChar && close[2].length >= fenceLen) {
        closed = true
        i += 1
        break
      }
      body.push(l)
      i += 1
    }
    if (closed) blocks.push({ lang, content: body.join('\n') })
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
