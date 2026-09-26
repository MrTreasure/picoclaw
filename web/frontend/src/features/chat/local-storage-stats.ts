export interface LocalChatCacheStats {
  bytes: number
  count: number
}

const DATABASE_NAME = "musec137-chat"
const SESSION_STORE = "sessions"

/**
 * Counts the JSON-serialized UTF-8 payload of the actual cached session
 * records. This is not IndexedDB's on-disk size or the browser origin quota.
 * Does not create a missing database/store or modify cached records.
 */
export async function getLocalChatCacheStats(): Promise<LocalChatCacheStats> {
  const empty = { bytes: 0, count: 0 }
  if (typeof indexedDB === "undefined" || !indexedDB) return empty

  // Avoid opening an absent database where enumeration is supported.
  if (typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases()
    if (!databases.some((database) => database.name === DATABASE_NAME))
      return empty
  }

  return new Promise((resolve, reject) => {
    // No version argument: the reader must work with newer compatible schemas.
    const request = indexedDB.open(DATABASE_NAME)
    request.onupgradeneeded = () => {
      // An absent DB would otherwise be created by open(). Abort instead.
      request.transaction?.abort()
    }
    request.onerror = () => {
      if (request.error?.name === "AbortError") resolve(empty)
      else reject(request.error ?? new Error("Could not open chat cache"))
    }
    request.onsuccess = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        database.close()
        resolve(empty)
        return
      }

      let bytes = 0
      let count = 0
      const encoder = new TextEncoder()
      try {
        const transaction = database.transaction(SESSION_STORE, "readonly")
        const cursor = transaction.objectStore(SESSION_STORE).openCursor()
        cursor.onsuccess = () => {
          const record = cursor.result
          if (!record) return
          const serialized = JSON.stringify(record.value)
          if (serialized !== undefined)
            bytes += encoder.encode(serialized).length
          count++
          record.continue()
        }
        transaction.oncomplete = () => {
          database.close()
          resolve({ bytes, count })
        }
        transaction.onerror = () => {
          database.close()
          reject(transaction.error ?? new Error("Could not read chat cache"))
        }
        transaction.onabort = () => {
          database.close()
          reject(transaction.error ?? new Error("Chat cache read aborted"))
        }
      } catch (error) {
        database.close()
        reject(error)
      }
    }
  })
}
