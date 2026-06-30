// ConfigStore — lưu cấu hình app dạng JSON ở userData/config.json.
// Atomic write (ghi file tmp rồi rename) để không hỏng khi cúp điện giữa lúc ghi.

import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig, SiteTarget } from '@shared/types'

function defaultConfig(): AppConfig {
  return {
    bridgeHost: '127.0.0.1',
    bridgePort: 8765,
    bridgeToken: randomBytes(16).toString('hex'),
    sites: [{ id: 'local', label: 'Local demo', baseUrl: 'http://127.0.0.1:3000', isProd: false }],
    activeSiteId: 'local',
    imageFolder: '',
    throttleMs: 1500,
    autoCreateSpecGroup: true,
    imageProcess: { enabled: true, size: 800, quality: 82, fit: 'contain' },
    detailImageEnabled: true,
    detailImageRequests: [
      'Sơ đồ đấu dây / kết nối của sản phẩm: thể hiện rõ các cực đấu nối, nguồn cấp, tải và thiết bị bảo vệ liên quan.',
      'Sơ đồ nguyên lý hoạt động của sản phẩm: thể hiện các khối chức năng chính và luồng hoạt động giữa chúng.'
    ],
    detailImageTimeoutSec: 300,
    taxMap: {}
  }
}

class ConfigStore {
  private path = ''
  private cache: AppConfig | null = null

  private file(): string {
    if (!this.path) this.path = join(app.getPath('userData'), 'config.json')
    return this.path
  }

  get(): AppConfig {
    if (this.cache) return this.cache
    const f = this.file()
    if (existsSync(f)) {
      try {
        const raw = JSON.parse(readFileSync(f, 'utf-8'))
        this.cache = { ...defaultConfig(), ...raw }
        return this.cache!
      } catch {
        // file hỏng → khôi phục mặc định (giữ file cũ làm .bak)
        try {
          renameSync(f, f + '.bak')
        } catch {
          /* ignore */
        }
      }
    }
    this.cache = defaultConfig()
    this.persist()
    return this.cache
  }

  private persist(): void {
    if (!this.cache) return
    const f = this.file()
    const tmp = f + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf-8')
    renameSync(tmp, f)
  }

  update(partial: Partial<AppConfig>): AppConfig {
    this.cache = { ...this.get(), ...partial }
    this.persist()
    return this.cache
  }

  addSite(site: SiteTarget): AppConfig {
    const cfg = this.get()
    const sites = cfg.sites.filter((s) => s.id !== site.id).concat(site)
    return this.update({ sites })
  }

  removeSite(siteId: string): AppConfig {
    const cfg = this.get()
    const sites = cfg.sites.filter((s) => s.id !== siteId)
    const activeSiteId = cfg.activeSiteId === siteId ? sites[0]?.id ?? '' : cfg.activeSiteId
    return this.update({ sites, activeSiteId })
  }

  setActiveSite(siteId: string): AppConfig {
    return this.update({ activeSiteId: siteId })
  }

  getSite(siteId: string): SiteTarget | undefined {
    return this.get().sites.find((s) => s.id === siteId)
  }
}

export const configStore = new ConfigStore()
