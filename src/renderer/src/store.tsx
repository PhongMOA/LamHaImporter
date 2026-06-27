// Store nhẹ (Context) — config + bridge health + run đang chọn. Không thêm lib.

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import type { AppConfig, BridgeHealth } from '@shared/types'

interface Store {
  config: AppConfig | null
  health: BridgeHealth | null
  activeRunId: string | null
  setActiveRunId: (id: string | null) => void
  reloadConfig: () => Promise<void>
  saveConfig: (partial: Partial<AppConfig>) => Promise<void>
}

const Ctx = createContext<Store | null>(null)

export function StoreProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [health, setHealth] = useState<BridgeHealth | null>(null)
  const [activeRunId, setActiveRunId] = useState<string | null>(null)

  const reloadConfig = useCallback(async () => {
    setConfig(await window.api.config.get())
  }, [])

  const saveConfig = useCallback(async (partial: Partial<AppConfig>) => {
    setConfig(await window.api.config.update(partial))
  }, [])

  useEffect(() => {
    reloadConfig()
    window.api.bridge.health().then(setHealth)
    const offStatus = window.api.on.bridgeStatus(setHealth)
    const t = setInterval(() => window.api.bridge.health().then(setHealth), 5000)
    return () => {
      offStatus()
      clearInterval(t)
    }
  }, [reloadConfig])

  return (
    <Ctx.Provider value={{ config, health, activeRunId, setActiveRunId, reloadConfig, saveConfig }}>
      {children}
    </Ctx.Provider>
  )
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore phải nằm trong StoreProvider')
  return s
}
