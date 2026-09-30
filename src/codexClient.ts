/**
 * Codex `app-server` 客户端（官方协议文档 + 0.157.1 二进制佐证）。
 *
 * 会话模型是 thread/turn 制：`thread/start` 开局，`turn/start` 发言，
 * `turn/interrupt` 中止，`thread/fork` 分叉；`turn/started`、`item/*`、
 * `turn/completed` 等通知走事件流。传输是宿主的 stdio JSON-RPC 管道，
 * 这里只懂协议形状——帧、配对、重连都在原生侧。
 *
 * 所有解析都是容忍式的：未知字段忽略，坏条目跳过，形态实在不对才抛错。
 * 官方文档与二进制交叉确认过的方法才进白名单（`validation.ts` 同步）。
 */

export interface CodexThread {
  id: string
  title: string
}

export interface CodexMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  reasoning: string[]
  tools: string[]
}

export interface CodexModelOption {
  id: string
  name: string
}

export interface CodexRpc {
  call: (method: string, params?: Record<string, unknown>) => Promise<unknown>
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

function threadOf(value: unknown): CodexThread {
  const item = asRecord(value, '会话')
  const thread = 'thread' in item && typeof item.thread === 'object' ? asRecord(item.thread, '会话') : item
  const id = asString(thread.id ?? thread.threadId)
  if (id === '') throw new Error('会话缺少 id')
  return { id, title: asString(thread.title ?? thread.name) || '未命名会话' }
}

/**
 * 从服务端通知的 params 里取**会话锚点**（`threadId` / `thread_id`）。
 *
 * 事件流是全局的：turn/item 通知带的是**产生它的那个会话**，而界面同时只显示
 * 一个会话。拿不到 id（字段缺失/形态不对）时返回 null —— 调用方按“无法归属”
 * 处理（退回旧的宽松行为），但只要 id 在且与当前会话不同，就会被丢弃，
 * 否则 A 会话的流式事件会刷新出 B 会话的串台消息。
 */
export function codexEventThreadId(params: unknown): string | null {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null
  const record = params as Record<string, unknown>
  const raw = record.threadId ?? record.thread_id
  return typeof raw === 'string' && raw !== '' ? raw : null
}

/** item 归一化：reasoning 进思考表，message 进正文，shell/工具进工具条。 */
export function normalizeCodexItem(
  item: unknown,
  collect: { text: string[]; reasoning: string[]; tools: string[] },
): void {
  let record: Record<string, unknown>
  try {
    record = asRecord(item, '消息分段')
  } catch {
    return
  }
  const type = asString(record.type).toLowerCase()
  const text =
    asString(record.text) || asString(record.content) || asString(record.message) || asString(record.command)
  if (text === '') return
  if (type.includes('reason')) {
    collect.reasoning.push(text)
  } else if (type.includes('command') || type.includes('tool') || type.includes('edit') || type.includes('shell')) {
    collect.tools.push(text)
  } else {
    collect.text.push(text)
  }
}

export function parseCodexMessages(value: unknown): CodexMessage[] {
  const list = Array.isArray(value) ? value : [value]
  const messages: CodexMessage[] = []
  for (const entry of list) {
    let item: Record<string, unknown>
    try {
      item = asRecord(entry, '消息')
    } catch {
      continue
    }
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : null
    if (role === null) continue
    const collect = { text: [] as string[], reasoning: [] as string[], tools: [] as string[] }
    const parts = Array.isArray(item.items) ? item.items : Array.isArray(item.parts) ? item.parts : []
    for (const part of parts) normalizeCodexItem(part, collect)
    if (item.text !== undefined && collect.text.length === 0) {
      const direct = asString(item.text)
      if (direct !== '') collect.text.push(direct)
    }
    messages.push({
      id: asString(item.id ?? ''),
      role,
      text: collect.text.join(''),
      reasoning: collect.reasoning,
      tools: collect.tools,
    })
  }
  return messages
}

export function parseCodexModels(value: unknown): CodexModelOption[] {
  const raw: unknown[] = []
  if (Array.isArray(value)) {
    for (const entry of value) raw.push(entry as unknown)
  } else {
    try {
      const mapping = asRecord(value, '模型目录')
      const models: unknown = mapping.models
      if (Array.isArray(models)) {
        for (const entry of models) raw.push(entry as unknown)
      } else if (typeof models === 'object' && models !== null) {
        // map 写法里键才是 id：先把键填进去，条目自带的显式 id 优先。
        for (const [key, candidate] of Object.entries(models)) {
          if (typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate)) {
            raw.push({ id: key, ...candidate })
          } else {
            raw.push(candidate)
          }
        }
      } else if (!Array.isArray(mapping.providers)) {
        for (const entry of Object.values(mapping)) raw.push(entry)
      }
    } catch {
      throw new Error('模型目录格式无效')
    }
  }
  const models: CodexModelOption[] = []
  for (const entry of raw) {
    let item: Record<string, unknown>
    try {
      item = typeof entry === 'string' ? { id: entry } : asRecord(entry, '模型')
    } catch {
      continue
    }
    const id = asString(item.id ?? item.model ?? item.name)
    if (id === '') continue
    models.push({ id, name: asString(item.name) || id })
  }
  return models
}

export class CodexClient {
  constructor(private readonly rpc: CodexRpc) {}

  async startThread(model?: string): Promise<CodexThread> {
    const params: Record<string, unknown> = {}
    if (model !== undefined && model !== '') params.model = model
    return threadOf(await this.rpc.call('thread/start', params))
  }

  async resumeThread(id: string): Promise<CodexThread> {
    if (id === '') throw new Error('会话 id 缺失')
    return threadOf(await this.rpc.call('thread/resume', { threadId: id }))
  }

  async listThreads(): Promise<CodexThread[]> {
    const value = await this.rpc.call('thread/list', {})
    const list = Array.isArray(value) ? value : [value]
    const threads: CodexThread[] = []
    for (const entry of list) {
      try {
        threads.push(threadOf(entry))
      } catch {
        continue
      }
    }
    return threads
  }

  async forkThread(threadId: string, lastTurnId?: string): Promise<CodexThread> {
    if (threadId === '') throw new Error('会话 id 缺失')
    const params: Record<string, unknown> = { threadId }
    if (lastTurnId !== undefined && lastTurnId !== '') params.lastTurnId = lastTurnId
    return threadOf(await this.rpc.call('thread/fork', params))
  }

  async startTurn(threadId: string, text: string, model?: string, effort?: string): Promise<string> {
    if (threadId === '') throw new Error('会话 id 缺失')
    if (text.trim() === '') throw new Error('消息内容为空')
    const params: Record<string, unknown> = {
      threadId,
      input: [{ type: 'text', text }],
    }
    if (model !== undefined && model !== '') params.model = model
    if (effort !== undefined && effort !== '') params.effort = effort
    const value = asRecord(await this.rpc.call('turn/start', params), '回合')
    const turn = 'turn' in value && typeof value.turn === 'object' ? asRecord(value.turn, '回合') : value
    return asString(turn.id ?? turn.turnId)
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    if (threadId === '' || turnId === '') throw new Error('标识缺失')
    // 文档明确用 snake_case：(thread_id, turn_id)。
    await this.rpc.call('turn/interrupt', { thread_id: threadId, turn_id: turnId })
  }

  async readThread(threadId: string): Promise<CodexMessage[]> {
    if (threadId === '') throw new Error('会话 id 缺失')
    return parseCodexMessages(await this.rpc.call('thread/read', { threadId }))
  }

  async listModels(): Promise<CodexModelOption[]> {
    return parseCodexModels(await this.rpc.call('model/list', {}))
  }
}
