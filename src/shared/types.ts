// ============================================================================
// Hợp đồng dữ liệu dùng chung giữa main process và renderer (qua preload IPC).
// Khớp modules/product/models/Product.js của lamha.
// ============================================================================

export interface Attribute {
  title: string
  value: string
  url?: string
}

export interface ProductImage {
  name: string
  url: string
  thumb?: string
}

/** Một dòng sản phẩm sau khi map từ Excel + match ảnh + resolve taxonomy. */
export interface ProductDraft {
  rowIndex: number
  title: string
  detailInstruction: string // chỉ dẫn cột 2 → GPT sinh detail
  specInstruction: string // chỉ dẫn cột 16 → GPT sinh attributes
  refLink: string // cột 3 — URL gốc, dùng làm ngữ cảnh prompt
  metaSlug: string // slug sản phẩm nhập thẳng ở cột Link (rỗng → web tự sinh theo title)
  detail: string // HTML do AI sinh (rỗng cho tới Pha B)
  desc: string
  attributes: Attribute[] // do AI sinh (JSON)
  price: number
  status_text: string
  warranty: number // số tháng
  model: string
  manual: string
  // taxonomy — lưu cả raw (slug/text) để resolve và id sau khi resolve
  brandSlug: string
  cateSlug: string
  seriesText: string
  madeinText: string
  specGroupText: string
  brandId?: string
  cateId?: string
  seriesIds?: string[]
  madeinId?: string
  specGroupId?: string
  imageSlug: string // cột 4 — tiền tố tên file ảnh
  imageFiles: string[] // đường dẫn ảnh local đã match (tuyệt đối)
  alsoBuyLinks: string[]
  errors: string[] // cảnh báo lúc parse (thiếu ảnh, taxonomy needCreate...)
}

/** Taxonomy cần tạo trên site đích (chưa tồn tại). */
export interface TaxNeedCreate {
  type: TaxType
  text: string
  meta_slug?: string
  meta_title?: string
}

export type TaxType = 'brand' | 'category' | 'series' | 'madein' | 'spec_group'

export interface SiteTarget {
  id: string
  label: string
  baseUrl: string
  token?: string
  isProd: boolean
  // Tài khoản admin (tùy chọn) — chỉ để ĐỌC danh mục/nhóm thông số từ /admin/taxonomies
  // nhằm auto-map cate/spec_group theo slug. KHÔNG cần cho việc đăng sản phẩm.
  username?: string
  password?: string
}

/** Cấu hình xử lý ảnh trước khi upload (resize vuông size×size + nén webp). */
export interface ImageProcessConfig {
  enabled: boolean // bật/tắt — tắt thì upload ảnh gốc nguyên trạng
  size: number // cạnh ô vuông đích, px (mặc định 800)
  quality: number // chất lượng webp 1–100 (mặc định 82)
  fit: 'contain' | 'cover' // contain=nền trắng giữ cả ảnh; cover=cắt giữa cho đầy khung
}

export interface AppConfig {
  bridgeHost: string // mặc định '127.0.0.1' (hub WS nhúng)
  bridgePort: number // mặc định 8765
  bridgeToken: string // token WS — phải khớp options của extension
  sites: SiteTarget[]
  activeSiteId: string
  imageFolder: string
  throttleMs: number // throttle giữa các lượt AI (Pha B)
  autoCreateSpecGroup: boolean // tự tạo nhóm thông số (spec_group) trên site khi chưa tồn tại
  imageProcess: ImageProcessConfig // xử lý ảnh (resize vuông + nén webp) trước khi upload
  // Bật/tắt tạo ảnh nội dung. Tắt → bài KHÔNG có ảnh kèm (không chèn placeholder, không vẽ ảnh).
  detailImageEnabled: boolean
  // Yêu cầu tạo ảnh nội dung — mỗi phần tử = 1 ảnh trong bài (mặc định 2). Đây là yêu cầu CHUNG
  // cho mọi bài: được đính vào prompt VIẾT BÀI để AI tự sinh mô tả [[IMAGE: ...]] theo đúng vị trí +
  // yêu cầu (KHÔNG dùng trực tiếp trong prompt tạo ảnh). Phần tử rỗng → bỏ qua ảnh đó.
  detailImageRequests: string[]
  // Map taxonomy cate/spec_group (không auto-create qua new_*) → id có sẵn, theo từng site.
  // taxMap[siteId] = { category: { slug→id }, spec_group: { textKey→id } }
  taxMap: Record<string, { category: Record<string, string>; spec_group: Record<string, string> }>
}

// ============================================================================
// Durable queue (SQLite) — trạng thái 1 job = 1 sản phẩm trong 1 lần chạy.
// ============================================================================

export type StageAStatus = 'pending' | 'creating' | 'created' | 'images' | 'done' | 'error'
export type StageBStatus = 'pending' | 'generating' | 'content' | 'enriched' | 'done' | 'error'

export interface JobRow {
  id: string // `${runId}:${rowIndex}`
  run_id: string
  site_id: string
  row_index: number
  model: string
  title: string
  draft_json: string // ProductDraft serialized
  // Pha A
  product_id: string | null
  images_done: number
  images_total: number
  stage_a: StageAStatus
  // Pha B
  conversation_id: string | null
  detail: string | null
  attributes_json: string | null
  seo_json: string | null // {meta_title, meta_desc, tags[]} do AI sinh (Pha B)
  reviewed: number // 0|1
  stage_b: StageBStatus
  attempts: number
  last_error: string | null
  updated_at: number
}

export interface RunRow {
  id: string
  site_id: string
  file: string
  image_folder: string
  created_at: number
}

export interface QueueStats {
  total: number
  stageA: Record<StageAStatus, number>
  stageB: Record<StageBStatus, number>
}

// ============================================================================
// Bridge (embedded GPT) — kết quả health + ask.
// ============================================================================

export interface BridgeHealth {
  running: boolean // hub WS đã start chưa
  extensionConnected: boolean
  queueDepth: number
  inFlight: number
}

export interface AskResult {
  answer: string
  rawAnswer: string
  extractWarning: string | null
  conversationId: string | null
  images: string[]
}

export interface ExtractRule {
  type: 'text' | 'code'
  lang?: string
  select?: 'all' | 'first' | 'last'
  join?: string
}

// ============================================================================
// Kết quả test kết nối (Settings).
// ============================================================================

export interface SitePingResult {
  ok: boolean
  status?: number
  csrfToken: boolean
  message?: string
}
