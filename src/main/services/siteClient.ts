// ============================================================================
// SiteClient — client REST của 1 site lamha/thietbicodien, tự xử lý CSRF.
//
// Cơ chế CSRF của lamha (xác minh ở modules/app/helpers/setAppRoutes.js):
//   - csurf({cookie:true}) đặt secret ở cookie `_csrf` trên mọi request.
//   - Cookie `XSRF-TOKEN` (token thực gửi lại qua header) CHỈ được set trong
//     error-handler khi 1 request `/api/` ném lỗi.
//   ⇒ ensureCsrf: bắn 1 "primer" mutate tới path /api/ không tồn tại để cố tình
//     gây EBADCSRFTOKEN → server set cookie XSRF-TOKEN (không đụng dữ liệu thật),
//     rồi đọc token từ cookie jar, gắn header `x-csrf-token` cho POST/PUT/DELETE.
// ============================================================================

import axios, { AxiosInstance } from 'axios'
import { wrapper } from 'axios-cookiejar-support'
import { CookieJar } from 'tough-cookie'
import { createReadStream } from 'node:fs'
import { basename, extname } from 'node:path'
import FormData from 'form-data'
import type { ProductImage, SiteTarget, SitePingResult } from '@shared/types'

/** Đoán content-type theo đuôi tên (filemanager kiểm tra file.type bắt đầu 'image/'). */
const MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}
function mimeOf(name: string): string {
  return MIME[extname(name).toLowerCase()] || 'application/octet-stream'
}
/** Chuẩn hoá path từ server (Windows lưu dấu '\') → URL web dùng '/'. */
function normPath(p: string | undefined): string {
  return (p || '').replace(/\\/g, '/')
}

/** 1 media doc trả từ /api/filemanager. */
interface MediaDoc {
  filename?: string
  original_path?: string
  thumb_path?: string
  is_image?: boolean
  created_at?: string | number
}

/** 1 node taxonomy đọc từ trang admin (window.items_top_level). */
export interface TaxNode {
  _id: string
  text: string
  meta_slug?: string
  tax_type?: string
  children?: TaxNode[]
}

export class SiteClient {
  private http: AxiosInstance
  private jar: CookieJar
  private csrfToken: string | null = null
  private loggedIn = false

  constructor(private site: SiteTarget) {
    this.jar = new CookieJar()
    this.http = wrapper(
      axios.create({
        baseURL: site.baseUrl,
        jar: this.jar,
        withCredentials: true,
        timeout: 60_000,
        // KHÔNG ném khi 4xx ở primer — ta chủ động xử lý status
        validateStatus: () => true,
        headers: site.token ? { Authorization: `Bearer ${site.token}` } : {}
      })
    )
  }

  /** Lấy cookie _csrf + XSRF-TOKEN, ghi nhớ token cho các request mutate. */
  async ensureCsrf(): Promise<void> {
    if (this.csrfToken) return
    // GET '/' để chắc chắn có secret cookie + session.
    await this.http.get('/')
    // Primer: mutate tới path /api/ không tồn tại → server set XSRF-TOKEN, không mutate dữ liệu.
    await this.http.delete('/api/__csrf_prime__').catch(() => undefined)
    this.csrfToken = await this.readXsrfToken()
    if (!this.csrfToken) {
      // fallback: thử GET '/' thêm lần nữa (vài cấu hình set token ở GET)
      await this.http.get('/')
      this.csrfToken = await this.readXsrfToken()
    }
    if (!this.csrfToken) throw new Error('Không lấy được CSRF token từ site (XSRF-TOKEN cookie trống).')
  }

  private async readXsrfToken(): Promise<string | null> {
    const cookies = await this.jar.getCookies(this.site.baseUrl)
    const c = cookies.find((x) => x.key === 'XSRF-TOKEN')
    return c ? decodeURIComponent(c.value) : null
  }

  private mutateHeaders(): Record<string, string> {
    return { 'x-csrf-token': this.csrfToken || '', 'Content-Type': 'application/json; charset=utf-8' }
  }

  /** Phát hiện lỗi CSRF (token hết hạn/sai) để re-prime + thử lại.
   *  Coi mọi 403 là khả năng CSRF — re-prime là vô hại (không mutate dữ liệu). */
  private isCsrfError(res: { status: number }): boolean {
    return res.status === 403
  }

  /** Reset cache token + lấy lại CSRF (gọi khi token hết hạn giữa batch dài). */
  private async refreshCsrf(): Promise<void> {
    this.csrfToken = null
    await this.ensureCsrf()
  }

  // -------------------------------------------------------------- ping (test)

  async ping(): Promise<SitePingResult> {
    try {
      const res = await this.http.get('/')
      await this.ensureCsrf()
      return { ok: res.status >= 200 && res.status < 400, status: res.status, csrfToken: !!this.csrfToken }
    } catch (e) {
      return { ok: false, csrfToken: false, message: (e as Error).message }
    }
  }

  // -------------------------------------------------------------- admin login

  /** Đăng nhập admin để đọc được trang /admin/* (taxonomy list). Idempotent: chỉ login 1 lần.
   *  lamha gác /admin bằng session (req.session.user); /api/* không gác nên việc đăng SP
   *  không cần login — login CHỈ phục vụ auto-map cate/spec_group. */
  async login(): Promise<void> {
    if (this.loggedIn) return
    if (!this.site.username || !this.site.password) {
      throw new Error('Site chưa có tài khoản admin (username/password) để đọc danh mục.')
    }
    await this.ensureCsrf()
    let res = await this.http.post(
      '/api/auth/login/',
      { username: this.site.username, password: this.site.password },
      { headers: this.mutateHeaders() }
    )
    if (this.isCsrfError(res)) {
      await this.refreshCsrf()
      res = await this.http.post(
        '/api/auth/login/',
        { username: this.site.username, password: this.site.password },
        { headers: this.mutateHeaders() }
      )
    }
    const data = (res.data ?? {}) as { success?: boolean; err?: { message?: string } }
    if (!data.success) {
      throw new Error(`Đăng nhập admin thất bại: ${data.err?.message || 'HTTP ' + res.status}`)
    }
    this.loggedIn = true
  }

  /** Đọc cây taxonomy theo tax_type từ trang admin (cần login). Trả về items_top_level đã parse.
   *  Trang nhúng `window.items_top_level = <json>` (JSON 1 dòng, escape `<\/`). */
  async fetchTaxonomyTree(taxType: 'category' | 'spec_group'): Promise<TaxNode[]> {
    await this.login()
    const res = await this.http.get(`/admin/taxonomies?tax_type=${taxType}&tax_for=product`)
    const html = typeof res.data === 'string' ? res.data : ''
    // Bị đá về /login khi mất session → báo lỗi rõ ràng.
    if (res.status >= 300 && res.status < 400) throw new Error('Phiên admin hết hạn (bị chuyển hướng).')
    const m = html.match(/window\.items_top_level\s*=\s*(\[[\s\S]*?\])\s*$/m)
    if (!m) {
      if (/\/login/.test(html) || /name=["']password["']/.test(html)) {
        throw new Error('Không có quyền đọc /admin/taxonomies (chưa đăng nhập đúng).')
      }
      throw new Error(`Không đọc được danh mục ${taxType} từ trang admin.`)
    }
    const json = m[1].replace(/<\\\//g, '</')
    return JSON.parse(json) as TaxNode[]
  }

  // ------------------------------------------------------------------ product

  /** POST /api/products { form } → trả _id sản phẩm tạo. */
  async createProduct(form: Record<string, unknown>): Promise<{ _id: string }> {
    await this.ensureCsrf()
    let res = await this.http.post('/api/products', { form }, { headers: this.mutateHeaders() })
    if (this.isCsrfError(res)) {
      await this.refreshCsrf()
      res = await this.http.post('/api/products', { form }, { headers: this.mutateHeaders() })
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`createProduct thất bại (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`)
    }
    const data = res.data
    if (data?.err) throw new Error(`createProduct lỗi: ${JSON.stringify(data.err).slice(0, 300)}`)
    // crud helper trả { insertedId, doc }
    const id = data?.insertedId || data?.doc?._id || data?._id
    if (!id) throw new Error(`createProduct: không thấy insertedId: ${JSON.stringify(data).slice(0, 300)}`)
    return { _id: String(id) }
  }

  /** PUT /api/products/:id { form, new_* } để cập nhật/upsert + tạo taxonomy mới.
   *  `extra` (new_brand/new_series/new_madein) đặt ở top-level body (controller đọc req.body[new_*]). */
  async updateProduct(id: string, form: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<void> {
    await this.ensureCsrf()
    let res = await this.http.put(`/api/products/${id}`, { form, ...extra }, { headers: this.mutateHeaders() })
    if (this.isCsrfError(res)) {
      await this.refreshCsrf()
      res = await this.http.put(`/api/products/${id}`, { form, ...extra }, { headers: this.mutateHeaders() })
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`updateProduct thất bại (${res.status}): ${JSON.stringify(res.data).slice(0, 300)}`)
    }
    if (res.data?.err) {
      throw new Error(`updateProduct lỗi: ${JSON.stringify(res.data.err).slice(0, 300)}`)
    }
  }

  /** POST /api/taxonomies { form } → tạo taxonomy, trả insertedId. (Không idempotent server-side.) */
  async createTaxonomy(form: { text: string; tax_type: string; tax_for: string }): Promise<string> {
    await this.ensureCsrf()
    const res = await this.http.post('/api/taxonomies', { form, return_doc: true }, { headers: this.mutateHeaders() })
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`createTaxonomy thất bại (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`)
    }
    const id = res.data?.insertedId || res.data?.doc?._id
    if (!id) throw new Error(`createTaxonomy: không thấy insertedId: ${JSON.stringify(res.data).slice(0, 200)}`)
    return String(id)
  }

  /**
   * Upload 1 ảnh qua Media Manager (POST /api/filemanager, target_type='product') — ĐÚNG cơ chế
   * admin lamha dùng. Lưu file + tạo media doc; KHÔNG tự gắn vào product.images (làm ở bước attach).
   * Endpoint cũ /api/upload/product hỏng (helper trả object, controller coi là string → ném lỗi).
   *
   * Lưu ý Windows-local: server có thể trả {err: EBUSY ...} ở bước xoá file tạm NHƯNG media vẫn
   * được tạo + file đã lưu → coi là không-tử (sẽ lấy lại ở listProductImages). Chỉ ném khi lỗi HTTP.
   * Nhận đường dẫn file (stream nguyên trạng) HOẶC buffer đã xử lý (resize/nén webp).
   */
  async uploadProductImage(
    productId: string,
    file: string | { buffer: Buffer; filename: string }
  ): Promise<void> {
    await this.ensureCsrf()
    const isBuf = typeof file !== 'string'
    const filename = isBuf ? file.filename : basename(file)
    const contentType = mimeOf(filename)
    // FormData + stream chỉ dùng được 1 lần → tạo lại mỗi lần gửi (kể cả khi retry CSRF).
    const send = (): Promise<{ status: number; data?: unknown }> => {
      const fd = new FormData()
      fd.append('target_id', productId)
      fd.append('target_type', 'product')
      if (isBuf) fd.append('file', file.buffer, { filename, contentType })
      else fd.append('file', createReadStream(file), { filename, contentType })
      return this.http.post('/api/filemanager', fd, {
        headers: { ...fd.getHeaders(), 'x-csrf-token': this.csrfToken || '' },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      })
    }
    let res = await send()
    if (this.isCsrfError(res)) {
      await this.refreshCsrf()
      res = await send()
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`upload ảnh thất bại (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`)
    }
    // data.err kiểu EBUSY/unlink (dọn file tạm trên Windows) là không-tử — media đã tạo. Bỏ qua.
  }

  /**
   * Upload 1 ảnh sơ đồ (do AI tạo) cho phần mô tả chi tiết rồi TRẢ VỀ URL web để chèn vào HTML.
   * Dùng chung cơ chế filemanager (target_type='product') nên re-roll vẫn dọn được (cùng target_id).
   * Lấy URL bằng cách so sánh danh sách media trước/sau upload (server có thể đổi tên file).
   * Ảnh này KHÔNG được gắn vào product.images (gallery) — Pha A đã set gallery xong trước Pha B.
   */
  async uploadDetailImage(productId: string, buffer: Buffer, filename: string): Promise<string> {
    const before = new Set(await this.listMediaIds(productId))
    await this.uploadProductImage(productId, { buffer, filename })
    const cond = encodeURIComponent(JSON.stringify({ target_id: productId }))
    const res = await this.http.get(`/api/filemanager?cond=${cond}`)
    const list = Array.isArray(res.data) ? (res.data as Array<MediaDoc & { _id?: string }>) : []
    const fresh = list.filter((m) => m._id && !before.has(m._id) && m.original_path)
    const pick = fresh[0] || [...list].reverse().find((m) => m.original_path)
    if (!pick?.original_path) throw new Error('Không lấy được URL ảnh sơ đồ sau khi upload')
    return normPath(pick.original_path)
  }

  /** Xóa hẳn 1 sản phẩm khỏi site. DELETE /api/products/:id (deleteOne theo path param). */
  async deleteProduct(id: string): Promise<void> {
    await this.ensureCsrf()
    let res = await this.http.delete(`/api/products/${id}`, { headers: this.mutateHeaders() })
    if (this.isCsrfError(res)) {
      await this.refreshCsrf()
      res = await this.http.delete(`/api/products/${id}`, { headers: this.mutateHeaders() })
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`xóa sản phẩm thất bại (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`)
    }
    if (res.data?.err) throw new Error(`xóa sản phẩm lỗi: ${JSON.stringify(res.data.err).slice(0, 200)}`)
  }

  /** Lấy _id mọi media gắn với 1 sản phẩm (để re-roll xóa). */
  async listMediaIds(productId: string): Promise<string[]> {
    const cond = encodeURIComponent(JSON.stringify({ target_id: productId }))
    const res = await this.http.get(`/api/filemanager?cond=${cond}`)
    const list = Array.isArray(res.data) ? (res.data as Array<{ _id?: string }>) : []
    return list.map((m) => m._id).filter((x): x is string => !!x)
  }

  /** Xóa media khỏi Media Manager (xóa cả file vật lý + doc). DELETE /api/filemanager?ids[]=...
   *  Controller remove đọc req.query.ids → cần dạng mảng để xóa được file trên đĩa. */
  async deleteMedia(ids: string[]): Promise<void> {
    if (!ids.length) return
    await this.ensureCsrf()
    const qs = new URLSearchParams()
    for (const id of ids) qs.append('ids[]', id)
    const url = `/api/filemanager?${qs.toString()}`
    let res = await this.http.delete(url, { headers: this.mutateHeaders() })
    if (this.isCsrfError(res)) {
      await this.refreshCsrf()
      res = await this.http.delete(url, { headers: this.mutateHeaders() })
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`xóa media thất bại (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`)
    }
  }

  /**
   * Lấy danh sách ảnh đã upload của 1 sản phẩm từ Media Manager (GET /api/filemanager?cond=...).
   * Map về ProductImage (chuẩn hoá '\' → '/'), lọc ảnh, sắp theo created_at tăng dần (đúng thứ tự upload).
   */
  async listProductImages(productId: string): Promise<ProductImage[]> {
    const cond = encodeURIComponent(JSON.stringify({ target_id: productId }))
    const res = await this.http.get(`/api/filemanager?cond=${cond}`)
    const list = Array.isArray(res.data) ? (res.data as MediaDoc[]) : []
    return list
      .filter((m) => m.is_image !== false && m.original_path)
      .sort((a, b) => {
        const ta = a.created_at ? new Date(a.created_at).getTime() : 0
        const tb = b.created_at ? new Date(b.created_at).getTime() : 0
        return ta - tb
      })
      .map((m) => ({ name: m.filename || '', url: normPath(m.original_path), thumb: normPath(m.thumb_path) }))
  }
}
