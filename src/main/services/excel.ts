// ExcelService — parse file Excel mẫu → ProductDraft[]. Bỏ note/template rows.

import * as XLSX from 'xlsx'
import type { ProductDraft } from '@shared/types'
import {
  buildColIndex,
  parseWarranty,
  parsePrice,
  slugFromUrl,
  splitLinks,
  looksLikeNote,
  normalizeHeader
} from '@shared/mapping'
import { matchImages } from './image'

export interface ParseOptions {
  imageFolder: string
}

export interface ParseResult {
  drafts: ProductDraft[]
  skipped: number
  total: number
}

function cell(row: unknown[], idx: number): string {
  if (idx < 0) return ''
  const v = row[idx]
  return v === undefined || v === null ? '' : String(v).trim()
}

export function parseExcel(filePath: string, opts: ParseOptions): ParseResult {
  const wb = XLSX.readFile(filePath, { cellDates: false })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false })
  if (rows.length === 0) return { drafts: [], skipped: 0, total: 0 }

  // dòng đầu là header
  const col = buildColIndex(rows[0])
  const drafts: ProductDraft[] = []
  let skipped = 0
  let total = 0

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!row || row.length === 0) continue
    total++

    const title = cell(row, col.title)
    const model = cell(row, col.model)

    // Bỏ note/template rows: thiếu title hoặc model, hoặc cột hướng dẫn ở vị trí dữ liệu chính.
    if (!title || !model) {
      skipped++
      continue
    }

    const imageSlug = slugFromUrl(cell(row, col.imageSlug)) || cell(row, col.imageSlug)
    const detailRaw = cell(row, col.detailInstruction)
    const specRaw = cell(row, col.specInstruction)
    const alsoBuyRaw = cell(row, col.alsoBuy)

    const draft: ProductDraft = {
      rowIndex: r,
      title,
      detailInstruction: looksLikeNote(detailRaw) ? '' : detailRaw,
      specInstruction: looksLikeNote(specRaw) ? '' : specRaw,
      refLink: cell(row, col.refLink),
      metaSlug: cell(row, col.refLink), // cột Link giờ là slug nhập thẳng (không cắt domain/san-pham)
      detail: '',
      desc: '',
      attributes: [],
      price: parsePrice(cell(row, col.price)),
      status_text: cell(row, col.status),
      warranty: parseWarranty(cell(row, col.warranty)),
      model,
      manual: cell(row, col.manual),
      brandSlug: slugFromUrl(cell(row, col.brand)),
      cateSlug: slugFromUrl(cell(row, col.cate)),
      seriesText: cell(row, col.series),
      madeinText: cell(row, col.madein),
      specGroupText: cell(row, col.specGroup),
      imageSlug,
      imageFiles: [],
      alsoBuyLinks: looksLikeNote(alsoBuyRaw) ? [] : splitLinks(alsoBuyRaw),
      errors: []
    }

    // match ảnh local
    if (opts.imageFolder) {
      draft.imageFiles = matchImages(opts.imageFolder, imageSlug)
      if (draft.imageFiles.length === 0) draft.errors.push('Thiếu ảnh trong folder')
    }

    drafts.push(draft)
  }

  return { drafts, skipped, total }
}

/** Đọc nhanh header để debug/validate (không parse hết). */
export function readHeaders(filePath: string): { headers: string[]; normalized: string[] } {
  const wb = XLSX.readFile(filePath)
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, blankrows: false })
  const headers = (rows[0] || []).map((h) => String(h ?? ''))
  return { headers, normalized: headers.map(normalizeHeader) }
}
