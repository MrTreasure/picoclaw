import { getLauncherAuthStatus } from "@/api/launcher-auth"
import type { ModelThinkingLevel } from "@/api/models"
import {
  lastAuthenticatedListScope,
  rememberAuthenticatedListScope,
  validCacheScope,
} from "@/hooks/session-list-cache"

// A display hint, never an authentication or authorization token. Do not cache
// the models response: it contains account/provider metadata.
const KEY = "musec137:chat-model-preference-v1"
let verifiedScope: string | null = null
export async function verifyChatModelCacheScope(): Promise<boolean> {
  try {
    const status = await getLauncherAuthStatus()
    if (!status.authenticated || !validCacheScope(status.cache_scope)) {
      clearChatModelPreference()
      return false
    }
    verifiedScope = status.cache_scope
    rememberAuthenticatedListScope(status.cache_scope)
    return true
  } catch {
    // A transient auth-service error must not be confused with a confirmed logout.
    return false
  }
}
interface Snapshot {
  scope: string
  name: string
  thinking: ModelThinkingLevel
}
let inMemory: Snapshot | null = null
const validName = (name: unknown): name is string =>
  typeof name === "string" && name.length > 0 && name.length <= 256
const validThinking = (value: unknown): value is ModelThinkingLevel =>
  value === "off" ||
  value === "low" ||
  value === "medium" ||
  value === "high" ||
  value === "xhigh"

export function readChatModelPreference(): Pick<
  Snapshot,
  "name" | "thinking"
> | null {
  const scope = lastAuthenticatedListScope()
  if (!scope || !validCacheScope(scope)) return null
  if (inMemory?.scope === scope) return inMemory
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) || "null")
    if (!value || typeof value !== "object") return null
    const candidate = value as Partial<Snapshot>
    if (
      candidate.scope !== scope ||
      !validName(candidate.name) ||
      !validThinking(candidate.thinking)
    )
      return null
    inMemory = candidate as Snapshot
    return inMemory
  } catch {
    return null
  }
}

export function rememberChatModelPreference(
  name: string,
  thinking: ModelThinkingLevel,
): void {
  const scope = verifiedScope ?? lastAuthenticatedListScope()
  if (
    !scope ||
    !validCacheScope(scope) ||
    !validName(name) ||
    !validThinking(thinking)
  )
    return
  const snapshot: Snapshot = { scope, name, thinking }
  inMemory = snapshot
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot))
  } catch {
    /* private mode */
  }
}

export function clearChatModelPreference(): void {
  inMemory = null
  verifiedScope = null
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* private mode */
  }
}
