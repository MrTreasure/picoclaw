import {
  IconArrowLeft,
  IconCopy,
  IconDots,
  IconExternalLink,
  IconFileCode,
  IconPencil,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "@tabler/icons-react"
import { Link, createFileRoute } from "@tanstack/react-router"
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react"
import { toast } from "sonner"

import {
  type StaticPage,
  deleteStaticPage,
  listStaticPages,
} from "@/api/static-pages"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { lastAuthenticatedListScope } from "@/hooks/session-list-cache"

export const Route = createFileRoute("/static-pages")({
  component: StaticPagesPage,
})
function StaticPagesPage() {
  const namesKey =
    "musec137:static-page-names:" +
    encodeURIComponent(lastAuthenticatedListScope() || "")
  const [names, setNames] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(namesKey) || "{}")
    } catch {
      return {}
    }
  })
  const [sort, setSort] = useState("recent")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batch, setBatch] = useState(false)
  const [action, setAction] = useState<StaticPage | null>(null)
  const [rename, setRename] = useState<StaticPage | null>(null)
  const [name, setName] = useState("")
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null)
  const down = useRef<{ x: number; y: number } | null>(null)
  const suppress = useRef(false)
  const cancelHold = () => {
    if (hold.current) clearTimeout(hold.current)
    hold.current = null
  }
  useEffect(() => () => cancelHold(), [])
  const [pages, setPages] = useState<StaticPage[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const search = useDeferredValue(query).trim().toLocaleLowerCase()
  const [target, setTarget] = useState<StaticPage | null>(null)
  const [deleting, setDeleting] = useState(false)
  const request = useRef<AbortController | null>(null)
  const load = useCallback(async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError("")
    try {
      const data = await listStaticPages(controller.signal)
      if (!controller.signal.aborted) setPages(data)
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "加载失败")
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
    return () => request.current?.abort()
  }, [load])
  const remove = async () => {
    if (!target || deleting) return
    const targets = batch ? pages.filter((p) => selected.has(p.path)) : [target]
    setDeleting(true)
    request.current?.abort()
    setLoading(false)
    const deleted = new Set<string>()
    let failure = ""
    for (const page of targets) {
      try {
        await deleteStaticPage(page)
        deleted.add(page.path)
      } catch (e) {
        failure = e instanceof Error ? e.message : "删除失败"
      }
    }
    setPages((current) => current.filter((p) => !deleted.has(p.path)))
    setSelected(
      (current) => new Set([...current].filter((path) => !deleted.has(path))),
    )
    setTarget(null)
    setBatch(false)
    setDeleting(false)
    if (failure)
      toast.error(
        `已删除 ${deleted.size} 个，${targets.length - deleted.size} 个未删除：${failure}`,
      )
    else toast.success(`已删除 ${deleted.size} 个页面`)
  }
  const filtered = pages
    .filter((p) =>
      (p.path + " " + (names[p.path] || ""))
        .toLocaleLowerCase()
        .includes(search),
    )
    .sort((a, b) =>
      sort === "name"
        ? (names[a.path] || a.name).localeCompare(names[b.path] || b.name)
        : sort === "size"
          ? b.size - a.size
          : b.modified.localeCompare(a.modified),
    )
  const toggle = (path: string) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <header className="border-border/70 flex h-[calc(4rem+env(safe-area-inset-top))] shrink-0 items-end border-b px-3 pb-1">
        <div className="flex h-14 w-full items-center gap-3">
          <Link
            to="/me"
            aria-label="返回设置"
            className="focus-visible:ring-ring flex size-11 items-center justify-center rounded-xl focus-visible:ring-2"
          >
            <IconArrowLeft className="size-5" />
          </Link>
          <h1 className="flex-1 text-lg font-semibold">静态页</h1>
          <Button
            size="icon"
            className="size-11"
            variant="ghost"
            aria-label="刷新静态页"
            disabled={loading || deleting}
            onClick={() => void load()}
          >
            <IconRefresh
              className={
                loading
                  ? "size-5 animate-spin motion-reduce:animate-none"
                  : "size-5"
              }
            />
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-3xl space-y-4">
          <div>
            <p className="text-muted-foreground text-sm">Muse 创建的页面</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {pages.length}
              <span className="text-muted-foreground ml-2 text-sm font-normal">
                个页面
              </span>
            </p>
          </div>
          <div className="relative">
            <IconSearch className="text-muted-foreground pointer-events-none absolute top-3 left-3 size-5" />
            <Input
              aria-label="搜索静态页"
              placeholder="搜索页面"
              className="h-11 pl-10"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="text-muted-foreground text-sm">
              排序{" "}
              <select
                aria-label="页面排序"
                className="bg-card min-h-11 rounded-lg px-2"
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="recent">最近更新</option>
                <option value="name">名称</option>
                <option value="size">文件大小</option>
              </select>
            </label>
            {selected.size > 0 && (
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  disabled={deleting}
                  onClick={() => setSelected(new Set())}
                >
                  取消选择
                </Button>
                <Button
                  variant="destructive"
                  disabled={deleting}
                  onClick={() => {
                    setBatch(true)
                    setTarget(pages.find((p) => selected.has(p.path)) || null)
                  }}
                >
                  删除 {selected.size} 项
                </Button>
              </div>
            )}
          </div>
          {error && (
            <div
              role="alert"
              className="bg-destructive/10 rounded-xl p-4 text-sm"
            >
              <p>{error}</p>
              <Button
                variant="ghost"
                disabled={loading || deleting}
                onClick={() => void load()}
              >
                重新加载
              </Button>
            </div>
          )}
          {loading && !pages.length && (
            <div
              role="status"
              aria-label="正在加载静态页"
              className="space-y-3"
            >
              {[0, 1, 2].map((n) => (
                <div
                  key={n}
                  className="bg-muted h-24 animate-pulse rounded-2xl motion-reduce:animate-none"
                />
              ))}
            </div>
          )}
          {!loading && !error && !filtered.length && (
            <p className="text-muted-foreground py-16 text-center">
              {query ? "没有找到匹配的页面" : "还没有静态页"}
            </p>
          )}
          <ul className="space-y-2">
            {filtered.map((page) => (
              <li
                key={page.path}
                className="border-border/60 bg-card flex items-center gap-2 rounded-2xl border p-3"
              >
                <label className="flex size-11 shrink-0 cursor-pointer items-center justify-center">
                  <input
                    type="checkbox"
                    aria-label={`选择 ${names[page.path] || page.name}`}
                    className="size-5 cursor-pointer"
                    checked={selected.has(page.path)}
                    disabled={deleting}
                    onChange={() => toggle(page.path)}
                  />
                </label>
                <a
                  href={page.url}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return
                    suppress.current = false
                    cancelHold()
                    down.current = { x: event.clientX, y: event.clientY }
                    hold.current = setTimeout(() => {
                      suppress.current = true
                      setAction(page)
                    }, 460)
                  }}
                  onPointerMove={(event) => {
                    if (
                      down.current &&
                      Math.hypot(
                        event.clientX - down.current.x,
                        event.clientY - down.current.y,
                      ) > 10
                    ) {
                      cancelHold()
                      suppress.current = true
                    }
                  }}
                  onPointerUp={cancelHold}
                  onPointerCancel={cancelHold}
                  onPointerLeave={cancelHold}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    cancelHold()
                    suppress.current = true
                    setAction(page)
                  }}
                  onClick={(event) => {
                    if (suppress.current || selected.size) {
                      event.preventDefault()
                      if (!suppress.current) toggle(page.path)
                      suppress.current = false
                    }
                  }}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 rounded-xl py-1 focus-visible:ring-2"
                >
                  <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400">
                    <IconFileCode className="size-6" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {names[page.path] ||
                        (page.path.endsWith("/index.html")
                          ? page.path.slice(0, -11)
                          : page.name)}
                    </span>
                    <span className="text-muted-foreground mt-1 block truncate text-xs">
                      {page.path}
                    </span>
                    <span className="text-muted-foreground mt-1 block text-xs">
                      {new Date(page.modified).toLocaleDateString()} ·{" "}
                      {Math.max(1, Math.round(page.size / 1024))} KB
                    </span>
                  </span>
                  <IconExternalLink
                    aria-hidden="true"
                    className="text-muted-foreground size-4 shrink-0"
                  />
                </a>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 shrink-0"
                  aria-label={`页面操作：${page.path}`}
                  disabled={deleting}
                  onClick={() => setAction(page)}
                >
                  <IconDots className="text-muted-foreground size-5" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </main>
      <Sheet
        open={!!action}
        onOpenChange={(open) => {
          if (!open) setAction(null)
        }}
      >
        <SheetContent
          side="bottom"
          aria-describedby={undefined}
          className="mx-auto max-w-xl rounded-t-3xl pb-[calc(1rem+env(safe-area-inset-bottom))]"
        >
          <SheetHeader>
            <SheetTitle className="truncate pr-10">
              {action ? names[action.path] || action.name : ""}
            </SheetTitle>
          </SheetHeader>
          <div className="flex flex-col gap-1 px-3">
            <Button
              variant="ghost"
              className="h-12 justify-start"
              onClick={() => {
                if (action) {
                  setName(names[action.path] || action.name)
                  setRename(action)
                  setAction(null)
                }
              }}
            >
              <IconPencil />
              重命名
            </Button>
            <Button
              variant="ghost"
              className="h-12 justify-start"
              onClick={() => {
                if (action)
                  void navigator.clipboard
                    .writeText(action.url)
                    .then(() => {
                      setAction(null)
                      toast.success("链接已复制")
                    })
                    .catch(() => toast.error("复制失败"))
              }}
            >
              <IconCopy />
              复制链接
            </Button>
            <Button
              variant="ghost"
              className="text-destructive h-12 justify-start"
              onClick={() => {
                setBatch(false)
                setTarget(action)
                setAction(null)
              }}
            >
              <IconTrash />
              删除
            </Button>
          </div>
        </SheetContent>
      </Sheet>
      <Dialog
        open={!!rename}
        onOpenChange={(open) => {
          if (!open) setRename(null)
        }}
      >
        <DialogContent aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>重命名页面</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (!rename || !name.trim()) return
              try {
                if (!lastAuthenticatedListScope()) throw new Error("尚未登录")
                const next = { ...names, [rename.path]: name.trim() }
                localStorage.setItem(namesKey, JSON.stringify(next))
                setNames(next)
                setRename(null)
              } catch {
                toast.error("保存失败，请检查浏览器存储空间")
              }
            }}
          >
            <Input
              value={name}
              maxLength={60}
              aria-label="页面名称"
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" disabled={!name.trim()}>
              保存
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!target}
        onOpenChange={(open) => {
          if (!open && !deleting) setTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {batch ? `删除所选 ${selected.size} 个页面？` : "删除这个页面？"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              “{target?.path}
              ”将无法再打开。只删除这个页面文件，保留图片和其他资源。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault()
                void remove()
              }}
            >
              {deleting ? "删除中…" : "删除页面"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
