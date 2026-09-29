/**
 * `opencode serve` 的最小聊天客户端（AndCode 同款接入：本机 HTTP + SSE）。
 *
 * 只实现会话所必需的四个端点：建会话、列会话、读消息、发消息、订阅事件流。
 * 服务端字段只取我们真正用的（id/title/role/text），其余一律容忍：
 * 上游加字段时客户端不炸，缺字段时抛错由调用方转成界面态。
 */

import type { AgentChatPart, AgentModelOption } from './platform/types'
import type { AgentPermissionRequest, AgentQuestionRequest, PermissionReply } from './platform/types'

export interface OpenCodeSession {
  id: string
  title: string
}

export interface ChatMessage {
  /** 服务端消息 id（缺失时为空字符串，界面用索引兜底）。 */
  id: string
  role: 'user' | 'assistant'
  text: string
  /** 非文本分段（文件/图片引用）：展示用，不参与正文拼接。 */
  attachments: ChatAttachment[]
  /** 思考过程分段：可折叠展示，不参与正文拼接。 */
  reasoning: string[]
  /** 工具调用摘要（Codex 侧有，OpenCode 侧暂无）：展示用。 */
  tools?: string[]
}

/** 消息里的文件/图片引用：mime 与落点 url 原样透出，渲染时再决议。 */
export interface ChatAttachment {
  kind: 'file' | 'image'
  mime: string
  url: string
}

export interface OpenCodeStreamEvent {
  type: string
  data: unknown
}

export interface OpenCodeAuth {
  username: string
  password: string
}

function basicAuthHeader(auth: OpenCodeAuth): string {
  return `Basic ${btoa(`${auth.username}:${auth.password}`)}`
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what}格式无效`)
  }
  return value as Record<string, unknown>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** 把服务端的 message 归一化成界面消息：文本拼接正文，文件/图片收进附件表。 */
export function normalizeMessage(value: unknown): ChatMessage | null {
  let item: Record<string, unknown>
  try {
    item = asRecord(value, '消息')
  } catch {
    return null
  }
  const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null
  if (role === null) return null
  const parts = Array.isArray(item.parts) ? item.parts : []
  const texts: string[] = []
  const attachments: ChatAttachment[] = []
  const reasoning: string[] = []
  for (const part of parts) {
    let record: Record<string, unknown>
    try {
      record = asRecord(part, '消息分段')
    } catch {
      continue
    }
    if (record.type === 'text') {
      texts.push(asString(record.text))
      continue
    }
    if (typeof record.type === 'string' && /reason|think/i.test(record.type)) {
      // 思考过程：文本在 text/content/summary 几种键下都见过，按优先级取。
      const thought = asString(record.text) || asString(record.content) || asString(record.summary)
      if (thought !== '') reasoning.push(thought)
      continue
    }
    if (record.type === 'file' || record.type === 'image') {
      // 服务端字段名在不同版本里有 url/path/filename 几种写法：按优先级取第一个非空。
      const url = asString(record.url) || asString(record.path) || asString(record.filename)
      if (url === '') continue
      attachments.push({
        kind: record.type === 'image' ? 'image' : 'file',
        mime: asString(record.mime),
        url,
      })
    }
  }
  return { id: asString(item.id ?? ''), role, text: texts.join(''), attachments, reasoning }
}

/** 中继原文入口：字符串先按 JSON 解析，再走同一套归一化（非法直接抛错）。 */
export function parseJsonPayload(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    throw new Error('Agent 服务返回了非 JSON')
  }
}

/** 单个会话归一化：纯函数，直连与中继共用。 */
export function parseSession(value: unknown): OpenCodeSession {
  const item = asRecord(value, '会话')
  const id = asString(item.id)
  if (id === '') throw new Error('会话缺少 id')
  return { id, title: asString(item.title) || '未命名会话' }
}

/** 会话列表归一化：纯函数，直连与中继共用。 */
export function parseSessionList(value: unknown): OpenCodeSession[] {
  if (!Array.isArray(value)) throw new Error('会话列表格式无效')
  return value.map(parseSession)
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/**
 * 模型目录归一化：`GET /config/providers` 有 map 与数组两种历史写法，
 * models 同样可能是 `{id: {...}}` 或 `[{...}]`——全部接受，缺的一律兜底。
 *
 * variants 只收字符串数组（`effort`/`effortLevels`/`reasoningEffort` 同义）；
 * `hidden: true` 的跳过，`deprecated` 的保留但标出来由界面置灰。
 */
export function parseAgentModels(value: unknown): AgentModelOption[] {
  const root = asRecord(value, '模型目录')
  const providersRaw = root.providers
  const providerEntries: Array<{ key: string; item: Record<string, unknown> }> = []
  if (Array.isArray(providersRaw)) {
    providersRaw.forEach((entry, index) => {
      try {
        const item = asRecord(entry, '供应商')
        providerEntries.push({ key: asString(item.id) || `provider-${index}`, item })
      } catch {
        // 坏条目跳过不断流。
      }
    })
  } else {
    try {
      const mapping = asRecord(providersRaw, '供应商表')
      Object.entries(mapping).forEach(([key, entry]) => {
        try {
          providerEntries.push({ key, item: asRecord(entry, '供应商') })
        } catch {
          // 坏条目跳过不断流。
        }
      })
    } catch {
      throw new Error('模型目录格式无效')
    }
  }
  const models: AgentModelOption[] = []
  for (const { key, item } of providerEntries) {
    const providerId = asString(item.id) || key
    const providerName = asString(item.name) || providerId
    const modelsRaw = item.models
    const modelEntries: Array<{ key: string; entry: Record<string, unknown> }> = []
    if (Array.isArray(modelsRaw)) {
      modelsRaw.forEach((candidate, index) => {
        try {
          modelEntries.push({ key: String(index), entry: asRecord(candidate, '模型') })
        } catch {
          // 坏条目跳过不断流。
        }
      })
    } else if (modelsRaw !== undefined && modelsRaw !== null) {
      try {
        Object.entries(asRecord(modelsRaw, '模型表')).forEach(([modelKey, candidate]) => {
          try {
            modelEntries.push({ key: modelKey, entry: asRecord(candidate, '模型') })
          } catch {
            // 坏条目跳过不断流。
          }
        })
      } catch {
        continue
      }
    }
    for (const { key: modelKey, entry } of modelEntries) {
      if (entry.hidden === true) continue
      const modelId = asString(entry.id) || modelKey
      const qualified = modelId.includes('/') ? modelId : `${providerId}/${modelId}`
      const variants = [
        ...asStringArray(entry.variants),
        ...asStringArray(entry.effort),
        ...asStringArray(entry.effortLevels),
        ...asStringArray(entry.reasoningEffort),
      ].filter((variant, index, all) => all.indexOf(variant) === index)
      models.push({
        id: qualified,
        name: asString(entry.name) || modelId,
        providerId,
        providerName,
        variants,
        deprecated: entry.status === 'deprecated' || entry.deprecated === true,
      })
    }
  }
  return models
}

/** 消息列表归一化：纯函数，直连与中继共用；非法条目跳过不断流。 */
export function parseMessageList(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) throw new Error('消息列表格式无效')
  return value.flatMap(entry => {
    const message = normalizeMessage(entry)
    return message === null ? [] : [message]
  })
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/**
 * 待答问题归一化：`GET /api/session/:sid/question`。
 *
 * 条目含 id/sessionID + questions[]（header/question/options[]），
 * 选项取 label（无 label 用 description 兜底，无两者跳过该选项）。
 */
export function parseQuestionList(value: unknown): AgentQuestionRequest[] {
  if (!Array.isArray(value)) throw new Error('问答列表格式无效')
  const requests: AgentQuestionRequest[] = []
  for (const entry of value) {
    let item: Record<string, unknown>
    try {
      item = asRecord(entry, '问答请求')
    } catch {
      continue
    }
    const id = asString(item.id)
    if (id === '') continue
    const questions: AgentQuestionRequest['questions'] = []
    if (Array.isArray(item.questions)) {
      for (const candidate of item.questions) {
        let question: Record<string, unknown>
        try {
          question = asRecord(candidate, '问答')
        } catch {
          continue
        }
        const options: Array<{ label: string; description: string }> = []
        if (Array.isArray(question.options)) {
          for (const optionCandidate of question.options) {
            try {
              const option = asRecord(optionCandidate, '问答选项')
              const label = asString(option.label) || asString(option.value)
              if (label === '') continue
              options.push({ label, description: asString(option.description) })
            } catch {
              continue
            }
          }
        }
        questions.push({
          header: asString(question.header),
          question: asString(question.question),
          options,
        })
      }
    }
    requests.push({
      id,
      sessionId: asString(item.sessionID ?? item.sessionId),
      questions,
    })
  }
  return requests
}

/**
 * 待批权限归一化：`GET /api/permission/request` 全局 feed。
 *
 * 条目含 id/sessionID/action/resources[]；调用方按 sessionID 过滤本会话。
 */
export function parsePermissionFeed(value: unknown): AgentPermissionRequest[] {
  const list = Array.isArray(value) ? value : [value]
  const requests: AgentPermissionRequest[] = []
  for (const entry of list) {
    let item: Record<string, unknown>
    try {
      item = asRecord(entry, '审批请求')
    } catch {
      continue
    }
    const id = asString(item.id ?? item.requestID)
    if (id === '') continue
    requests.push({
      id,
      sessionId: asString(item.sessionID ?? item.sessionId),
      action: asString(item.action) || asString(item.permission) || '权限请求',
      resources: asStringList(item.resources),
    })
  }
  return requests
}
export function parseSseBlock(block: string): OpenCodeStreamEvent | null {
  let type = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) {
      const name = line.slice('event:'.length).trim()
      if (name !== '') type = name
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
    } else if (line.startsWith(':')) {
      continue
    }
  }
  if (dataLines.length === 0) return null
  const raw = dataLines.join('\n')
  let data: unknown = raw
  try {
    data = JSON.parse(raw)
  } catch {
    // 非 JSON 载荷就原样透出，调用方按字符串处理。
  }
  return { type, data }
}

export class OpenCodeClient {
  private readonly baseUrl: string
  private readonly auth: OpenCodeAuth

  constructor(baseUrl: string, auth: OpenCodeAuth) {
    // 尾部斜杠统一去掉，避免拼出 //session 这类双斜杠。
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.auth = auth
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: basicAuthHeader(this.auth),
    }
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(), ...(init?.headers ?? {}) },
    })
    if (!response.ok) throw new Error(`OpenCode 服务返回 ${response.status}`)
    const text = await response.text()
    if (text === '') return null
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('OpenCode 服务返回了非 JSON')
    }
  }

  async listSessions(): Promise<OpenCodeSession[]> {
    return parseSessionList(await this.request('/session'))
  }

  async createSession(title?: string, modelID?: string, variant?: string): Promise<OpenCodeSession> {
    const body: Record<string, string> = {}
    if (title !== undefined) body.title = title
    // model/variant 与服务端 SDK 的 create body 键一致；未知键服务端按 JSON 惯例忽略。
    if (modelID !== undefined) body.model = modelID
    if (variant !== undefined) body.variant = variant
    const value = asRecord(
      await this.request('/session', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      '会话',
    )
    const id = asString(value.id)
    if (id === '') throw new Error('会话缺少 id')
    return { id, title: asString(value.title) || '未命名会话' }
  }

  async listModels(): Promise<AgentModelOption[]> {
    return parseAgentModels(await this.request('/config/providers'))
  }

  async abortSession(sessionId: string): Promise<void> {
    if (sessionId === '') throw new Error('会话 id 缺失')
    await this.request(`/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST' })
  }

  async forkSession(sessionId: string, messageId: string): Promise<OpenCodeSession> {
    if (sessionId === '') throw new Error('会话 id 缺失')
    if (messageId === '') throw new Error('消息标识缺失')
    const value = asRecord(
      await this.request(`/session/${encodeURIComponent(sessionId)}/fork`, {
        method: 'POST',
        body: JSON.stringify({ messageID: messageId }),
      }),
      '会话',
    )
    const id = asString(value.id)
    if (id === '') throw new Error('会话缺少 id')
    return { id, title: asString(value.title) || '未命名会话' }
  }

  async listQuestions(sessionId: string): Promise<AgentQuestionRequest[]> {
    if (sessionId === '') throw new Error('会话 id 缺失')
    return parseQuestionList(await this.request(`/api/session/${encodeURIComponent(sessionId)}/question`))
  }

  async permissionFeed(): Promise<AgentPermissionRequest[]> {
    return parsePermissionFeed(await this.request('/api/permission/request'))
  }

  async replyPermission(sessionId: string, requestId: string, reply: PermissionReply, message?: string): Promise<void> {
    if (sessionId === '') throw new Error('会话 id 缺失')
    if (requestId === '') throw new Error('请求标识缺失')
    if (reply !== 'once' && reply !== 'always' && reply !== 'reject') throw new Error('审批动作无效')
    const body: Record<string, string> = { reply }
    if (message !== undefined && message !== '') body.message = message
    await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { method: 'POST', body: JSON.stringify(body) },
    )
  }

  async replyQuestion(sessionId: string, requestId: string, answers: string[]): Promise<void> {
    if (sessionId === '') throw new Error('会话 id 缺失')
    if (requestId === '') throw new Error('请求标识缺失')
    if (answers.length === 0) throw new Error('问答选项为空')
    await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reply`,
      { method: 'POST', body: JSON.stringify({ answers }) },
    )
  }

  async rejectQuestion(sessionId: string, requestId: string): Promise<void> {
    if (sessionId === '') throw new Error('会话 id 缺失')
    if (requestId === '') throw new Error('请求标识缺失')
    await this.request(
      `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reject`,
      { method: 'POST' },
    )
  }

  async listMessages(sessionId: string): Promise<ChatMessage[]> {
    if (sessionId === '') throw new Error('会话 id 缺失')
    return parseMessageList(await this.request(`/session/${encodeURIComponent(sessionId)}/message`))
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    if (sessionId === '') throw new Error('会话 id 缺失')
    if (title.trim() === '') throw new Error('会话标题为空')
    await this.request(`/session/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    })
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (sessionId === '') throw new Error('会话 id 缺失')
    await this.request(`/session/${encodeURIComponent(sessionId)}/remove`, { method: 'DELETE' })
  }

  async deleteMessage(sessionId: string, messageId: string): Promise<void> {
    if (sessionId === '') throw new Error('会话 id 缺失')
    if (messageId === '') throw new Error('消息标识缺失')
    await this.request(
      `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
      { method: 'DELETE' },
    )
  }

  async sendMessage(sessionId: string, text: string, parts?: AgentChatPart[]): Promise<void> {
    if (sessionId === '') throw new Error('会话 id 缺失')
    if (parts !== undefined) {
      if (parts.length === 0) throw new Error('消息分段为空')
      await this.request(`/session/${encodeURIComponent(sessionId)}/message`, {
        method: 'POST',
        body: JSON.stringify({ parts }),
      })
      return
    }
    if (text.trim() === '') throw new Error('消息内容为空')
    await this.request(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
    })
  }

  /**
   * 订阅 `/event` SSE 流：增量拼块，逐块回调；返回取消函数。
   *
   * fetch + ReadableStream 而不用 EventSource：后者塞不进 Authorization 头。
   */
  subscribe(onEvent: (event: OpenCodeStreamEvent) => void): () => void {
    const controller = new AbortController()
    const decoder = new TextDecoder()
    let buffer = ''
    const pump = async (): Promise<void> => {
      let response: Response
      try {
        response = await fetch(`${this.baseUrl}/event`, {
          headers: { Accept: 'text/event-stream', Authorization: basicAuthHeader(this.auth) },
          signal: controller.signal,
        })
      } catch {
        return
      }
      if (!response.ok || !response.body) return
      const reader = response.body.getReader()
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch {
          break
        }
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          if (block.trim() === '') continue
          const event = parseSseBlock(block)
          if (event !== null) {
            try {
              onEvent(event)
            } catch {
              // 界面回调抛错不能掐断整条流。
            }
          }
        }
      }
    }
    void pump()
    return () => controller.abort()
  }
}
