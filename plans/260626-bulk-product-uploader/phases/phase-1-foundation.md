# Phase 1 — Foundation: khung app + client bridge & site

**Mục tiêu:** App Electron chạy được, kết nối thử Bridge `:8765` và 1 site demo (qua CSRF), có cấu hình multi-site.

## Tasks

### 1.1 Scaffold project
- Khởi tạo `Lamha-Importer/` với **Electron + Vite + React + TypeScript** (gợi ý template `electron-vite`).
- Cấu trúc:
  ```
  electron/main/        index.ts, ipc.ts, services/
  electron/preload/     index.ts (typed bridge)
  src/                  React UI (renderer)
  shared/               types.ts, mapping.ts
  ```
- Bật TypeScript `strict`. ESLint + Prettier.

### 1.2 shared/types.ts — hợp đồng dữ liệu
Định nghĩa type khớp `modules/product/models/Product.js`:
```ts
export interface Attribute { title: string; value: string; url?: string }
export interface ProductImage { name: string; url: string; thumb?: string }
export interface ProductDraft {
  rowIndex: number;
  title: string;
  detail: string;            // HTML do AI sinh
  desc?: string;
  attributes: Attribute[];   // do AI sinh (JSON)
  price: number;
  status_text: string;
  warranty: number;          // số tháng
  model: string;
  manual: string;
  // taxonomy (lưu cả raw để resolve)
  brandSlug: string; cateSlug: string; seriesText: string; madeinText: string; specGroupText: string;
  brandId?: string; cateId?: string; seriesIds?: string[]; madeinId?: string; specGroupId?: string;
  imageFiles: string[];      // đường dẫn ảnh local đã match
  alsoBuyLinks: string[];
  // trạng thái pipeline
  aiStatus: 'pending'|'generating'|'done'|'error';
  publishStatus: 'pending'|'publishing'|'done'|'error'|'skipped';
  productId?: string;        // id sau khi tạo (để upsert/upload ảnh)
  errors: string[];
}
export interface SiteTarget { id: string; label: string; baseUrl: string; token?: string; isProd: boolean }
export interface AppConfig {
  bridgeHost: string;        // mặc định '127.0.0.1' (hub WS nhúng)
  bridgePort: number;        // mặc định 8765
  bridgeToken: string;       // token WS — phải khớp options của extension
  sites: SiteTarget[]; activeSiteId: string;
  imageFolder: string;
}
```

### 1.3 ConfigStore (main)
- Lưu cấu hình JSON ở `app.getPath('userData')/config.json`.
- Mặc định seed:
  - `bridgeHost:'127.0.0.1'`, `bridgePort:8765`, `bridgeToken` do app sinh (user dán vào options extension). KHÔNG còn phụ thuộc `Add-On GPT/server/.env` vì hub chạy nhúng trong app.
  - `sites`: ví dụ `[{id:'local', label:'Local demo', baseUrl:'http://127.0.0.1:3000', isProd:false}]`. Cho phép thêm site (lamha/thietbicodien prod) sau.
- API: `get()`, `update(partial)`, `addSite()`, `setActiveSite()`.

### 1.4 EmbeddedBridge (main) — NHÚNG GPT Bridge vào app (D10) ⭐
Thay vì gọi HTTP tới server rời, **host hub WS + queue + worker ngay trong Electron main**. Extension nối vào hub này như nối server thường (`ws://127.0.0.1:8765/ws?token=`).

**Prerequisite — refactor nhỏ ở Add-On GPT:** export 1 factory thuần (không tự `listen`, không phụ thuộc `.env`) để tái dùng `extensionHub` + `queue` + `pump()` + `extract`:
```js
// Add-On GPT/server/src/createBridge.js  (mới — bóc tách từ index.js)
export function createBridge({ port = 8765, host = '127.0.0.1', authToken }) {
  // tạo http.Server, extensionHub.attach(server, {authToken}), worker pump() loop, jobQueue
  return {
    start(): Promise<void>,                 // server.listen(port, host)
    stop(): Promise<void>,                  // đóng WS + http server
    health(): { ok: boolean; extensionConnected: boolean },
    enqueue(req): string,                   // {prompt,newChat?,conversationId?,timeoutMs?,image?,extract?} → jobId
    on('settled', (job) => void),           // job xong: {id,status,answer,rawAnswer,extractWarning,conversationId,images}
    on('extension', (state) => void),       // connected/disconnected
  };
}
```
> `index.js` của server rời chỉ còn `createBridge(config).start()` — DRY, 1 nguồn sự thật. App import trực tiếp module này (qua đường dẫn tương đối tới `Add-On GPT`, hoặc copy `server/src/*` vào app khi đóng gói).

**EmbeddedBridge service (main):**
```ts
class EmbeddedBridge {
  async start(opts:{port:number; host:string; token:string}): Promise<void>  // app.whenReady
  async stop(): Promise<void>                                                 // before-quit
  health(): { ok:boolean; extensionConnected:boolean }
  // gọi thẳng in-process, tự promisify quanh enqueue + 'settled'
  async ask(prompt: string, opts?: {newChat?:boolean; conversationId?:string; timeoutMs?:number; extract?:any})
    : Promise<{ answer:string; rawAnswer:string; extractWarning:string|null; conversationId:string; images:string[] }>
}
```
- `ask`: `const id = bridge.enqueue({...})` → `await` tới khi event `settled` cho đúng `id` (hoặc deadline timeoutMs vd 180s) → ném lỗi khi `status==='error'/'timeout'`. **Không HTTP, không poll.**
- Trước khi gửi: `health()`, nếu `extensionConnected:false` → lỗi rõ "Hãy bật addon + mở tab ChatGPT đã đăng nhập".
- **Lifecycle & lỗi:**
  - Start ở `app.whenReady`; stop ở `before-quit` (đóng WS + http server sạch).
  - `EADDRINUSE` (user lỡ chạy server Add-On GPT rời chiếm 8765) → báo lỗi rõ ở Settings, cho **đổi port** (đồng bộ với options của extension) hoặc nhắc tắt server rời.
  - Token: app sinh/lưu trong ConfigStore, hiển thị để user dán vào **options extension** (`serverUrl=ws://127.0.0.1:8765/ws`, `token=<...>`).

### 1.5 SiteClient (main) — client REST của site, có CSRF
```ts
class SiteClient {
  constructor(site: SiteTarget) // tạo axios instance + cookie jar (tough-cookie)
  async ensureCsrf(): Promise<void>  // GET '/' → cookie _csrf + XSRF-TOKEN, lưu token
  async createProduct(form): Promise<{_id:string}>          // POST /api/products {form}
  async updateProduct(id, form, newTax?): Promise<void>     // PUT  /api/products/:id
  async uploadProductImage(productId, filePath): Promise<ProductImage> // POST /api/upload/product (multipart)
  async findExisting(brandId, model): Promise<string|null>  // để idempotent (phase 4)
}
```
- Dùng `axios` + `axios-cookiejar-support` + `tough-cookie` để tự giữ cookie giữa các request.
- Gắn header `x-csrf-token: <XSRF-TOKEN>` cho mọi POST/PUT/DELETE.

### 1.6 Durable Queue (SQLite) — hạ tầng chống crash/cúp điện ⭐
Đây là **xương sống** của app (R9/R5). Dùng `better-sqlite3` (synchronous, transaction nguyên tử, bật `PRAGMA journal_mode=WAL`). DB đặt ở `userData/queue.db`.

**Bảng `jobs`** (1 dòng = 1 sản phẩm trong 1 lần chạy):
```sql
CREATE TABLE jobs (
  id            TEXT PRIMARY KEY,         -- `${runId}:${rowIndex}`
  run_id        TEXT,
  site_id       TEXT,
  row_index     INTEGER,
  model         TEXT,
  title         TEXT,
  draft_json    TEXT,                     -- ProductDraft (field cấu trúc + slug + image paths)
  -- Pha A
  product_id    TEXT,                     -- id sau khi tạo trên site (idempotent key)
  images_done   INTEGER DEFAULT 0,        -- số ảnh đã upload
  images_total  INTEGER DEFAULT 0,
  stage_a       TEXT DEFAULT 'pending',   -- pending|creating|created|images|done|error
  -- Pha B
  conversation_id TEXT,
  detail        TEXT,
  attributes_json TEXT,
  reviewed      INTEGER DEFAULT 0,        -- user đã duyệt chưa
  stage_b       TEXT DEFAULT 'pending',   -- pending|generating|content|enriched|done|error
  attempts      INTEGER DEFAULT 0,
  last_error    TEXT,
  updated_at    INTEGER
);
CREATE TABLE runs ( id TEXT PRIMARY KEY, site_id TEXT, file TEXT, image_folder TEXT, created_at INTEGER );
```

**State machine** (mỗi chuyển trạng thái = 1 transaction, ghi ngay sau khi hành động phụ thuộc đã chắc chắn xong):
```
Pha A:  pending → creating → created(product_id) → images(images_done++) → done
Pha B:  pending → generating → content(detail+attributes) → [review] → enriched(PUT) → done
        bất kỳ bước nào lỗi → error + last_error + attempts++ (retry được)
```

**API QueueStore:**
```ts
enqueue(run, drafts[])                      // nạp từ Excel (phase 2)
nextStageA(): Job | null                    // job có stage_a != done/error
nextStageB(): Job | null                    // job stage_a=done & stage_b != done/error & reviewed (nếu bật gate)
markStageA(id, patch)  / markStageB(id, patch)  // update + updated_at, trong transaction
recoverOnStartup()      // reset trạng thái "*-ing" (creating/generating) về mốc an toàn để chạy lại
stats(runId)            // đếm theo trạng thái cho progress UI
```

**Quy tắc an toàn:**
- Mỗi đơn vị checkpoint nhỏ nhất: **1 SP / 1 ảnh / 1 lượt AI**. Không gộp nhiều SP trong 1 transaction.
- Hành động mạng (create/upload/PUT) **idempotent**: trước khi gọi, kiểm `product_id`/`images_done` để không lặp.
- Khi khởi động: `recoverOnStartup()` đưa job đang `creating/generating` (bị cắt giữa chừng) về `pending` của bước đó — vì các hành động được thiết kế idempotent nên chạy lại an toàn.

### 1.7 IPC + UI tối thiểu (đã dark mode từ đầu)
- Bọc root bằng **`ConfigProvider` dark + `colorPrimary:'#1c6d66'`** (D9, chi tiết [phase-5 §5.0](phase-5-ui-batch.md)) ngay từ Phase 1 để mọi màn (kể cả Settings) đồng bộ theme.
- Tải logo về `src/assets/logo_white.png`, đặt ở header trên nền tối.
- Preload expose typed API: `config.*`, `bridge.health` (gọi hub nhúng), `site.ping`, `queue.stats`.
- Renderer: màn Settings — hiển thị **token + port hub** (nút copy để dán vào options extension), danh sách site, nút **"Test kết nối"** hiển thị: hub đang chạy + `extensionConnected`, Site phản hồi `GET /`.

## Acceptance criteria
- [ ] App mở cửa sổ, không lỗi console.
- [ ] **Hub nhúng** start cùng app: extension (bật addon, point `ws://127.0.0.1:8765/ws?token=`) tự nối → `health().extensionConnected:true`. Không chạy server Add-On GPT rời.
- [ ] "Test kết nối": hub trả `ok:true` + trạng thái extension; Site demo trả CSRF token thành công.
- [ ] `EmbeddedBridge.ask("ping")` qua tab ChatGPT trả lời được (smoke test end-to-end qua hub nhúng).
- [ ] Config lưu/đọc lại được sau khi restart; `before-quit` stop hub sạch (không treo port).
- [ ] `shared/types.ts` compile, dùng chung cho main + renderer.
- [ ] **Durable queue**: enqueue vài job giả → kill app giữa chừng → mở lại `recoverOnStartup()` nạp đúng trạng thái, không mất/không nhân đôi.

## Files (tạo mới)
`electron/main/index.ts`, `electron/main/services/{config.ts,embeddedBridge.ts,siteClient.ts,queueStore.ts}`, `electron/preload/index.ts`, `src/pages/SettingsPage.tsx`, `shared/types.ts`.
**Refactor ở Add-On GPT:** thêm `server/src/createBridge.js` (factory), `index.js` gọi lại factory đó.

## Phụ thuộc cần verify
- Add-On GPT export được `createBridge()` không vướng side-effect (dotenv, top-level `listen`). Đọc lại `index.js` để bóc tách sạch.
- Native module: `better-sqlite3` cần **`electron-rebuild`** (build theo ABI Electron); `ws` bundle vào main. Kiểm tra `electron-vite` externalize đúng 2 module này.
- Local lamha chạy port nào (`server.js`) → set vào site `local`.
- AUTH_TOKEN mặc định `change-me` của extension → đổi cho khớp token app sinh.
