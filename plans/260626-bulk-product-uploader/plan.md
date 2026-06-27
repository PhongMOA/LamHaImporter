---
title: Lamha-Importer — App đăng sản phẩm hàng loạt từ Excel + AI (ChatGPT bridge)
status: completed
created: 2026-06-26
completed: 2026-06-26
mode: hard
tags: [electron, react, typescript, excel, gpt-bridge, lamha, bulk-import]
related:
  - h:/Project vibe code/Lamha (web đích, REST API + upload)
  - h:/Project vibe code/Add-On GPT (Local GPT Bridge :8765)
blockedBy: []
blocks: []
---

# Lamha-Importer — Đăng sản phẩm hàng loạt từ Excel + nội dung AI

## 0. Trạng thái triển khai (2026-06-26) ✅ HOÀN TẤT

Toàn bộ 5 phase đã code xong. `npm run typecheck` (node+web) sạch, `npm run build` sạch,
app khởi động thật thành công (hub WS nhúng listening `:8765`, cửa sổ tạo OK).

**Khác biệt so với plan ban đầu:**
- **EmbeddedBridge port sang TypeScript** (vendored `src/main/bridge/{embeddedBridge,extract}.ts`)
  thay vì import factory `createBridge()` từ Add-On GPT — tự chứa, đóng gói Electron bền hơn (giữ
  nguyên hợp đồng WS `/ws?token=`, extension không đổi).
- **Taxonomy**: `brand/series/madein` → `new_*` khi PUT (server resolve-or-create idempotent);
  nhưng `category/spec_group` **không** auto-create qua `new_*` và lamha **không có GET list API**
  ⇒ phải **map sẵn** trong `taxMap[siteId]` (Cài đặt) hoặc tạo thủ công. Draft gắn cảnh báo nếu chưa map.
- **CSRF**: `XSRF-TOKEN` chỉ set ở error-handler khi path `/api/` lỗi ⇒ dùng "primer" `DELETE
  /api/__csrf_prime__` để kích cookie; thêm **tự refresh token + retry 1 lần khi gặp 403** (batch dài).
- **Review-gate**: tách `nextStageBGenerate` (sinh, không cần duyệt) khỏi `nextStageBUpsert` (chỉ
  đăng khi đã duyệt nếu bật gate) — Pha B chạy 2 pass.
- **package.json KHÔNG dùng `type:module`** (main/preload build CJS) để tránh lỗi interop ESM↔native
  (better-sqlite3) khi Electron chạy main.

**Đã sửa sau code-review (Critical/High):** cancel theo `runId` (không hủy nhầm run); gate detail
rỗng để job không kẹt ở `content`; CSRF tự refresh khi 403; `featured_image` set ngay tại ảnh
index 0 (không mất khi resume giữa upload).

## 1. Mục tiêu

App PC đọc file Excel mẫu (`FILE MẪU UP WEB HÀNG LOẠT AI ...xlsx`), chạy **quy trình 2 pha** trên một **durable queue (SQLite)** để chống crash/cúp điện:

- **Pha A — Upload khung (nhanh, không cần AI):** map cột → field cấu trúc, ghép ảnh từ folder local, **tạo SP bình thường** (hiển thị ngay) + upload ảnh lên **site đích** đã chọn (lamha / thietbicodien / …).
- **Pha B — Enrich (chậm, tuần tự):** với từng SP đã tạo, gọi **GPT Bridge nhúng sẵn trong app** (hub WS `:8765` chạy ngay trong Electron main — không cần start server rời, chỉ cần bật addon + mở tab ChatGPT đã login) sinh **mô tả** (cột 2 → `detail`) + **bảng thông số** (cột 16 → `attributes`), cho **duyệt/sửa tay**, rồi **upsert** (`PUT`) bổ sung vào SP.

Mọi bước được checkpoint vào SQLite ⇒ tắt app / mất điện giữa chừng vẫn **resume** đúng chỗ dở.

## 2. Bối cảnh đã xác minh trong codebase (KHÔNG phải giả định)

### 2.1 Add-On GPT là Bridge hoàn chỉnh — NHÚNG TRỰC TIẾP vào app (D10)
Kiến trúc Bridge (đã đọc source `server/src/index.js`, `extensionHub.js`, `config.js`, `extension/background.js`):
- Server = `Express(/v1)` + `http.createServer` + **`extensionHub.attach(server)`** (WS `WebSocketServer({ server, path:'/ws' })`) + **worker `pump()` loop** dequeue job → đẩy qua WS tới extension. Tất cả trên **cùng 1 port** (mặc định `8765`).
- Extension (`background.js`) chỉ là **WS client auto-reconnect** nối `ws://127.0.0.1:8765/ws?token=<AUTH_TOKEN>` — **agnostic** với việc server đứng riêng hay nhúng trong app. ⇒ Nhúng server vào Electron main thì extension **không cần đổi gì**.
- **Quyết định D10**: Electron main **tự host** WS hub + queue + `pump()` in-process (qua factory `createBridge({port,host,token})` — refactor nhỏ ở Add-On GPT để export). App gọi **thẳng `jobQueue.enqueue()`** trong tiến trình, lắng nghe delta/settled ⇒ **bỏ hẳn lớp HTTP `/v1`** (không fetch/poll localhost).
- Hợp đồng job (qua factory, không qua HTTP): `enqueue({ prompt, newChat?, conversationId?, timeoutMs?, image?, extract? })` → `jobId`; event `settled` → `{ status, answer, rawAnswer, extractWarning, images, conversationId }`. `health()` → `{ ok, extensionConnected }`. **Phải check `extensionConnected:true` trước khi gửi** (yêu cầu user bật addon + mở tab ChatGPT đã login).
- `extract: { type:"code", lang:"json" }` → bóc đúng nội dung trong code block ⇒ lấy **JSON bảng thông số sạch**.
- Auth WS: extension gửi `?token=<AUTH_TOKEN>`; main so khớp `config.authToken`, sai → `ws.close(4001)`. App tự sinh/đặt token, hiển thị cho user nhập vào options của extension.
- **Giới hạn cốt tử**: hub xử lý **tuần tự 1 job/lần** (1 session GPT); phụ thuộc **trần tin nhắn ChatGPT Plus** → quá tay sẽ `error`/`timeout`. ⇒ Batch phải throttle + retry + resume (xem §6).
- **Lưu ý kỹ thuật khi nhúng**: bundle `ws` vào main; xử lý `EADDRINUSE` nếu user lỡ chạy server Add-On GPT rời (port 8765 trùng) → báo lỗi rõ/cho đổi port; lifecycle: start ở `app.whenReady`, stop ở `before-quit`.

### 2.2 lamha có sẵn REST API (file: `modules/product/product.api.routes.js`)
- `POST   /api/products`        — tạo (`product.crud.js#create`): tự sinh `meta_slug`, `meta_title`, cập nhật sitemap.
- `PUT    /api/products/:id`    — cập nhật (tự tạo taxonomy mới qua `new_*` fields).
- `POST   /api/upload/product`  — upload ảnh (`modules/upload/controllers/upload.js`): multipart `file`, body `target_id` → `sharp` resize + tạo thumb → `$push` vào `product.images`.
- `POST   /api/upload/images`   — chỉ trả `{url}` (không ghi DB) — dùng cho ảnh lẻ.
- Auth API: **KHÔNG nằm dưới `/admin`** ⇒ không cần đăng nhập. Rào duy nhất là **CSRF** (`csurf({cookie:true})` trong `modules/app/helpers/setAppRoutes.js`): phải `GET` 1 trang để nhận cookie `_csrf` + `XSRF-TOKEN`, rồi gửi token lại qua header (`x-csrf-token`) trên các request mutate.
- Body create: `{ form: {...product fields} }` (controller đọc `req.body.form`).

### 2.3 Schema sản phẩm (`modules/product/models/Product.js`) — field dùng tới
`title, detail(HTML), desc, price, status_text, warranty(Number), model, manual, madein(ref Tax), brand(ref Tax), cate(ref Tax), series([ref Tax]), spec_group(ref Tax), attributes([{title,value,url}]), images([{thumb,url,name}]), featured_image({thumb,url,name}), also_buy([ref Product]), meta_slug, meta_title`.

### 2.4 Taxonomy
`TaxModel` có `tax_type` (`brand|category|madein|series|spec_group|...`), `tax_for` (`product`), `text`, `meta_slug`, `meta_title`. lamha tự tạo madein khi import nếu chưa có (`product.import.js`). App phải **resolve-or-create** brand/category/series/madein theo cùng pattern.

## 3. Quyết định kiến trúc (đã chốt với user)

| # | Quyết định | Chốt |
|---|---|---|
| D1 | Giao tiếp ChatGPT | Gọi **Local GPT Bridge** có sẵn (`:8765`). Không build extension. |
| D2 | Ghi vào web | Qua **REST API** lamha (giữ logic slug/sitemap/taxonomy). Không ghi thẳng MongoDB. |
| D3 | Stack app PC | **Electron + React + TypeScript + Vite + Ant Design**; `axios`+`tough-cookie` (CSRF), `xlsx` (SheetJS). |
| D4 | Folder ảnh | **1 folder phẳng**, tên file bắt đầu bằng slug cột 4 (vd `slug-1.jpg`, `slug-2.jpg`). Ảnh đầu (theo thứ tự tên) = `featured_image`. |
| D5 | Nội dung AI | **Mô tả → `detail` (HTML)**; **bảng thông số → `attributes[]`** (cấu trúc `{title,value}`, lấy qua `extract:json`). |
| D6 | Site đích | **App có bộ chọn site** (multi-target config). Các site (lamha/thietbicodien/…) chung source + thiết kế DB ⇒ cùng 1 API contract, chỉ khác `baseUrl`/token. Local test trỏ chung 1 server; prod mỗi site 1 URL. User chọn site trước khi publish. |
| D7 | **Quy trình 2 pha + KHÔNG dùng cờ ẩn** | Đã verify: `is_hidden` trong lamha **không** lọc ở frontend (list + chi tiết by slug) ⇒ không có cờ ẩn dùng được, và **không sửa source** (dùng chung 4 site prod). Thay vào: **Pha A** tạo SP bình thường (hiển thị ngay) với field cấu trúc + ảnh (nhanh, không cần AI); **Pha B** upsert bổ sung `detail`+`attributes` từ AI (tuần tự, chậm). Chấp nhận cửa sổ ngắn SP "có khung, chưa có nội dung AI". |
| D8 | **Durable queue (chống crash/cúp điện)** | Toàn bộ tiến trình lưu trong **SQLite** (`better-sqlite3`, WAL) như 1 state machine; mỗi bước ghi checkpoint trong **transaction nguyên tử**. Khởi động lại → tự **resume** SP chưa ở trạng thái cuối. Không dùng file JSON (dễ hỏng khi cúp điện giữa lúc ghi). |
| D9 | **UI: Dark mode + brand color** | Giao diện **dark mode** (logo `lamha.vn/.../logo_white.png` chỉ có 1 màu trắng ⇒ chỉ nổi trên nền tối). Màu chủ đạo **`#1c6d66`** (teal đậm). Dùng **AntD `theme.darkAlgorithm` + `token.colorPrimary:'#1c6d66'`**. Logo **bundle nội bộ** (tải về `src/assets/logo_white.png`) để app chạy offline. Xem palette ở [phase-5 §5.0](phases/phase-5-ui-batch.md). |
| D10 | **Nhúng Bridge server vào app (không chạy server rời)** | Electron main **tự host** WS hub (`ws` path `/ws`, port 8765) + queue + worker loop của Add-On GPT. Extension giữ nguyên (nối `ws://127.0.0.1:8765/ws?token=`), **chỉ cần bật addon + mở tab ChatGPT đã login**. App gọi **thẳng `jobQueue` in-process** ⇒ **bỏ lớp HTTP `/v1`** (không cần fetch/poll localhost). Tái sử dụng module Add-On GPT (`extensionHub`, `queue`, `extract`) qua factory `createBridge()` — DRY, 1 nguồn sự thật. |

## 4. Kiến trúc tổng thể

```
┌──────────────────────── Lamha-Importer (Electron) ────────────────────────┐
│ Renderer (React + AntD, dark mode #1c6d66)                                 │
│  • Chọn file Excel + folder ảnh + SITE ĐÍCH                                 │
│  • Bảng review: tô đỏ field thiếu, xem nội dung AI, sửa tay                 │
│  • Nút "Sinh nội dung AI" / "Đẩy lên <site>" + progress hàng loạt          │
│                                                                            │
│ Main process (services, TypeScript)                                        │
│  • ExcelService        parse + map cột → ProductDraft                       │
│  • ImageService        match slug → file ảnh local                         │
│  • TaxonomyResolver    slug/URL → resolve-or-create (per site)             │
│  • EmbeddedBridge ⭐   NHÚNG hub WS /ws :8765 + queue + pump() in-process   │
│  • SiteClient          per-site axios (CSRF) → create product + upload ảnh  │
│  • QueueStore          SQLite durable queue (state machine, resume)        │
│  • BatchOrchestrator   luồng 2 pha: A=upload khung, B=enrich AI, idempotent │
│  • ConfigStore         danh sách site targets + đường dẫn + token          │
└───────────────┬────────────────────────────────────┬───────────────────────┘
   ws://127.0.0.1:8765/ws?token=  (extension nối vào) │ http(s) REST (site đã chọn)
                ▼                                       ▼
   Chrome Extension (Add-On GPT) ──> ChatGPT(browser)   lamha / thietbicodien / ...
   * KHÔNG cần chạy server rời — chỉ bật addon + mở tab ChatGPT đã login *   (node server.js)
```

## 5. Column mapping (file Excel mẫu → Product)

| Cột | Header Excel | → Product field | Transform / nguồn |
|----|--------------|-----------------|--------------------|
| 1 | Tên Sản phẩm | `title` (+ meta auto) | as-is |
| 2 | Chi tiết sản phẩm | `detail` (HTML) | **chỉ dẫn → GPT** sinh HTML (giới thiệu/ưu điểm/nguyên lý/mua ở đâu) |
| 3 | Link | *(tham chiếu nguồn)* | URL SP gốc — không phải field; dùng làm ngữ cảnh prompt AI |
| 4 | Hình ảnh | `images[]`, `featured_image` | slug → match file `slug*.*` trong folder → upload |
| 5 | Danh mục | `cate` (Tax category) | tách slug từ URL → resolve-or-create |
| 6 | Series | `series[]` (Tax series) | text → resolve-or-create |
| 7 | Mã hàng | `spec_group` (Tax) | text (cấp series, giống nhau cả nhóm) → resolve-or-create |
| 8 | Bảo hành | `warranty` (Number) | "12 Tháng" → `12` |
| 9 | Thương hiệu | `brand` (Tax brand) | tách slug từ URL → resolve-or-create |
| 10 | Xuất xứ | `madein` (Tax madein) | "Romania" → resolve-or-create |
| 11 | Model | `model` (String) | as-is |
| 12 | Tài liệu kỹ thuật | `manual` (String) | URL Google Drive as-is |
| 13 | Tình trạng | `status_text` | trim ("Liên hệ") |
| 14 | Giá sản phẩm | `price` (Number) | `3745000` |
| 15 | Sản phẩm mua cùng | `also_buy[]` | links cách nhau `,` → resolve product id (thường rỗng) |
| 16 | Thông số kỹ thuật | `attributes[]` | **chỉ dẫn → GPT** trả JSON `[{title,value}]` (10–15 dòng) qua `extract:json` |

> ⚠️ **Note rows**: ở file mẫu, cột 15/16 dòng đầu chứa *hướng dẫn dùng* ("Nếu có sp mua cùng…", "AI tự lấy trên online…"). Parser phải nhận diện và **bỏ qua các ghi chú template**, không coi là dữ liệu.

## 6. Rủi ro & cách xử lý (brutal, không né)

| # | Rủi ro | Mức | Cách xử lý |
|---|--------|-----|-----------|
| R1 | Bridge **tuần tự + trần ChatGPT Plus** → Pha B rất chậm, dễ `error/timeout` | CAO | **Tách Pha A (upload khung) khỏi Pha B (AI)** ⇒ SP đã lên web dùng được ngay, AI chỉ là bổ sung. Pha B chạy tuần tự, throttle + retry backoff, **resume qua durable queue**, check `extensionConnected` trước mỗi lượt |
| R2 | Output AI không ổn định (JSON hỏng, HTML kèm lời dẫn) | CAO | `extract:{type:code,lang:json}` cho thông số; validate `JSON.parse`, fallback `rawAnswer`; **human review** trước khi upsert; SP lỗi AI vẫn còn khung trên web |
| R3 | Brand/category/series (URL thietbicodien) **chưa tồn tại** ở DB site đích → ref null | CAO | TaxonomyResolver: tách `meta_slug` từ URL, `findOne({meta_slug,tax_type,tax_for})`; nếu thiếu → tạo qua `new_*` fields của PUT hoặc tạo Tax trực tiếp; log rõ cái nào vừa tạo |
| R4 | CSRF chặn POST | TB | SiteClient: `GET /` lấy cookie `_csrf`+`XSRF-TOKEN` → gắn header `x-csrf-token`; cookie jar `tough-cookie` |
| R5 | Chạy lại / sau crash bị **trùng sản phẩm** | CAO | **Durable queue (SQLite) là nguồn idempotent chính**: lưu `product_id` theo `(site_id, model)` ngay sau khi tạo; bước nào `done` thì bỏ qua; nếu nghi ngờ → `findExisting` trên site rồi `PUT` thay vì `POST` |
| R6 | Ảnh: match sai slug, thứ tự featured, ảnh nặng | TB | Quy ước tên `slug-<n>.<ext>`, sort theo số; ảnh `-1` = featured; báo SP thiếu ảnh; server tự `sharp` resize |
| R7 | Sai site đích (đăng nhầm prod) | CAO | Bắt buộc chọn site + **xác nhận** trước batch; badge cảnh báo khi target là prod; token riêng từng site |
| R8 | Local server PnP crash | TB | Demo lamha phải chạy bằng `node server.js` (đã ghi nhớ), KHÔNG `pnpm start` |
| R9 | **Crash/cúp điện giữa batch** | CAO | Durable queue SQLite (WAL) + checkpoint **transaction nguyên tử** sau mỗi bước; khởi động lại tự nạp lại hàng đợi, tiếp tục SP chưa ở trạng thái cuối. Ghi atomic ở mức bước nhỏ nhất (1 SP / 1 ảnh / 1 lượt AI) |
| R10 | **Cửa sổ SP "thiếu nội dung AI"** đang hiển thị công khai | TB | Pha A đã có đủ tên/giá/ảnh/brand/cate (SP dùng được); chạy Pha B sớm ngay sau Pha A; ưu tiên enrich theo lô nhỏ; (tuỳ chọn) đặt `desc` tạm từ title để không trống trơn |

## 7. Lộ trình (5 phases)

> Thứ tự pipeline: **Pha A = Phase 3** (upload khung), **Pha B = Phase 4** (enrich AI + upsert). Durable queue dựng ở Phase 1 (hạ tầng xuyên suốt).

| Phase | File | Nội dung | Kết quả |
|-------|------|----------|---------|
| 1 | [phase-1-foundation.md](phases/phase-1-foundation.md) | Scaffold Electron+React+TS+Vite, types, ConfigStore (multi-site), SiteClient (CSRF), **EmbeddedBridge (nhúng hub WS /ws :8765 + queue + pump in-process)**, **Durable Queue (SQLite state machine)** | Khung app chạy, extension nối vào hub nhúng, ping site, queue persist/resume được |
| 2 | [phase-2-excel-import.md](phases/phase-2-excel-import.md) | ExcelService (parse + mapping + bỏ note rows), ImageService (match slug), TaxonomyResolver → **nạp work items vào queue** | Import Excel → queue đầy đủ draft + ảnh + tax resolved |
| 3 | [phase-3-ai-content.md](phases/phase-3-ai-content.md) | **Pha A — Upload khung**: SiteClient create product (visible) + upload ảnh + featured, idempotent qua queue, checkpoint từng bước | Toàn bộ SP lên web demo (có khung), resume được |
| 4 | [phase-4-publish.md](phases/phase-4-publish.md) | **Pha B — Enrich AI**: Bridge sinh detail+attributes (conversationId, extract, validate, retry) → review → `PUT` upsert, checkpoint | SP được bổ sung mô tả + thông số, resume được |
| 5 | [phase-5-ui-batch.md](phases/phase-5-ui-batch.md) | UI bảng review/sửa, chọn site, BatchOrchestrator chạy 2 pha + progress + error log + nút resume, đóng gói `.exe` | App hoàn chỉnh, đăng + enrich cả file Excel |

## 8. Nguyên tắc code
- YAGNI/KISS/DRY. TypeScript strict. Tách `shared/types.ts` làm hợp đồng giữa main ↔ renderer.
- IPC main↔renderer typed (preload bridge). Mọi I/O (Excel, ảnh, network) nằm ở **main process**.
- Không hardcode site/token → đọc từ ConfigStore. Mọi action mutate ra prod phải qua xác nhận.
- Log có cấu trúc theo từng SP để debug batch.

## 9. Câu hỏi còn mở (xử lý khi vào phase)
- Cột 7 "Mã hàng" map `spec_group` hay chỉ là alias series? (đề xuất: `spec_group`; xác nhận khi xem cách web render).
- `desc` (mô tả ngắn) có cần AI sinh riêng không, hay cắt từ `detail`? (đề xuất: cắt 1–2 câu đầu của detail).
- Danh sách site prod + token: lấy ở đâu (memory có prod server `103.106.105.120`)? Cấu hình khi tới phase 5.
