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
  | 'filterSpec'

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
  specInstruction: { labels: ['thong so ky thuat'], col: 15 },
  filterSpec: { labels: ['thuoc tinh loc', 'bo loc'], col: 16 }
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

// ------------------------------------------------------- thuộc tính lọc (filters)

/** 1 cặp thuộc tính lọc đọc từ Excel: tên thuộc tính + các giá trị được chọn (dạng text). */
export interface FilterPair {
  name: string
  values: string[]
}

/**
 * Khoá so khớp "lỏng" cho tên thuộc tính/giá trị: bỏ dấu, lowercase, bỏ mọi ký tự không
 * phải chữ/số. Nhờ vậy "220 VAC" ≡ "220VAC", "Điện áp cuộn Coil" ≡ "dien ap cuon coil".
 */
export function filterKey(s: unknown): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Parse ô "Thuộc tính lọc" → danh sách cặp {tên, giá trị[]}.
 * Cú pháp: `Tên thuộc tính: gt1, gt2; Tên khác: gt3`
 *   - Ngăn giữa các thuộc tính: `;` hoặc xuống dòng (`|` cũng chấp nhận).
 *   - Ngăn tên ↔ giá trị: `:` hoặc `=` (dấu ĐẦU TIÊN — giá trị vẫn được chứa ':' phía sau).
 *   - Ngăn nhiều giá trị của cùng thuộc tính: `,` hoặc `/`.
 * Đoạn không có dấu `:`/`=` bị bỏ qua (coi như ghi chú).
 */
export function parseFilterSpec(raw: unknown): FilterPair[] {
  const s = String(raw ?? '').trim()
  if (!s) return []
  const out: FilterPair[] = []
  for (const chunk of s.split(/[;\n|]+/)) {
    const part = chunk.trim()
    if (!part) continue
    const m = part.match(/^([^:=]+)[:=]([\s\S]*)$/)
    if (!m) continue
    const name = m[1].trim()
    const values = m[2]
      .split(/[,/]/)
      .map((v) => v.trim())
      .filter(Boolean)
    if (!name || values.length === 0) continue
    // cùng tên xuất hiện nhiều lần → gộp giá trị
    const existing = out.find((p) => filterKey(p.name) === filterKey(name))
    if (existing) existing.values.push(...values)
    else out.push({ name, values })
  }
  return out
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
