import { launcherFetch } from "@/api/http"

// API client for Pico Channel configuration.

interface PicoInfoResponse {
  ws_url: string
  enabled: boolean
  configured?: boolean
}

interface PicoSetupResponse {
  ws_url: string
  enabled: boolean
  configured?: boolean
  changed: boolean
}

interface PicoPushConfig {
  enabled: boolean
  public_key?: string
}

const BASE_URL = ""

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await launcherFetch(`${BASE_URL}${path}`, options)
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export async function getPicoInfo(): Promise<PicoInfoResponse> {
  return request<PicoInfoResponse>("/api/pico/info")
}

export async function regenPicoToken(): Promise<PicoInfoResponse> {
  return request<PicoInfoResponse>("/api/pico/token", { method: "POST" })
}

export async function setupPico(): Promise<PicoSetupResponse> {
  return request<PicoSetupResponse>("/api/pico/setup", { method: "POST" })
}

export async function getPicoPushConfig(): Promise<PicoPushConfig> {
  return request<PicoPushConfig>("/pico/push/config")
}

export async function savePicoPushSubscription(
  subscription: PushSubscription,
): Promise<void> {
  const res = await launcherFetch("/pico/push/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription),
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
}

export async function deletePicoPushSubscription(
  endpoint: string,
): Promise<void> {
  const res = await launcherFetch("/pico/push/subscriptions", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
}

export type { PicoInfoResponse, PicoPushConfig, PicoSetupResponse }
