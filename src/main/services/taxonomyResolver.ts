// ============================================================================
// TaxonomyResolver — xử lý taxonomy khi đăng sản phẩm.
//
// QUAN TRỌNG (đã verify trong source lamha):
//   - update controller (PUT /api/products/:id) chỉ auto resolve-or-create
//     taxonomy cho new_* thuộc {tag, series, brand, madein, alt}.
//     ⇒ brand/series/madein: gửi `new_*` để lamha tự tạo idempotent (theo meta_slug).
//   - cate (category) và spec_group KHÔNG nằm trong danh sách đó, và KHÔNG có
//     GET list API ⇒ phải có ObjectId sẵn. Giải pháp: per-site taxMap (config)
//     do user map 1 lần; thiếu thì tạo chủ động qua POST /api/taxonomies + cache.
// ============================================================================

import type { ProductDraft, AppConfig } from '@shared/types'
import { configStore } from './config'
import type { SiteClient, TaxNode } from './siteClient'

/** Payload taxonomy cho PUT: form chứa temp id + mảng new_*. */
export interface TaxPutPayload {
  formPatch: Record<string, unknown> // { series:[tempId], (brand/madein đặt qua new_*) }
  new_brand?: TaxItem[]
  new_series?: TaxItem[]
  new_madein?: TaxItem[]
}

interface TaxItem {
  id?: string
  text: string
  tax_type: string
  tax_for: string
}

/** "eaton-moeller" → "Eaton Moeller" (text hiển thị khi phải tạo mới). */
export function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export class TaxonomyResolver {
  // Map "sống" đọc trực tiếp từ /admin/taxonomies (ưu tiên hơn taxMap thủ công).
  // category: meta_slug(lowercase) → _id ; spec_group: text(chuẩn hoá) → _id.
  private liveCate: Record<string, string> | null = null
  private liveSpecGroup: Record<string, string> | null = null

  constructor(
    private client: SiteClient,
    private siteId: string
  ) {}

  private siteMap(): { category: Record<string, string>; spec_group: Record<string, string> } {
    const cfg: AppConfig = configStore.get()
    return cfg.taxMap[this.siteId] || { category: {}, spec_group: {} }
  }

  /** Làm phẳng cây taxonomy (node + children đệ quy) thành mảng. */
  private flatten(nodes: TaxNode[]): TaxNode[] {
    const out: TaxNode[] = []
    const walk = (list: TaxNode[]): void => {
      for (const n of list) {
        out.push(n)
        if (n.children && n.children.length) walk(n.children)
      }
    }
    walk(nodes || [])
    return out
  }

  /** Nạp map sống từ trang admin (yêu cầu site có tài khoản admin). Best-effort:
   *  nếu lỗi (thiếu tài khoản / login fail) thì giữ null → tự fallback về taxMap thủ công.
   *  Trả về true nếu nạp được ít nhất 1 nhóm. */
  async loadLiveMaps(): Promise<boolean> {
    try {
      const cates = await this.client.fetchTaxonomyTree('category')
      this.liveCate = {}
      for (const n of this.flatten(cates)) {
        if (n.meta_slug) this.liveCate[n.meta_slug.toLowerCase()] = String(n._id)
      }
    } catch {
      this.liveCate = null
    }
    try {
      const groups = await this.client.fetchTaxonomyTree('spec_group')
      this.liveSpecGroup = {}
      for (const n of this.flatten(groups)) {
        if (n.text) this.liveSpecGroup[n.text.trim().toLowerCase()] = String(n._id)
      }
    } catch {
      this.liveSpecGroup = null
    }
    return !!(this.liveCate || this.liveSpecGroup)
  }

  /** Resolve cate id: ưu tiên map sống (theo slug), rồi taxMap thủ công. */
  resolveCate(slug: string): string | undefined {
    if (!slug) return undefined
    const key = slug.toLowerCase()
    return this.liveCate?.[key] ?? this.siteMap().category[key]
  }

  /** Resolve spec_group id: ưu tiên map sống (theo text), rồi taxMap thủ công. */
  resolveSpecGroup(text: string): string | undefined {
    if (!text) return undefined
    const key = text.trim().toLowerCase()
    return this.liveSpecGroup?.[key] ?? this.siteMap().spec_group[key]
  }

  /** Tạo taxonomy mới (cate/spec_group) qua POST + cache vào config & map sống. Có rủi ro trùng
   *  nếu taxonomy đã tồn tại trên server (đã giảm thiểu nhờ ưu tiên khớp map sống trước). */
  async createAndCache(type: 'category' | 'spec_group', text: string, key: string): Promise<string> {
    const id = await this.client.createTaxonomy({ text, tax_type: type, tax_for: 'product' })
    const cfg = configStore.get()
    const map = cfg.taxMap[this.siteId] || { category: {}, spec_group: {} }
    map[type][key.toLowerCase()] = id
    configStore.update({ taxMap: { ...cfg.taxMap, [this.siteId]: map } })
    // cache vào map sống để các lượt resolve sau trong cùng run tìm thấy ngay (tránh tạo trùng).
    if (type === 'spec_group') (this.liveSpecGroup ??= {})[key.toLowerCase()] = id
    else (this.liveCate ??= {})[key.toLowerCase()] = id
    return id
  }

  /** Bảo đảm có spec_group id: resolve trước; nếu thiếu và autoCreate bật thì tạo mới theo đúng
   *  text trong Excel. Trả undefined nếu không có text / không tạo. */
  async ensureSpecGroupId(text: string, autoCreate: boolean): Promise<string | undefined> {
    if (!text) return undefined
    const existing = this.resolveSpecGroup(text)
    if (existing) return existing
    if (!autoCreate) return undefined
    return this.createAndCache('spec_group', text.trim(), text.trim().toLowerCase())
  }

  /** Đánh dấu cate/spec_group chưa map vào draft.errors (UI tô đỏ).
   *  autoCreateSpecGroup=true ⇒ KHÔNG cảnh báo spec_group thiếu (sẽ tự tạo lúc đăng). */
  annotateNeedCreate(draft: ProductDraft, autoCreateSpecGroup = false): void {
    if (draft.cateSlug && !this.resolveCate(draft.cateSlug)) {
      draft.errors.push(`Cần map danh mục "${draft.cateSlug}" → ID site`)
    } else {
      draft.cateId = this.resolveCate(draft.cateSlug)
    }
    const specId = this.resolveSpecGroup(draft.specGroupText)
    if (draft.specGroupText && !specId && !autoCreateSpecGroup) {
      draft.errors.push(`Cần map nhóm thông số "${draft.specGroupText}" → ID site`)
    } else {
      draft.specGroupId = specId
    }
  }

  /** Dựng payload new_* cho brand/series/madein (lamha tự resolve-or-create khi PUT). */
  buildNewTaxPayload(draft: ProductDraft): TaxPutPayload {
    const out: TaxPutPayload = { formPatch: {} }

    if (draft.brandSlug) {
      out.new_brand = [{ text: humanizeSlug(draft.brandSlug), tax_type: 'brand', tax_for: 'product' }]
    }
    if (draft.madeinText) {
      out.new_madein = [{ text: draft.madeinText, tax_type: 'madein', tax_for: 'product' }]
    }
    if (draft.seriesText) {
      const tempId = `tmp_series_${draft.rowIndex}`
      out.new_series = [{ id: tempId, text: draft.seriesText, tax_type: 'series', tax_for: 'product' }]
      out.formPatch.series = [tempId] // update controller thay tempId bằng id thật theo vị trí
    }
    return out
  }
}
