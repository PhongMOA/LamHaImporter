// diagnostics.ts — lưu chẩn đoán lỗi extension (ảnh chụp tab + DOM) ra userData/diagnostics.
// Dùng khi extension không tìm thấy ô nhập ChatGPT (UI đổi / chưa login / modal che) để
// có sẵn file mở ra xem + gửi cho dev cập nhật selector.

import { app } from 'electron'
import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const KEEP_FILES = 60 // ~20 lần lỗi × (jpg + json + html)

export function diagnosticsDir(): string {
  return join(app.getPath('userData'), 'diagnostics')
}

/** Lưu ảnh chụp (dataURL JPEG/PNG) + chẩn đoán DOM. Trả về đường dẫn đã ghi (bỏ qua phần lỗi). */
export function saveExtensionDiagnostics(
  jobId: string,
  diag: unknown,
  screenshot: string | null | undefined
): { screenshot?: string; json?: string; html?: string } {
  const out: { screenshot?: string; json?: string; html?: string } = {}
  try {
    const dir = diagnosticsDir()
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const base = join(dir, `${stamp}_${jobId.slice(0, 8)}`)

    if (typeof screenshot === 'string') {
      const m = screenshot.match(/^data:image\/(jpeg|png);base64,(.+)$/)
      if (m) {
        out.screenshot = `${base}.${m[1] === 'png' ? 'png' : 'jpg'}`
        writeFileSync(out.screenshot, Buffer.from(m[2], 'base64'))
      }
    }
    if (diag && typeof diag === 'object') {
      // HTML tách file riêng để JSON gọn, mở được bằng trình duyệt/editor.
      const { html, ...rest } = diag as { html?: unknown }
      if (typeof html === 'string' && html) {
        out.html = `${base}.html`
        writeFileSync(out.html, html, 'utf8')
      }
      out.json = `${base}.json`
      writeFileSync(out.json, JSON.stringify(rest, null, 2), 'utf8')
    }
    prune(dir)
  } catch (e) {
    console.warn('[diagnostics] lưu chẩn đoán lỗi:', (e as Error).message)
  }
  return out
}

function prune(dir: string): void {
  const files = readdirSync(dir)
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  for (const { f } of files.slice(KEEP_FILES)) {
    try {
      unlinkSync(join(dir, f))
    } catch {
      /* bỏ qua */
    }
  }
}
