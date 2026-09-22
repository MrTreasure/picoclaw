import type { ChatMessage } from "@/store/chat"

const DATABASE_NAME = "musec137-chat"
const DATABASE_VERSION = 1
const SESSION_STORE = "sessions"
const MAX_CACHED_MESSAGES = 600
const MAX_INLINE_ATTACHMENT_LENGTH = 512 * 1024

export interface CachedChatSession {
  id: string
  messages: ChatMessage[]
  hasMore: boolean
  nextBefore: number | null
  updatedAt: number
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (!("indexedDB" in globalThis)) return Promise.resolve(null)

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        database.createObjectStore(SESSION_STORE, { keyPath: "id" })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function cacheSafeMessage(message: ChatMessage): ChatMessage {
  const {
    attachments: sourceAttachments,
    streaming: _streaming,
    ...rest
  } = message
  void _streaming
  const attachments = sourceAttachments?.filter(
    (attachment) =>
      !attachment.url.startsWith("data:") ||
      attachment.url.length <= MAX_INLINE_ATTACHMENT_LENGTH,
  )
  return {
    ...rest,
    ...(attachments?.length ? { attachments } : {}),
  }
}

export function mergeCachedMessages(
  cached: ChatMessage[],
  current: ChatMessage[],
): ChatMessage[] {
  const byID = new Map<string, ChatMessage>()
  for (const message of cached) byID.set(message.id, message)
  for (const message of current) byID.set(message.id, cacheSafeMessage(message))
  return [...byID.values()]
    .sort((left, right) => {
      const leftTime = new Date(left.timestamp).getTime()
      const rightTime = new Date(right.timestamp).getTime()
      return (
        (Number.isFinite(leftTime) ? leftTime : 0) -
        (Number.isFinite(rightTime) ? rightTime : 0)
      )
    })
    .slice(-MAX_CACHED_MESSAGES)
}

export async function loadCachedSession(
  id: string,
): Promise<CachedChatSession | null> {
  try {
    const database = await openDatabase()
    if (!database) return null
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(SESSION_STORE, "readonly")
      const request = transaction.objectStore(SESSION_STORE).get(id)
      request.onsuccess = () =>
        resolve((request.result as CachedChatSession | undefined) ?? null)
      request.onerror = () => reject(request.error)
      transaction.oncomplete = () => database.close()
    })
  } catch (error) {
    console.warn("Failed to read local chat cache:", error)
    return null
  }
}

export async function saveCachedSession(
  session: CachedChatSession,
): Promise<void> {
  try {
    const database = await openDatabase()
    if (!database) return
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(SESSION_STORE, "readwrite")
      transaction.objectStore(SESSION_STORE).put({
        ...session,
        messages: session.messages
          .map(cacheSafeMessage)
          .slice(-MAX_CACHED_MESSAGES),
        updatedAt: Date.now(),
      } satisfies CachedChatSession)
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } catch (error) {
    console.warn("Failed to save local chat cache:", error)
  }
}
