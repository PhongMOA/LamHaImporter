// ImageService — match ảnh local theo slug (D4: folder phẳng, tên file bắt đầu bằng slug).
// Quét cả thư mục con (đệ quy giới hạn độ sâu) để chịu được trường hợp folder bị lồng
// (vd giải nén ra Desktop\DILMP45-10\DILMP45-10) — người dùng trỏ folder ngoài vẫn khớp.

import { readdirSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
import sharp from 'sharp'
import type { ImageProcessConfig } from '@shared/types'

/** Quét đệ quy lấy tên file (relative-free: trả path tuyệt đối) tới độ sâu maxDepth. */
function collectFiles(folder: string, maxDepth = 3): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (depth < maxDepth) walk(full, depth + 1)
      } else if (e.isFile()) {
        out.push(full)
      }
    }
  }
  walk(folder, 0)
  return out
}

const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.jfif', '.gif', '.bmp', '.avif'])
// Đuôi chắc chắn KHÔNG phải ảnh → loại (tránh quét nhầm file phụ lẫn trong folder).
const NON_IMG_EXTS = new Set([
  '.txt', '.csv', '.xlsx', '.xls', '.doc', '.docx', '.pdf', '.zip', '.rar',
  '.json', '.db', '.ini', '.md', '.html', '.url', '.lnk'
])

/**
 * File có phải ứng viên ảnh không. Tên ảnh trong Excel KHÔNG có đuôi nên file trên
 * đĩa cũng có thể bị xuất ra dạng trần (không đuôi) → vẫn coi là ảnh. Chỉ loại các
 * đuôi rõ ràng không phải ảnh.
 */
function isImageCandidate(ext: string): boolean {
  if (ext === '') return true // không đuôi → coi là ảnh (folder ảnh phẳng)
  if (IMG_EXTS.has(ext)) return true
  return false
}

/**
 * Trả danh sách path tuyệt đối các ảnh khớp slug, sort theo hậu tố số (-1,-2,...).
 * Match ranh giới (slug. hoặc slug-) để tránh slug này dính slug khác
 * (vd dilmp45-10 vs dilmp45-100). Khớp bỏ qua đuôi: file có đuôi ảnh hợp lệ HOẶC
 * không đuôi đều được xét (tên ảnh Excel không kèm đuôi).
 */
export function matchImages(folder: string, slug: string): string[] {
  if (!slug) return []
  const files = collectFiles(folder) // path tuyệt đối, đã gồm thư mục con

  const slugLower = slug.toLowerCase()
  const matched = files.filter((f) => {
    const ext = extname(f).toLowerCase()
    if (NON_IMG_EXTS.has(ext)) return false
    if (!isImageCandidate(ext)) return false
    const name = basename(f, ext).toLowerCase()
    // ranh giới: trùng hệt slug, hoặc slug + '-' + phần còn lại
    return name === slugLower || name.startsWith(slugLower + '-')
  })

  matched.sort((a, b) => suffixNum(a, slugLower) - suffixNum(b, slugLower))
  return matched // đã là path tuyệt đối
}

/** Lấy số hậu tố sau "slug-": slug-2.jpg → 2; slug.jpg → 0. */
function suffixNum(file: string, slugLower: string): number {
  const name = basename(file, extname(file)).toLowerCase()
  if (name === slugLower) return 0
  const rest = name.slice(slugLower.length + 1) // bỏ "slug-"
  const m = rest.match(/^(\d+)/)
  return m ? Number(m[1]) : 9999
}

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 }

/**
 * Xử lý 1 ảnh trước khi upload: đưa về size×size rồi nén webp.
 * - fit 'contain': thu cả ảnh vừa khung, phần thừa chèn nền trắng (không cắt mất sản phẩm).
 * - fit 'cover':   phóng phủ kín khung rồi cắt giữa (đầy khung, có thể cắt mép).
 * Tôn trọng EXIF orientation; ảnh trong suốt (png) được flatten nền trắng.
 * Trả buffer webp + tên file đổi sang .webp (giữ nguyên phần slug).
 */
export async function processImage(
  filePath: string,
  cfg: ImageProcessConfig
): Promise<{ buffer: Buffer; filename: string }> {
  const buffer = await sharp(filePath, { failOn: 'none' })
    .rotate() // áp EXIF orientation trước khi resize
    .resize(cfg.size, cfg.size, { fit: cfg.fit, background: WHITE })
    .flatten({ background: WHITE }) // bỏ kênh alpha → nền trắng
    .webp({ quality: cfg.quality })
    .toBuffer()
  const base = basename(filePath, extname(filePath))
  return { buffer, filename: `${base}.webp` }
}

// Giới hạn cạnh dài tối đa cho ảnh nội dung (sơ đồ AI vẽ) — đủ nét trong bài, không phình dung lượng.
const DETAIL_MAX_DIM = 1200

/**
 * Tối ưu ảnh NỘI DUNG (ảnh AI vẽ chèn trong mô tả) trước khi upload: nén + chuyển webp.
 * Khác processImage: KHÔNG ép ô vuông — sơ đồ là ảnh ngang, chỉ thu trong khung
 * DETAIL_MAX_DIM × DETAIL_MAX_DIM giữ nguyên tỉ lệ (không phóng to ảnh nhỏ).
 * Nhận buffer (ảnh base64 do AI trả). Trả buffer webp + đuôi 'webp'.
 */
export async function processDetailImageBuffer(
  input: Buffer,
  cfg: ImageProcessConfig
): Promise<{ buffer: Buffer; ext: 'webp' }> {
  const buffer = await sharp(input, { failOn: 'none' })
    .rotate() // áp EXIF orientation trước khi resize
    .resize(DETAIL_MAX_DIM, DETAIL_MAX_DIM, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: WHITE }) // sơ đồ nền trắng → bỏ alpha cho nhẹ
    .webp({ quality: cfg.quality })
    .toBuffer()
  return { buffer, ext: 'webp' }
}
