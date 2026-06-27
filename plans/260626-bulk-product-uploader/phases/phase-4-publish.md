# Phase 4 — PHA B: Enrich nội dung AI + upsert (durable, resumable)

**Mục tiêu:** Với từng SP đã tạo ở Pha A, gọi Bridge sinh `detail` (HTML) + `attributes` (JSON), cho duyệt/sửa, rồi `PUT` upsert bổ sung. Tuần tự, throttle, retry, resume qua queue.

## Tasks

### 4.1 Prompt builders (shared/prompts.ts)
- `buildDetailPrompt(draft)`: ghép chỉ dẫn cột 2 + ngữ cảnh (`title, model, brandSlug`, link cột 3). Yêu cầu: tiếng Việt, trả **HTML** sạch, **bọc ```html** (để `extract`). Bám mục: giới thiệu nguồn gốc → ưu điểm/tính năng → chức năng/nguyên lý → mua ở đâu.
- `buildSpecPrompt(draft)`: từ chỉ dẫn cột 16 — yêu cầu trả **JSON** `[{ "title": "...", "value": "..." }]` 10–15 dòng, **bọc ```json**, cấm lời dẫn.

### 4.2 Bridge generate (mỗi SP 1 conversation)
```
job.stage_b: pending → generating  (checkpoint)
health() → nếu extension chưa sẵn sàng: dừng runner, báo user.
detail = ask(buildDetailPrompt, { newChat:true, extract:{type:'code',lang:'html'} })
       → conversation_id lưu lại
specs  = ask(buildSpecPrompt,  { conversationId, extract:{type:'code',lang:'json'} })
       → JSON.parse(answer); lỗi → thử rawAnswer; vẫn lỗi → attributes=[], last_error
markStageB(id, { detail, attributes_json, conversation_id, stage_b:'content' })  (checkpoint)
```
- Validate attributes: phần tử có `title`&`value` string; loại rỗng; cảnh báo <5 dòng.
- Retry khi `error/timeout`: backoff 3 lần (2s/5s/10s); `429` đọc `retryAfterMs`. Tăng `attempts`.
- Throttle giữa các SP (mặc định 1.5s) né rate-limit ChatGPT Plus.

### 4.3 Human review gate (tùy chọn bật/tắt)
- Nếu bật: SP ở `stage_b:'content'` chờ user duyệt (sửa detail/attributes trong UI) → set `reviewed=1` mới upsert.
- Nếu tắt (chạy tự động): bỏ qua gate, upsert thẳng.

### 4.4 Upsert bổ sung (PUT)
```
job.stage_b: content → enriched
PUT /api/products/:product_id  { form: { detail, attributes } (+ new_* nếu còn tax thiếu) }
markStageB(id, { stage_b:'done' })  (checkpoint)
```
- Chỉ gửi field cần bổ sung (detail, attributes) để không đụng field Pha A đã set.
- Lỗi → `stage_b:'error'` + `last_error`, retry từ bước phù hợp (đã có `detail` thì không sinh lại, chỉ PUT lại).

### 4.5 Runner Pha B
- `runStageB({onProgress, signal})`: lặp `queue.nextStageB()` (SP `stage_a=done`); tuần tự (Bridge vốn 1 job/lần); progress + Hủy + resume.
- `recoverOnStartup` đã đưa job `generating` dở về `pending` → chạy lại sinh lại (idempotent ở mức 1 SP).

## Acceptance criteria
- [ ] 1 SP mẫu: sau Pha B có `detail` HTML hợp lệ + `attributes` ≥10 dòng trên web.
- [ ] JSON hỏng → không crash, vào `error` + giữ `rawAnswer` để sửa tay; SP vẫn còn khung Pha A.
- [ ] Mất kết nối extension giữa chừng → runner dừng sạch, resume đúng SP dở.
- [ ] Kill app giữa Pha B → mở lại tiếp tục, không upsert trùng, không sinh lại SP đã `done`.

## Files
`electron/main/services/{embeddedBridge.ts (dùng lại từ phase-1), stageB.ts, contentValidator.ts}`, `shared/prompts.ts`.

## Lưu ý
- Hub nhúng **1 job/lần**: không song song nhiều SP.
- Ảnh AI (DALL·E) **ngoài phạm vi** — ảnh đã có sẵn trên máy (Pha A).
