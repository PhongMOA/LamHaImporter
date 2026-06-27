# Phase 5 — UI review + chạy hàng loạt + đóng gói

**Mục tiêu:** Giao diện hoàn chỉnh: import → review/sửa → chọn site → chạy batch với tiến độ & log lỗi; đóng gói `.exe`. Theme **dark mode + brand `#1c6d66`** (D9).

## Tasks

### 5.0 Design system — Dark mode + brand (D9) ⭐
Logo `https://lamha.vn/public/assets/img/logo_white.png` **chỉ có màu trắng** ⇒ toàn app dùng **dark mode** để logo luôn nổi. Màu chủ đạo **`#1c6d66`**.

**AntD theme (ConfigProvider ở root):**
```tsx
import { ConfigProvider, theme } from 'antd';

const tokens = {
  colorPrimary: '#1c6d66',     // brand — nút chính, link, active
  colorInfo:    '#1c6d66',
  borderRadius: 8,
};
<ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: tokens }}>
  <App />
</ConfigProvider>
```

**Palette dark mode (đề xuất, dẫn xuất từ `#1c6d66`):**
| Vai trò | Mã màu | Dùng cho |
|---|---|---|
| Brand / Primary | `#1c6d66` | nút chính, tab active, progress, link |
| Primary hover | `#258b81` | hover nút/link |
| Primary active | `#14534e` | trạng thái nhấn |
| Brand subtle (bg) | `rgba(28,109,102,.15)` | nền tag/badge/row được chọn |
| App background | `#0f1513` | nền tối hơi ngả teal (sidebar/header) |
| Surface / Card | `#141a19` → AntD `colorBgContainer` | bảng, modal, card |
| Border | `#26302e` | viền nhạt trên nền tối |
| Text primary | `rgba(255,255,255,.88)` | chữ chính |
| Text secondary | `rgba(255,255,255,.55)` | chữ phụ/label |
| Success / Warn / Error | AntD dark mặc định | status SP (done/cảnh báo/lỗi) |

> Có thể set `colorBgLayout:'#0f1513'`, `colorBgContainer:'#141a19'` trong token để nền ngả nhẹ về tông brand thay vì xám trung tính.

**Logo & branding:**
- **Bundle nội bộ**: tải `logo_white.png` về `src/assets/logo_white.png` (app chạy offline; không phụ thuộc lamha.vn online).
- Đặt logo ở **header/sidebar trên nền tối** (`#0f1513`), cao ~28–32px.
- Favicon/app icon: dùng logo trắng đặt trên ô nền brand `#1c6d66` (vì PNG trắng trên nền trắng sẽ mất).

**Quy ước:**
- Mọi nút hành động chính (Đẩy lên, Sinh AI, Tiếp tục) = `type="primary"` (tự lấy `#1c6d66`).
- Badge **PROD** (D7/R7) vẫn dùng **đỏ** (cảnh báo), không dùng brand color — để nổi bật khác biệt.
- Field thiếu/lỗi: viền/nhãn **đỏ-warning**, không trùng brand.

### 5.1 Màn Import
- Chọn file Excel + folder ảnh (`dialog.showOpenDialog`).
- Hiện summary: số SP, số note row bị bỏ, số SP thiếu ảnh, taxonomy cần tạo.

### 5.2 Bảng review (AntD Table)
- Cột: Tên, Model, Brand, Cate, Giá, #Ảnh, AI status, Publish status.
- **Tô đỏ** field thiếu / lỗi (thiếu ảnh, taxonomy needCreate, AI error).
- Row expand: xem/sửa `detail` (rich text/HTML editor) + bảng `attributes` (sửa title/value, thêm/xóa dòng) + preview ảnh.
- Thao tác từng dòng: "Sinh AI lại", "Đẩy lên", "Bỏ qua".

### 5.3 Site selector + xác nhận
- Dropdown chọn site đích (từ ConfigStore). Badge **đỏ "PROD"** nếu `isProd`.
- Trước batch publish → modal xác nhận: "Đăng N sản phẩm lên **<label site>** (<baseUrl>)?". Bắt buộc xác nhận khi prod.

### 5.4 BatchOrchestrator (main) + tiến độ — 2 pha
- **Pha A "Upload khung"** (`runStageA`): tạo SP + ảnh, tuần tự/nhanh, progress đếm done/error theo `stage_a`, cho **Hủy**.
- **Pha B "Enrich AI"** (`runStageB`): sinh detail+attributes → (review nếu bật) → upsert, tuần tự, progress theo `stage_b`.
- Cho phép chạy Pha A xong rồi Pha B, hoặc nối tiếp tự động. Progress đọc từ `queue.stats(runId)` (không giữ state RAM).
- Event tiến độ qua IPC → renderer realtime. Panel **log lỗi** theo SP (xem lại, **retry riêng** SP lỗi).

### 5.5 Resume sau crash/cúp điện
- Khởi động app → `recoverOnStartup()` + liệt kê các `run` dở; nút **"Tiếp tục"** chạy lại từ trạng thái queue (bỏ qua job đã `done`).
- Hiển thị rõ: đã tạo bao nhiêu, đã enrich bao nhiêu, còn lại gì.

### 5.6 Đóng gói
- `electron-builder` → installer Windows (`.exe`).
- README ngắn: **không cần chạy server Bridge rời** (đã nhúng trong app) — chỉ cần **bật addon + mở tab ChatGPT login** (dán token/port app cấp vào options extension) + local site (`node server.js`).

## Acceptance criteria
- [ ] Mở file mẫu → review 7 SP, sửa tay được detail/attributes.
- [ ] Chọn site, xác nhận, chạy batch: Pha A (upload khung) → Pha B (enrich AI); progress + log chạy đúng.
- [ ] SP lỗi hiển thị rõ, retry riêng được; SP done bị bỏ qua khi chạy lại.
- [ ] Tắt app/cúp điện giữa batch → mở lại "Tiếp tục" chạy đúng phần dở (cả Pha A lẫn Pha B).
- [ ] Build ra `.exe` cài và chạy được trên máy khác (có Bridge + site).

## Files
`src/pages/{ImportPage,ReviewPage,SettingsPage}.tsx`, `src/components/{ProductTable,DetailEditor,AttributesEditor,BatchProgress,ErrorLog}.tsx`, `electron/main/services/orchestrator.ts`.

## Ngoài phạm vi (YAGNI)
- Đa luồng AI (Bridge vốn tuần tự).
- Quản lý user/đăng nhập admin (API không cần).
- Sinh ảnh bằng AI (ảnh đã có sẵn).
