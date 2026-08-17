import { Context } from 'hono'
import { getProvider, getProviders } from './storage'
import { KV_KEYS, KEY_HEALTH_COOLDOWN_MS, KEY_HEALTH_MAX_FAILURES } from './config'
import type { Env, ProxyRequestBody, Upstream } from './types'

interface UpstreamHealth {
  failures: number
  lastFailed: boolean
  demotedAt?: number
}
type HealthMap = Record<string, UpstreamHealth>

const HEALTH_KEY = (providerId: string) => KV_KEYS.KEY_HEALTH_PREFIX + providerId

async function readHealth(env: Env, providerId: string): Promise<HealthMap> {
  const raw = await env.KV.get(HEALTH_KEY(providerId))
  return raw ? JSON.parse(raw) : {}
}

async function writeHealth(env: Env, providerId: string, health: HealthMap): Promise<void> {
  const filtered: HealthMap = {}
  for (const [id, value] of Object.entries(health)) {
    if (value.failures > 0) filtered[id] = value
  }
  if (Object.keys(filtered).length > 0) {
    await env.KV.put(HEALTH_KEY(providerId), JSON.stringify(filtered))
  } else {
    await env.KV.delete(HEALTH_KEY(providerId)).catch(() => {})
  }
}

function parseModelId(model: string): { providerId: string; modelId: string } | null {
  const slashIndex = model.indexOf('/')
  if (slashIndex === -1) return null
  return { providerId: model.substring(0, slashIndex), modelId: model.substring(slashIndex + 1) }
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function upstreamOrder(upstreams: Upstream[], health: HealthMap): Upstream[] {
  const healthy: Upstream[] = []
  const unhealthy: Upstream[] = []
  const probation: Upstream[] = []
  const demoted: Upstream[] = []

  for (const upstream of upstreams) {
    const state = health[upstream.id]
    if (state && state.failures >= KEY_HEALTH_MAX_FAILURES) {
      if (!state.demotedAt) state.demotedAt = Date.now()
      if (Date.now() - state.demotedAt >= KEY_HEALTH_COOLDOWN_MS) probation.push(upstream)
      else demoted.push(upstream)
    } else if (state?.lastFailed) {
      unhealthy.push(upstream)
    } else {
      healthy.push(upstream)
    }
  }

  const order = [...shuffle(healthy), ...unhealthy, ...probation]
  return order.length > 0 ? order : demoted
}

function markFailed(health: HealthMap, upstream: Upstream): void {
  const state = health[upstream.id] || { failures: 0, lastFailed: false }
  state.failures++
  state.lastFailed = true
  if (state.failures >= KEY_HEALTH_MAX_FAILURES) state.demotedAt = Date.now()
  health[upstream.id] = state
}

/** Test one concrete upstream node. */
export async function testModelConnection(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  apiType?: 'openai' | 'anthropic'
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  try {
    const cleanBase = baseUrl.replace(/\/$/, '')
    const endpoint = apiType === 'anthropic' ? 'messages' : 'chat/completions'
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiType === 'anthropic') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers.Authorization = `Bearer ${apiKey}`
    }
    const response = await fetch(`${cleanBase}/${endpoint}`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000),
    })
    if (response.ok) return { success: true, message: '连接成功', statusCode: response.status }
    const errorBody = await response.text()
    return { success: false, message: `HTTP ${response.status}: ${errorBody.substring(0, 200)}`, statusCode: response.status }
  } catch (err) {
    return { success: false, message: `连接失败: ${(err as Error).message?.substring(0, 200) || '未知错误'}` }
  }
}

/** Handle OpenAI/Anthropic compatible /v1 requests with upstream-pool failover. */
export async function handleProxy(c: Context<{ Bindings: Env }>) {
  try {
    const body = await c.req.json<ProxyRequestBody>()
    if (!body.model) return c.json({ error: { message: '缺少 model 参数', type: 'invalid_request_error' } }, 400)

    const parsed = parseModelId(body.model)
    if (!parsed) {
      return c.json({ error: { message: `模型格式错误 "${body.model}"，请使用 提供商ID/模型ID 格式`, type: 'invalid_request_error' } }, 400)
    }
    const { providerId, modelId } = parsed
    const provider = await getProvider(c.env, providerId)
    if (!provider) return c.json({ error: { message: `提供商 "${providerId}" 不存在`, type: 'invalid_request_error' } }, 404)
    if (!provider.enabled) return c.json({ error: { message: `提供商 "${provider.name}" 已禁用`, type: 'provider_disabled' } }, 403)

    const modelConfig = provider.models.find((model) => model.id === modelId)
    if (!modelConfig) return c.json({ error: { message: `模型 "${modelId}" 未在提供商 "${provider.name}" 中配置`, type: 'invalid_request_error' } }, 404)
    if (!modelConfig.enabled) return c.json({ error: { message: `模型 "${modelId}" 已禁用`, type: 'model_disabled' } }, 403)

    const enabledUpstreams = (provider.upstreams || []).filter((upstream) => upstream.enabled)
    if (enabledUpstreams.length === 0) {
      return c.json({ error: { message: `提供商 "${provider.name}" 未配置可用上游节点`, type: 'configuration_error' } }, 500)
    }

    const requestUrl = new URL(c.req.url)
    const subPath = requestUrl.pathname.replace(/^\/v1\//, '') || 'chat/completions'
    const health = await readHealth(c.env, providerId)
    const order = upstreamOrder(enabledUpstreams, health)
    let lastError: Response | null = null
    let healthUpdated = false

    for (const upstream of order) {
      const upstreamModel = upstream.modelMap?.[modelId] || modelId
      const forwardBody = { ...body, model: upstreamModel }
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (provider.apiType === 'anthropic') {
        headers['x-api-key'] = upstream.apiKey
        headers['anthropic-version'] = '2023-06-01'
      } else {
        headers.Authorization = `Bearer ${upstream.apiKey}`
      }

      try {
        const response = await fetch(`${upstream.baseUrl.replace(/\/$/, '')}/${subPath}${requestUrl.search}`, {
          method: c.req.method, headers, body: JSON.stringify(forwardBody), signal: AbortSignal.timeout(60000),
        })
        if (response.ok) {
          if (health[upstream.id]?.failures > 0) {
            delete health[upstream.id]
            healthUpdated = true
          }
          if (healthUpdated) await writeHealth(c.env, providerId, health)
          return new Response(response.body, {
            status: response.status,
            headers: {
              'Content-Type': response.headers.get('Content-Type') || 'application/json',
              'Cache-Control': 'no-store',
              'X-AI-Gateway-Upstream': upstream.id,
            },
          })
        }
        lastError = response
        if (response.status === 429) continue
        if (response.status === 401 || response.status === 403 || response.status >= 500) {
          markFailed(health, upstream)
          healthUpdated = true
          continue
        }
        const errorData = await response.json().catch(async () => ({ error: { message: await response.text() } }))
        return c.json(errorData, response.status as Parameters<typeof c.json>[1])
      } catch (err) {
        markFailed(health, upstream)
        healthUpdated = true
        lastError = new Response(JSON.stringify({ error: { message: (err as Error).message || '请求失败', type: 'proxy_error' } }), { status: 502 })
      }
    }

    if (healthUpdated) await writeHealth(c.env, providerId, health)
    if (lastError) {
      const errorBody = await lastError.text().catch(() => '所有上游节点均失败')
      return c.json({ error: { message: `所有上游节点均失败，最后一次错误: HTTP ${lastError.status}`, type: 'upstream_exhausted', detail: errorBody.substring(0, 500) } }, (lastError.status || 502) as Parameters<typeof c.json>[1])
    }
    return c.json({ error: { message: '没有可用上游节点', type: 'configuration_error' } }, 500)
  } catch (err) {
    return c.json({ error: { message: (err as Error).message || '代理转发内部错误', type: 'server_error' } }, 500)
  }
}

export async function handleModels(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const models: Array<{ id: string; provider: string; provider_name: string; object: string; created: number; owned_by: string }> = []
  for (const provider of providers) {
    if (!provider.enabled) continue
    for (const model of provider.models) {
      if (!model.enabled) continue
      models.push({ id: `${provider.id}/${model.id}`, provider: provider.id, provider_name: provider.name, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: provider.id })
    }
  }
  return c.json({ object: 'list', data: models })
}
