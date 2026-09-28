import { clearCodexHistoryCache } from "@/features/codex/history-cache"
import {
  invalidateCodexSessionListCache,
  invalidateSessionListCache,
  lastAuthenticatedListScope,
} from "@/hooks/session-list-cache"

import { clearLocalChatCache } from "./local-cache"

export type StorageCategory = "pico" | "codex" | "lists" | "titles"
export interface StorageInfo {
  count: number
  bytes: number
  updated?: number
}
export async function inspectDatabase(
  name: string,
  store: string,
  accept: (value: Record<string, unknown>) => boolean = () => true,
): Promise<StorageInfo> {
  if (!globalThis.indexedDB) return { count: 0, bytes: 0 }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name)
    req.onupgradeneeded = () => req.transaction?.abort()
    req.onerror = () =>
      req.error?.name === "AbortError"
        ? resolve({ count: 0, bytes: 0 })
        : reject(req.error)
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(store)) {
        db.close()
        resolve({ count: 0, bytes: 0 })
        return
      }
      const info: StorageInfo = { count: 0, bytes: 0 }
      const tx = db.transaction(store, "readonly")
      const cursor = tx.objectStore(store).openCursor()
      cursor.onsuccess = () => {
        const row = cursor.result
        if (!row) return
        if (accept(row.value)) {
          info.count++
          info.bytes += new TextEncoder().encode(
            JSON.stringify(row.value),
          ).length
          if (typeof row.value.savedAt === "number")
            info.updated = Math.max(info.updated || 0, row.value.savedAt)
        }
        row.continue()
      }
      tx.oncomplete = () => {
        db.close()
        resolve(info)
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
      tx.onabort = () => {
        db.close()
        reject(tx.error)
      }
    }
  })
}
function titleKeys(scope: string) {
  const prefix = "musec137:codex-title:" + encodeURIComponent(scope) + ":"
  return Object.keys(localStorage).filter((key) => key.startsWith(prefix))
}
export async function storageOverview(): Promise<
  Record<StorageCategory, StorageInfo>
> {
  const scope = lastAuthenticatedListScope()
  const [pico, codex, lists] = await Promise.all([
    inspectDatabase("musec137-chat", "sessions"),
    inspectDatabase(
      "musec137-codex-history",
      "threads",
      (v) => !!scope && v.scope === scope,
    ),
    inspectDatabase(
      "musec137-session-list",
      "summaries",
      (v) => !!scope && (v.id === scope || v.id === "codex:" + scope),
    ),
  ])
  const keys = scope ? titleKeys(scope) : []
  return {
    pico,
    codex,
    lists,
    titles: {
      count: keys.length,
      bytes: keys.reduce(
        (n, key) =>
          n + new TextEncoder().encode(localStorage.getItem(key) || "").length,
        0,
      ),
    },
  }
}
export async function clearStorageCategory(category: StorageCategory) {
  const scope = lastAuthenticatedListScope()
  if (category === "pico") return clearLocalChatCache()
  if (!scope) throw new Error("请联网确认登录状态后重试")
  if (category === "codex") return clearCodexHistoryCache(scope)
  if (category === "lists") {
    await invalidateSessionListCache(scope)
    return invalidateCodexSessionListCache(scope)
  }
  for (const key of titleKeys(scope)) localStorage.removeItem(key)
  window.dispatchEvent(new StorageEvent("storage", { key: null }))
}
