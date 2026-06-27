# Phase 3 — PHA A: Upload khung sản phẩm (visible, không cần AI)

**Mục tiêu:** Tạo **toàn bộ** sản phẩm trên site đích với field cấu trúc + ảnh, hiển thị ngay (không cờ ẩn — D7). Mỗi bước checkpoint vào durable queue để resume sau crash.

> Pha này **không gọi AI**. `detail`/`attributes` để trống/placeholder, sẽ bổ sung ở Pha B (Phase 4).

## Tasks

### 3.1 Build form payload Pha A (draft → req.body.form)
- Map field cấu trúc: `title, price, status_text, warranty, model, manual, brand, cate, series, madein, spec_group`.
- `detail`: để rỗng hoặc `desc` tạm từ title (R10) — tránh trang trống trơn.
- Taxonomy: id đã resolve (phase 2); nếu `needCreate` → dùng cơ chế `new_*` của `PUT /api/products/:id` sau khi tạo, hoặc tạo Tax trước qua resolver. Ghi lại id vào draft.

### 3.2 SiteClient.createProduct (idempotent)
```
job.stage_a: pending → creating  (checkpoint)
if job.product_id exists: bỏ qua tạo (đã tạo lần trước)
else:
   existing = findExisting(brandId, model)   // phòng trùng từ lần chạy trước
   product_id = existing ?? POST /api/products {form}
   markStageA(id, { product_id, stage_a:'created' })   (checkpoint NGAY sau khi có id)
```
- `findExisting`: ưu tiên tra **durable queue** (sổ local theo `site_id+model`); nếu cần chắc chắn → query site theo `meta_slug` (kiểm có endpoint; nếu không, dựa local store là đủ cho idempotent).

### 3.3 Upload ảnh (từng ảnh = 1 checkpoint)
```
job.stage_a: created → images
for i, img in draft.imageFiles (sort -1,-2,...):
   if i < job.images_done: continue          // đã upload ở lần trước → bỏ qua
   POST /api/upload/product (file=img, target_id=product_id)
   markStageA(id, { images_done: i+1 })       // checkpoint từng ảnh
set featured_image = ảnh -1 (PUT product)
markStageA(id, { stage_a:'done' })
```
- Upload tuần tự (server `sharp` resize, tránh nặng). Lỗi 1 ảnh → `stage_a:'error'` + `last_error`, retry được từ `images_done`.

### 3.4 Runner Pha A
- `runStageA({onProgress, signal})`: lặp `queue.nextStageA()` đến hết; phát progress; cho **Hủy** (dừng sạch, trạng thái đã checkpoint).
- Không phụ thuộc Bridge → có thể chạy nhanh, nhiều SP.

## Acceptance criteria
- [ ] Chạy file mẫu → toàn bộ SP xuất hiện ở `/admin/products` + frontend, có tên/giá/brand/cate/ảnh/featured.
- [ ] Kill app giữa lúc upload ảnh → mở lại tiếp tục đúng từ ảnh dở, không tạo SP trùng, không up lại ảnh đã có.
- [ ] Taxonomy thiếu được tạo đúng `tax_type/tax_for`, ref đúng id.
- [ ] `findExisting` chặn trùng khi chạy lại cả batch.

## Files
`electron/main/services/{siteClient.ts (mở rộng), stageA.ts}`.

## Verify trước khi code
- Thử thủ công 1 lần bằng Node/curl: lấy CSRF → `POST /api/products {form}` tối thiểu → `POST /api/upload/product` → kiểm DB. Chốt đúng định dạng trước khi build runner.
- Đọc `config/upload.js` (`type='product'`) xem `size/thumb` server tạo.
