export interface Model {
  id: string
  enabled: boolean
}

export interface ApiKeyEntry {
  key: string
  enabled: boolean
}

/** A routable upstream. Health, credentials and model aliases belong together. */
export interface Upstream {
  id: string
  baseUrl: string
  apiKey: string
  enabled: boolean
  /** Gateway model ID -> provider-specific model ID. */
  modelMap?: Record<string, string>
}

export interface Provider {
  id: string
  name: string
  /** @deprecated Kept to read configurations created before upstream pools. */
  baseUrl?: string
  apiType?: 'openai' | 'anthropic'
  /** @deprecated Kept to read configurations created before upstream pools. */
  apiKeys?: ApiKeyEntry[]
  upstreams?: Upstream[]
  models: Model[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface ProxyKey {
  id: string
  key: string
  name: string
  enabled: boolean
  createdAt: string
  expiresAt?: string | null
}

export interface Session {
  username: string
  expiresAt: number
}

export interface ProxyRequestBody {
  model?: string
  messages?: Array<{ role: string; content: string }>
  [key: string]: unknown
}

export interface TestModelRequest {
  modelId: string
}

export interface CreateProviderRequest {
  id: string
  name: string
  baseUrl?: string
  apiType?: 'openai' | 'anthropic'
  apiKeys?: Array<{ key: string; enabled: boolean }>
  upstreams?: Upstream[]
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
}

export interface UpdateProviderRequest {
  name?: string
  baseUrl?: string
  apiType?: 'openai' | 'anthropic'
  apiKeys?: Array<{ key: string; enabled: boolean }>
  upstreams?: Upstream[]
  models?: Array<{ id: string; enabled: boolean }> | string[]
  enabled?: boolean
}

export interface CreateProxyKeyRequest {
  name?: string
  expiresIn?: string // '30d' | '90d' | '180d' | '1y' | 'forever'
}

export interface ApiResponse<T = unknown> {
  success: boolean
  data?: T
  message?: string
}

export interface Env {
  KV: KVNamespace
  ADMIN_USERNAME?: string
  ADMIN_PASSWORD?: string
}
