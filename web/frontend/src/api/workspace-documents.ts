import { launcherFetch } from "@/api/http"

export type WorkspaceDocumentName = "soul" | "memory"

export async function getWorkspaceDocument(name: WorkspaceDocumentName) {
  const response = await launcherFetch(`/api/workspace-documents/${name}`)
  if (!response.ok) throw new Error(`status ${response.status}`)
  return response.json() as Promise<{ name: string; content: string }>
}

export async function saveWorkspaceDocument(
  name: WorkspaceDocumentName,
  content: string,
) {
  const response = await launcherFetch(`/api/workspace-documents/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  })
  if (!response.ok) throw new Error(`status ${response.status}`)
}
