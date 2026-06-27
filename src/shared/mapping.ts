// ============================================================================
// mapping.ts — hằng số map header Excel → field + helper transform.
// Dùng chung main + test. DRY.
// ============================================================================

/** Khoá field nội bộ cho từng cột. */
export type ColKey =
  | 'title'
  | 'detailInstruction'
  | 'refLink'
  | 'imageSlug'
  | 'cate'
  | 'series'
  | 'specGroup'
  | 'warranty'
  | 'brand'
  | 'madein'
  | 'model'
  | 'manual'
  | 'status'
  | 'price'
  | 'alsoBuy'
  | 'specInstruction'

/** Header Excel (chuẩn hoá lowercase, bỏ dấu) → ColKey. Vị trí cột là fallback. */
export const HEADER_MAP: Record<ColKey, { labels: string[]; col: number }> = {
  title: { labels: ['ten san pham'], col: 0 },
  detailInstruction: { labels: ['chi tiet san pham'], col: 1 },
  refLink: { labels: ['link'], col: 2 },
  imageSlug: { labels: ['hinh anh'], col: 3 },
  cate: { labels: ['danh muc'], col: 4 },
  series: { labels: ['series'], col: 5 },
  specGroup: { labels: ['ma hang'], col: 6 },
  warranty: { labels: ['bao hanh'], col: 7 },
  brand: { labels: ['thuong hieu'], col: 8 },
  madein: { labels: ['xuat xu'], col: 9 },
  model: { labels: ['model'], col: 10 },
  manual: { labels: ['tai lieu ky thuat'], col: 11 },
  status: { labels: ['tinh trang'], col: 12 },
  price: { labels: ['gia san pham', 'gia'], col: 13 },
  alsoBuy: { labels: ['san pham mua cung'], col: 14 },
  specInstruction: { labels: ['thong so ky thuat'], col: 15 }
}

/** Bỏ dấu tiếng Việt + lowercase + trim để so khớp header. */
export function normalizeHeader(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Định vị cột theo header (ưu tiên), fallback vị trí cứng. */
export function buildColIndex(headerRow: unknown[]): Record<ColKey, number> {
  const normalized = headerRow.map(normalizeHeader)
  const out = {} as Record<ColKey, number>
  for (const key of Object.keys(HEADER_MAP) as ColKey[]) {
    const { labels, col } = HEADER_MAP[key]
    let idx = normalized.findIndex((h) => labels.some((l) => h === l || h.includes(l)))
    if (idx < 0) idx = col
    out[key] = idx
  }
  return out
}

// ----------------------------------------------------------------- transforms

/** "12 Tháng" → 12. */
export function parseWarranty(raw: unknown): number {
  const m = String(raw ?? '').match(/(\d+)/)
  return m ? Number(m[1]) : 0
}

/** "3.745.000" / "3,745,000" / 3745000 → 3745000. */
export function parsePrice(raw: unknown): number {
  if (typeof raw === 'number') return raw
  const digits = String(raw ?? '').replace(/[^\d]/g, '')
  return digits ? Number(digits) : 0
}

/** Tách slug cuối từ URL taxonomy: .../thuong-hieu/eaton-moeller/ → eaton-moeller. */
export function slugFromUrl(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    const parts = u.pathname.split('/').filter(Boolean)
    return parts.length ? parts[parts.length - 1] : ''
  } catch {
    // không phải URL → coi như đã là slug/text
    return s.split('/').filter(Boolean).pop() || s
  }
}

/** Split danh sách link "a, b , c" → ['a','b','c']. */
export function splitLinks(raw: unknown): string[] {
  return String(raw ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Nhận diện ô là ghi chú/hướng dẫn template (AI tự lấy, nếu có sp mua cùng...). */
const NOTE_PATTERNS = [
  /n[eế]u c[oó] sp/i,
  /ai t[uự] l[aấ]y/i,
  /t[uự] l[aấ]y tr[eê]n/i,
  /h[uư][oơ]ng d[aẫ]n/i,
  /\(.*ai.*\)/i
]
export function looksLikeNote(raw: unknown): boolean {
  const s = String(raw ?? '').trim()
  if (!s) return false
  return NOTE_PATTERNS.some((re) => re.test(s))
}
