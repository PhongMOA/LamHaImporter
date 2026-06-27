// Tạo icon.ico (đa kích thước) + icon.png 256 từ logo nguồn, bằng sharp.
import sharp from 'sharp'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const srcPath = join(dir, 'logo-src.png')

// Pad logo về vuông trên nền trong suốt, theo từng kích thước icon.
async function square(size) {
  return sharp(srcPath)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer()
}

const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = await Promise.all(sizes.map((s) => square(s)))

// PNG 256 dùng cho Linux/BrowserWindow.
writeFileSync(join(dir, 'icon.png'), pngs[sizes.indexOf(256)])

// Ghép ICO: mỗi entry nhúng nguyên khối PNG (Windows Vista+ hỗ trợ).
const count = sizes.length
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type = icon
header.writeUInt16LE(count, 4)

const entries = []
let offset = 6 + count * 16
for (let i = 0; i < count; i++) {
  const size = sizes[i]
  const data = pngs[i]
  const e = Buffer.alloc(16)
  e.writeUInt8(size >= 256 ? 0 : size, 0) // width (0 = 256)
  e.writeUInt8(size >= 256 ? 0 : size, 1) // height
  e.writeUInt8(0, 2) // palette
  e.writeUInt8(0, 3) // reserved
  e.writeUInt16LE(1, 4) // color planes
  e.writeUInt16LE(32, 6) // bits per pixel
  e.writeUInt32LE(data.length, 8)
  e.writeUInt32LE(offset, 12)
  entries.push(e)
  offset += data.length
}

const ico = Buffer.concat([header, ...entries, ...pngs])
writeFileSync(join(dir, 'icon.ico'), ico)
console.log('Đã tạo icon.ico (' + ico.length + ' bytes) và icon.png')
