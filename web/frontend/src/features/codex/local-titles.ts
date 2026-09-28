const PREFIX = "musec137:codex-title:"
const key = (scope: string, id: string) =>
  `${PREFIX}${encodeURIComponent(scope)}:${encodeURIComponent(id)}`

export function readLocalCodexTitle(
  scope: string | null,
  id: string,
): string | null {
  if (!scope) return null
  try {
    const title = localStorage.getItem(key(scope, id))
    return title && title.trim() && title.length <= 60 ? title : null
  } catch {
    return null
  }
}

export function saveLocalCodexTitle(
  scope: string,
  id: string,
  title: string,
): void {
  const value = title.trim()
  if (
    !scope ||
    !id ||
    !value ||
    value.length > 60 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    throw new Error("Invalid local title")
  }
  // Propagate storage failures so the UI never claims an unsaved rename succeeded.
  localStorage.setItem(key(scope, id), value)
}

export function removeLocalCodexTitle(scope: string, id: string): void {
  try {
    localStorage.removeItem(key(scope, id))
  } catch {
    /* Best-effort cleanup after confirmed deletion. */
  }
}

export function isLocalCodexTitleKey(key: string | null): boolean {
  return key === null || key.startsWith(PREFIX)
}
