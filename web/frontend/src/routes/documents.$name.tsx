import {
  IconArrowLeft,
  IconDeviceFloppy,
  IconLoader2,
} from "@tabler/icons-react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import {
  type WorkspaceDocumentName,
  getWorkspaceDocument,
  saveWorkspaceDocument,
} from "@/api/workspace-documents"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

function DocumentEditorPage() {
  const { name: rawName } = Route.useParams()
  const navigate = useNavigate()
  const name: WorkspaceDocumentName = rawName === "memory" ? "memory" : "soul"
  const title = name === "memory" ? "MEMORY.md" : "SOUL.md"
  const [content, setContent] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setLoading(true)
    void getWorkspaceDocument(name)
      .then((document) => setContent(document.content))
      .catch(() => toast.error(`${title} 读取失败`))
      .finally(() => setLoading(false))
  }, [name, title])

  const save = async () => {
    setSaving(true)
    try {
      await saveWorkspaceDocument(name, content)
      toast.success(`${title} 已保存`)
    } catch {
      toast.error(`${title} 保存失败`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      <header className="border-border/70 flex h-[calc(4rem+env(safe-area-inset-top))] shrink-0 items-end border-b px-2 pb-1">
        <div className="flex h-14 w-full items-center justify-between">
          <Button
            variant="ghost"
            size="icon"
            className="size-12 rounded-full"
            onClick={() => void navigate({ to: "/me", replace: true })}
            aria-label="返回我的"
          >
            <IconArrowLeft className="size-6" />
          </Button>
          <h1 className="text-lg font-semibold">{title}</h1>
          <Button
            variant="ghost"
            size="icon"
            className="size-12 rounded-full"
            disabled={loading || saving}
            onClick={() => void save()}
            aria-label={`保存 ${title}`}
          >
            {saving ? (
              <IconLoader2 className="size-5 animate-spin" />
            ) : (
              <IconDeviceFloppy className="size-5" />
            )}
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 p-3 sm:p-6">
        {loading ? (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-2">
            <IconLoader2 className="size-5 animate-spin" /> 正在读取
          </div>
        ) : (
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            spellCheck={false}
            className="bg-card h-full min-h-full resize-none rounded-2xl p-4 font-mono text-sm leading-6"
            aria-label={`${title} 内容`}
          />
        )}
      </main>
    </div>
  )
}

export const Route = createFileRoute("/documents/$name")({
  component: DocumentEditorPage,
})
