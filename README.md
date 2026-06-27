# Lamha Importer

App desktop (Windows) đăng **sản phẩm hàng loạt** từ file Excel mẫu lên các website họ
lamha (lamha / thietbicodien / bietthubienvip / phumytoan — cùng source + thiết kế DB).
Nội dung mô tả & thông số kỹ thuật được sinh tự động qua **GPT Bridge nhúng** (kết nối addon
trình duyệt điều khiển ChatGPT).

## Tính năng chính

- Đọc Excel mẫu (`FILE MẪU UP WEB HÀNG LOẠT AI …`), map cột → trường sản phẩm.
- Tự **match ảnh** trong 1 thư mục phẳng theo tiền tố slug (ảnh đầu = featured).
- **2 pha** (không cờ ẩn — frontend lamha không lọc `is_hidden`):
  - **Pha A** — đăng *khung* sản phẩm hiển thị ngay (tiêu đề, giá, BH, ảnh, taxonomy).
  - **Pha B** — sinh **mô tả (HTML)** + **thông số (JSON)** bằng AI rồi cập nhật bổ sung.
- **Hàng đợi bền (SQLite/WAL)** — sống sót crash/cúp điện, **resume idempotent**.
- **Cổng duyệt tay** tùy chọn: xem/sửa nội dung AI trước khi đăng.
- Đăng qua **REST API có sẵn của lamha** (không ghi thẳng MongoDB), tự xử lý CSRF.
- Chọn **site đích** (nhiều cấu hình), test kết nối.
- Giao diện **tối**, màu thương hiệu `#1c6d66`, logo trắng lamha.

## Kiến trúc

```
Electron main
├─ EmbeddedBridge   (WS hub /ws :8765 + queue + pump)  ← addon trình duyệt nối vào
├─ QueueStore       (better-sqlite3, 2-phase state machine)
├─ SiteClient       (axios + cookie jar, CSRF, REST lamha)
├─ Stage A / B      (pipeline đăng khung / enrich AI)
└─ IPC  ──(preload window.api)──►  Renderer (React + Ant Design)
                                    Settings / Import / Review
```

GPT Bridge được **port sang TypeScript** từ `Add-On GPT/server` và chạy **trong tiến trình
Electron** — không cần `node server.js` riêng. Chỉ cần bật addon trên trình duyệt và mở tab
ChatGPT đã đăng nhập; addon nối tới `ws://127.0.0.1:8765/ws?token=<token>` (token đặt trong
**Cài đặt**, phải khớp cấu hình addon).

## Phát triển

```bash
npm install          # cài deps (postinstall sẽ rebuild better-sqlite3 cho Electron)
npm run dev          # chạy dev (electron-vite)
npm run typecheck    # kiểm tra kiểu (node + web)
npm run build        # build production vào ./out
npm run dist         # đóng gói installer .exe (NSIS) vào ./dist
```

> Nếu `better-sqlite3` lỗi ABI sau khi đổi phiên bản Electron: chạy lại
> `npx electron-builder install-app-deps` (đã gắn ở `postinstall`).

## Quy trình dùng

1. **Cài đặt** → thêm site đích (id/label/baseUrl), đặt **token bridge** trùng addon, bấm
   **Test** để kiểm tra kết nối + CSRF. (Tùy chọn) bật **cổng duyệt tay**.
2. **Nhập & Đăng** → chọn site, chọn **Excel** + **thư mục ảnh** → **Đọc & xem trước**.
   Kiểm tra cảnh báo (thiếu ảnh / taxonomy chưa map) → **Đưa vào hàng đợi**.
3. **Chạy Pha A** — đăng khung sản phẩm (hiển thị ngay trên web).
4. **Chạy Pha B (AI)** — sinh nội dung. Nếu bật cổng duyệt, sang **Duyệt nội dung** để
   xem/sửa rồi **Duyệt**; sau đó bấm **Đăng nội dung đã duyệt**.

## Lưu ý taxonomy

- `brand` / `series` / `madein` → tạo-hoặc-resolve **idempotent** phía server qua `new_*` khi
  PUT sản phẩm.
- `category` / `spec_group` **không** auto-create qua `new_*` và lamha không có API GET list →
  cần **map sẵn** trong Cài đặt (`taxMap[siteId]`) một lần, hoặc tạo thủ công trên site.

## Bảo mật / vận hành

- Bridge là tự động hoá phiên cá nhân (ChatGPT). Dùng điều độ, tránh spam, lưu ý ToS.
- Đổi **token bridge** mặc định trước khi mở cổng ra ngoài máy.
- Khi chạy với **site PROD** (cờ đỏ), kiểm tra kỹ preview trước khi đăng hàng loạt.
