# Phase 2 — Excel import + ảnh + resolve taxonomy

**Mục tiêu:** Chọn file Excel + folder ảnh → ra danh sách `ProductDraft` đã map cột, đã match ảnh, đã resolve (hoặc đánh dấu cần tạo) taxonomy theo site đang chọn.

## Tasks

### 2.1 ExcelService.parse(filePath) → ProductDraft[]
- Dùng **SheetJS (`xlsx`)**: `sheet_to_json(ws, { header:1 })`, bỏ dòng header (row 1).
- Map theo bảng cột (xem `plan.md §5`). Giữ thứ tự cột cứng theo file mẫu, nhưng **đọc header để định vị** (đề phòng đổi thứ tự): build `colIndex[headerName]`.
- Transform:
  - `warranty`: regex lấy số từ "12 Tháng" → `12`.
  - `price`: `parseFloat`, bỏ dấu phẩy/chấm ngăn cách nếu có.
  - `status_text`: trim.
  - `brandSlug`/`cateSlug`: tách segment slug cuối từ URL (vd `.../thuong-hieu/eaton-moeller/` → `eaton-moeller`).
  - `seriesText`, `madeinText`, `specGroupText`: trim text.
  - `alsoBuyLinks`: split `,` → trim → bỏ rỗng.
  - Cột 2 → lưu `detailInstruction` (chỉ dẫn), cột 16 → `specInstruction` (chỉ dẫn) — **chưa gọi AI** ở phase này.
- **Bỏ note/template rows**: nếu giá trị cột 15/16 khớp pattern hướng dẫn ("Nếu có sp mua cùng", "AI tự lấy") hoặc dòng thiếu `title`/`model` → skip, log.

### 2.2 mapping.ts (shared)
- Hằng số map header→field + các helper transform (warranty, price, slugFromUrl) để main + test dùng chung. DRY.

### 2.3 ImageService.match(folder, slug) → string[]
- Quy ước (D4): folder phẳng, file bắt đầu bằng slug. Match `slug` + ranh giới (`slug.` hoặc `slug-`) để tránh slug này dính slug khác (vd `dilmp45-10` vs `dilmp45-100`).
- Sort theo hậu tố số (`-1,-2,...`); phần tử đầu = featured.
- Trả mảng path tuyệt đối; nếu rỗng → push cảnh báo vào `draft.errors` ("thiếu ảnh").
- Hỗ trợ ext: jpg/jpeg/png/webp.

### 2.4 TaxonomyResolver (main, per SiteClient)
- Cần đọc taxonomy từ site đích. **Kiểm tra có endpoint list taxonomy không**; nếu không có API public → 2 lựa chọn:
  - (a) thêm cách lấy qua trang admin/API hiện có, hoặc
  - (b) dựa vào cơ chế `new_*` của `PUT /api/products/:id` (controller tự tạo Tax nếu chưa có) — tạo sản phẩm trước rồi update kèm `new_brand/new_series/...`.
- Hành vi:
  - `resolve(type, slugOrText)` → tìm Tax theo `meta_slug`(brand/cate) hoặc `text`(series/madein/spec_group) + `tax_type` + `tax_for:'product'`.
  - Không thấy → đánh dấu `needCreate` (kèm `meta_slug`, `text`, `meta_title`) để phase 4 tạo qua `new_*`.
- Cache theo site để khỏi gọi lặp.

> ⚠️ Cần verify ở đầu phase: site có API liệt kê taxonomy không (tìm trong `modules/taxonomy/*.api.routes.js`). Nếu không, đi hướng (b) — an toàn vì dùng đúng logic có sẵn của lamha.

### 2.5 Nạp vào Durable Queue
- Tạo `run` mới (site_id, file, image_folder) → `queue.enqueue(run, drafts)`: mỗi draft thành 1 job `stage_a/stage_b = pending`, lưu `draft_json` (đã map + ảnh + tax resolved).
- Từ đây Phase 3/4 chỉ làm việc với queue (không giữ state trong RAM) → resume sau crash.

## Acceptance criteria
- [ ] Parse file mẫu (8 dòng) → 7 `ProductDraft` (bỏ note row đúng), đủ field map.
- [ ] `queue.enqueue` ghi đủ 7 job vào SQLite; restart app vẫn còn nguyên.
- [ ] `warranty=12`, `price=3745000`, `brandSlug='eaton-moeller'`, `cateSlug='contactor-khoi-dong-tu'` đúng.
- [ ] Match ảnh: với 1 folder mẫu, mỗi draft có danh sách ảnh đúng + featured là `-1`.
- [ ] Taxonomy resolve trả id (nếu có) hoặc `needCreate` (nếu chưa có), không crash khi thiếu.

## Files
`electron/main/services/{excel.ts,image.ts,taxonomyResolver.ts}`, `shared/mapping.ts`, test fixtures.
