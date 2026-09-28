import { launcherFetch } from "./http"

export interface StaticPage {
  path: string
  name: string
  url: string
  size: number
  modified: string
  revision: string
}
export async function listStaticPages(
  signal?: AbortSignal,
): Promise<StaticPage[]> {
  const res = await launcherFetch("/api/static-pages", { signal })
  if (res.status === 503) throw new Error("静态页目录暂时不可用，请稍后重试。")
  if (!res.ok) throw new Error(`加载静态页失败（HTTP ${res.status}），请重试。`)
  return res.json()
}
export async function deleteStaticPage(page: StaticPage): Promise<void> {
  const res = await launcherFetch(
    `/api/static-pages?path=${encodeURIComponent(page.path)}`,
    {
      method: "DELETE",
      headers: { "If-Match": page.revision },
    },
  )
  if (res.status === 412) throw new Error("页面已更新，请刷新后再删除。")
  if (res.status === 503)
    throw new Error("静态页目录暂时不可用，页面尚未删除。")
  if (!res.ok && res.status !== 404)
    throw new Error(
      `删除失败（HTTP ${res.status}），请刷新确认页面状态后重试。`,
    )
}
