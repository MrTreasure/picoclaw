import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import {
  type ModelInfo,
  type ModelThinkingLevel,
  getModels,
  setChatPreferences,
} from "@/api/models"
import { showSaveSuccessOrRestartToast } from "@/lib/restart-required"
import { refreshGatewayState } from "@/store/gateway"

interface UseChatModelsOptions {
  isConnected: boolean
}

function isLocalModel(model: ModelInfo): boolean {
  const isLocalHostBase = Boolean(
    model.api_base?.includes("localhost") ||
    model.api_base?.includes("127.0.0.1"),
  )

  return (
    model.auth_method === "local" || (!model.auth_method && isLocalHostBase)
  )
}

export function useChatModels({ isConnected }: UseChatModelsOptions) {
  const { t } = useTranslation()
  const [modelList, setModelList] = useState<ModelInfo[]>([])
  const [defaultModelName, setDefaultModelName] = useState("")
  const [settingDefault, setSettingDefault] = useState(false)
  const [settingThinkingLevel, setSettingThinkingLevel] = useState(false)
  const [thinkingLevel, setThinkingLevel] = useState<ModelThinkingLevel>("off")
  const setDefaultRequestIdRef = useRef(0)
  const loadModelsRequestIdRef = useRef(0)
  const setDefaultQueueRef = useRef<Promise<void>>(Promise.resolve())

  const syncDefaultModelName = useCallback((defaultModel: string) => {
    setDefaultModelName(defaultModel.trim())
  }, [])

  const loadModels = useCallback(async () => {
    try {
      const requestId = ++loadModelsRequestIdRef.current
      await setDefaultQueueRef.current.catch(() => {})
      if (requestId !== loadModelsRequestIdRef.current) return
      const data = await getModels()
      if (requestId !== loadModelsRequestIdRef.current) return
      setModelList(data.models)
      syncDefaultModelName(data.chat_model_name || data.default_model)
      setThinkingLevel(data.chat_thinking_level ?? "off")
    } catch {
      // silently fail
    }
  }, [syncDefaultModelName])

  useEffect(() => {
    const timerId = setTimeout(() => {
      void loadModels()
    }, 0)

    return () => clearTimeout(timerId)
  }, [isConnected, loadModels])

  const handleSetDefault = useCallback(
    async (modelName: string) => {
      if (modelName === defaultModelName) return
      const requestId = ++setDefaultRequestIdRef.current
      ++loadModelsRequestIdRef.current
      setSettingDefault(true)

      const request = setDefaultQueueRef.current
        .catch(() => {})
        .then(async () => {
          if (requestId !== setDefaultRequestIdRef.current) return
          await setChatPreferences({ model_name: modelName })
          if (requestId !== setDefaultRequestIdRef.current) return
          const data = await getModels()
          if (requestId !== setDefaultRequestIdRef.current) return

          setModelList(data.models)
          syncDefaultModelName(data.chat_model_name || data.default_model)
          setThinkingLevel(data.chat_thinking_level ?? "off")
          const gateway = await refreshGatewayState({ force: true })
          if (requestId !== setDefaultRequestIdRef.current) return
          showSaveSuccessOrRestartToast(
            t,
            t("models.defaultChangeSuccess"),
            modelName,
            gateway?.restartRequired === true,
          )
        })
      setDefaultQueueRef.current = request
      try {
        await request
      } catch (err) {
        if (requestId !== setDefaultRequestIdRef.current) return
        console.error("Failed to set default model:", err)
        toast.error(err instanceof Error ? err.message : t("models.loadError"))
      } finally {
        if (requestId === setDefaultRequestIdRef.current) {
          setSettingDefault(false)
        }
      }
    },
    [defaultModelName, syncDefaultModelName, t],
  )

  const defaultSelectableModels = useMemo(() => {
    const modelsByAlias = new Map<string, ModelInfo[]>()
    for (const model of modelList) {
      const entries = modelsByAlias.get(model.model_name) ?? []
      entries.push(model)
      modelsByAlias.set(model.model_name, entries)
    }
    return [...modelsByAlias.values()].flatMap((entries) =>
      entries.every(
        (model) =>
          model.default_model_allowed !== false &&
          model.is_virtual !== true &&
          model.status !== "unconfigured",
      )
        ? [entries.find((model) => model.available) ?? entries[0]]
        : [],
    )
  }, [modelList])

  const hasAvailableModels = useMemo(
    () => defaultSelectableModels.some((m) => m.available),
    [defaultSelectableModels],
  )

  const oauthModels = useMemo(
    () =>
      defaultSelectableModels.filter(
        (m) => m.available && m.auth_method === "oauth",
      ),
    [defaultSelectableModels],
  )

  const localModels = useMemo(
    () => defaultSelectableModels.filter((m) => m.available && isLocalModel(m)),
    [defaultSelectableModels],
  )

  const apiKeyModels = useMemo(
    () =>
      defaultSelectableModels.filter(
        (m) => m.available && m.auth_method !== "oauth" && !isLocalModel(m),
      ),
    [defaultSelectableModels],
  )

  const chatModels = useMemo(
    () =>
      defaultSelectableModels.filter(
        (model) =>
          model.available &&
          !/(?:^|[-_])(tts|asr)(?:$|[-_])/i.test(model.model_name),
      ),
    [defaultSelectableModels],
  )

  const handleSetThinkingLevel = useCallback(
    async (level: ModelThinkingLevel) => {
      if (!defaultModelName || level === thinkingLevel) return
      setSettingThinkingLevel(true)
      try {
        await setChatPreferences({ thinking_level: level })
        await loadModels()
        toast.success(`思考强度已设为${level}`)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "思考强度设置失败")
      } finally {
        setSettingThinkingLevel(false)
      }
    },
    [defaultModelName, loadModels, thinkingLevel],
  )

  return {
    defaultModelName,
    hasAvailableModels,
    apiKeyModels,
    oauthModels,
    localModels,
    settingDefault,
    handleSetDefault,
    chatModels,
    thinkingLevel,
    settingThinkingLevel,
    handleSetThinkingLevel,
  }
}
