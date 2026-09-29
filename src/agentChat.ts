/**
 * Agent 聊天传输层：界面只认这个接口，不认直连还是中继。
 *
 * 今天只有原生中继实现（`runtimeBridge.agentChat*`）：Web 侧直连本机服务
 * 会被跨域拦、密码也过不了桥，所以 HTTP 由原生侧代发，原文 JSON 回来后
 * 在这里用 `opencodeClient` 的同一套纯函数归一化。以后远端 OpenCode
 *（LAN/Tailscale）就是第二个实现，界面不用改。
 */
import type { RuntimeBridge } from './platform/types'
import type { ChatMessage, OpenCodeSession } from './opencodeClient'
import { CodexClient } from './codexClient'
import type { CodexMessage, CodexModelOption, CodexThread } from './codexClient'
import type {
  AgentChatPart,
  AgentEvent,
  AgentModelOption,
  AgentPermissionRequest,
  AgentQuestionRequest,
  AttachmentContent,
  CodexEvent,
  PermissionReply,
  StagedAttachment,
} from './platform/types'
import {
  parseJsonPayload,
  parseMessageList,
  parsePermissionFeed,
  parseQuestionList,
  parseSession,
  parseSessionList,
} from './opencodeClient'

export interface AgentChatTransport {
  listSessions: () => Promise<OpenCodeSession[]>
  createSession: (title: string, modelID?: string, variant?: string) => Promise<OpenCodeSession>
  renameSession: (sessionId: string, title: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  listMessages: (sessionId: string) => Promise<ChatMessage[]>
  sendMessage: (sessionId: string, text: string, parts?: AgentChatPart[]) => Promise<void>
  stageAttachment: (fileName: string, mime: string, dataBase64: string) => Promise<StagedAttachment>
  readAttachment: (guestPath: string) => Promise<AttachmentContent>
  listModels: () => Promise<AgentModelOption[]>
  abortSession: (sessionId: string) => Promise<void>
  forkSession: (sessionId: string, messageId: string) => Promise<OpenCodeSession>
  replyPermission: (sessionId: string, requestId: string, reply: PermissionReply, message?: string) => Promise<void>
  replyQuestion: (sessionId: string, requestId: string, answers: string[]) => Promise<void>
  rejectQuestion: (sessionId: string, requestId: string) => Promise<void>
  listQuestions: (sessionId: string) => Promise<AgentQuestionRequest[]>
  permissionFeed: (sessionId: string) => Promise<AgentPermissionRequest[]>
  subscribeEvents: (onEvent: (event: AgentEvent) => void) => Promise<() => void>
}

export function createNativeAgentChat(bridge: RuntimeBridge): AgentChatTransport {
  return {
    listSessions: () =>
      bridge.agentChatSessions().then(payload => parseSessionList(parseJsonPayload(payload.json))),
    createSession: (title, modelID, variant) =>
      bridge.agentChatCreate(title, modelID, variant).then(payload => parseSession(parseJsonPayload(payload.json))),
    renameSession: (sessionId, title) => bridge.agentSessionRename(sessionId, title).then(() => undefined),
    deleteSession: sessionId => bridge.agentSessionDelete(sessionId).then(() => undefined),
    listMessages: sessionId =>
      bridge.agentChatHistory(sessionId).then(payload => parseMessageList(parseJsonPayload(payload.json))),
    sendMessage: (sessionId, text, parts) =>
      bridge.agentChatSend(sessionId, text, parts).then(() => undefined),
    stageAttachment: (fileName, mime, dataBase64) => bridge.stageAgentAttachment(fileName, mime, dataBase64),
    readAttachment: guestPath => bridge.agentChatFile(guestPath),
    // 目录在桥层已经归一化（native.ts 里 parseAgentModels），这里直接透传。
    listModels: () => bridge.agentModels().then(catalog => catalog.models),
    abortSession: sessionId => bridge.agentChatAbort(sessionId).then(() => undefined),
    forkSession: (sessionId, messageId) =>
      bridge.agentChatFork(sessionId, messageId).then(payload => parseSession(parseJsonPayload(payload.json))),
    replyPermission: (sessionId, requestId, reply, message) =>
      bridge.agentPermissionReply(sessionId, requestId, reply, message).then(() => undefined),
    replyQuestion: (sessionId, requestId, answers) =>
      bridge.agentQuestionReply(sessionId, requestId, answers).then(() => undefined),
    rejectQuestion: (sessionId, requestId) =>
      bridge.agentQuestionReject(sessionId, requestId).then(() => undefined),
    listQuestions: sessionId =>
      bridge.agentQuestionList(sessionId).then(payload => parseQuestionList(parseJsonPayload(payload.json))),
    permissionFeed: sessionId =>
      bridge
        .agentPermissionFeed()
        .then(payload => parsePermissionFeed(parseJsonPayload(payload.json)))
        .then(requests => requests.filter(request => request.sessionId === '' || request.sessionId === sessionId)),
    // 事件流：先开泵再挂监听，关的时候先摘监听再停泵——顺序反了会丢尾块或抛错。
    subscribeEvents: async onEvent => {
      await bridge.startAgentEventStream()
      const handle = await bridge.addAgentEventListener(onEvent)
      return () => {
        void handle.remove().catch(() => undefined)
        void bridge.stopAgentEventStream().catch(() => undefined)
      }
    },
  }
}

export interface CodexChatTransport {
  listThreads: () => Promise<CodexThread[]>
  startThread: (model?: string) => Promise<CodexThread>
  resumeThread: (id: string) => Promise<CodexThread>
  readThread: (threadId: string) => Promise<ChatMessage[]>
  startTurn: (threadId: string, text: string, model?: string, effort?: string) => Promise<string>
  interruptTurn: (threadId: string, turnId: string) => Promise<void>
  forkThread: (threadId: string, lastTurnId?: string) => Promise<CodexThread>
  listModels: () => Promise<CodexModelOption[]>
  subscribeEvents: (onEvent: (event: CodexEvent) => void) => Promise<() => void>
}

/**
 * Codex 传输：把 bridge 的通用 codexRpc 管道接到 CodexClient 的方法上，
 * 再把返回归一化成界面形状（CodexMessage 暂借 ChatMessage 的壳，
 * tools 进附件位以外的扩展位——见 CodexChatPanel 的渲染）。
 */
export function createCodexChat(bridge: RuntimeBridge): CodexChatTransport {
  const rpcCall = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    const payload = await bridge.codexRpc(method, params)
    return parseJsonPayload(payload.json)
  }
  const client = new CodexClient({ call: rpcCall })
  return {
    listThreads: () => client.listThreads(),
    startThread: model => client.startThread(model),
    resumeThread: id => client.resumeThread(id),
    readThread: threadId => client.readThread(threadId).then(toChatMessages),
    startTurn: (threadId, text, model, effort) => client.startTurn(threadId, text, model, effort),
    interruptTurn: (threadId, turnId) => client.interruptTurn(threadId, turnId),
    forkThread: (threadId, lastTurnId) => client.forkThread(threadId, lastTurnId),
    listModels: () => client.listModels(),
    subscribeEvents: async onEvent => {
      await bridge.startCodexEventStream()
      const handle = await bridge.addCodexEventListener(onEvent)
      return () => {
        void handle.remove().catch(() => undefined)
        void bridge.stopCodexEventStream().catch(() => undefined)
      }
    },
  }
}

function toChatMessages(messages: CodexMessage[]): ChatMessage[] {
  return messages.map(message => ({
    id: message.id,
    role: message.role,
    text: message.text,
    attachments: [],
    reasoning: message.reasoning,
    tools: message.tools,
  }))
}

/**
 * 发完消息后的跟随轮询：没有流式通道时，用“消息表不再变长”判定本轮结束。
 *
 * 连续两次快照完全一致（条数 + 末条文本）即停；超时按失败收尾。
 * 调用方负责在组件卸载时忽略迟到的 resolve（见 OpenCodeChatPanel）。
 */
export async function pollUntilSettled(
  listMessages: () => Promise<ChatMessage[]>,
  options?: { intervalMs?: number; maxRounds?: number },
): Promise<ChatMessage[]> {
  const intervalMs = options?.intervalMs ?? 2000
  const maxRounds = options?.maxRounds ?? 90
  let previous = ''
  let steady = 0
  let latest: ChatMessage[] = []
  for (let round = 0; round < maxRounds; round += 1) {
    try {
      latest = await listMessages()
    } catch {
      // 单轮失败不炸：服务重启抖动时跳过本轮，连续失败由 maxRounds 兜底。
      await new Promise(resolve => setTimeout(resolve, intervalMs))
      continue
    }
    const fingerprint = `${latest.length}:${latest.length > 0 ? latest[latest.length - 1].text : ''}`
    steady = fingerprint === previous ? steady + 1 : 0
    previous = fingerprint
    if (steady >= 2) return latest
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  return latest
}

/**
 * Codex 版跟随轮询：同一套“不再变长即停”规则，跑在 CodexMessage 上。
 * 单独一份而不是泛型化——两个消息形状不同，硬泛型只会把指纹逻辑藏起来。
 */
export async function pollCodexUntilSettled<T extends { text: string }>(
  listMessages: () => Promise<T[]>,
  options?: { intervalMs?: number; maxRounds?: number },
): Promise<T[]> {
  const intervalMs = options?.intervalMs ?? 2000
  const maxRounds = options?.maxRounds ?? 90
  let previous = ''
  let steady = 0
  let latest: T[] = []
  for (let round = 0; round < maxRounds; round += 1) {
    try {
      latest = await listMessages()
    } catch {
      await new Promise(resolve => setTimeout(resolve, intervalMs))
      continue
    }
    const fingerprint = `${latest.length}:${latest.length > 0 ? latest[latest.length - 1].text : ''}`
    steady = fingerprint === previous ? steady + 1 : 0
    previous = fingerprint
    if (steady >= 2) return latest
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  return latest
}

/** 附件上限 8MB：与原生侧一致，超了在选文件当下就拒绝，不浪费一次落点。 */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024

/** 单条消息最多 4 个附件：多了就是传文件夹，应该打 tar 走投递区。 */
export const ATTACHMENT_MAX_PER_MESSAGE = 4

const EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
}

/**
 * 按文件名猜 mime：浏览器 file.type 为空时的兜底（部分相册/文件管理器不填）。
 * 猜不出返回 null，调用方按“类型不支持”拒绝。
 */
export function guessAttachmentMime(fileName: string): string | null {
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase()
  if (extension === '' || extension === fileName.toLowerCase()) return null
  return EXTENSION_MIME[extension] ?? null
}

/**
 * 文件名清洗：只留字母数字与 `._-`（64 以内），落点与访客路径都只认这个形态。
 * 全是非法字符时退回 'file'，调用方再按后缀补回扩展名。
 */
export function sanitizeAttachmentName(fileName: string): string {
  const afterSlash = fileName.slice(fileName.lastIndexOf('/') + 1)
  const base = afterSlash.slice(afterSlash.lastIndexOf('\\') + 1)
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '').slice(0, 64)
  if (cleaned === '' || /^\.+$/.test(cleaned)) return 'file'
  return cleaned
}

export const DEFAULT_MODEL_STORAGE_KEY = 'octacode-model-v1'
export const DEFAULT_VARIANT_STORAGE_KEY = 'octacode-variant-v1'

/** 默认模型（`provider/model` 全称）：非法值回退为空（= 服务端默认）。 */
export function readDefaultModelId(): string {
  try {
    const value = window.localStorage.getItem(DEFAULT_MODEL_STORAGE_KEY)
    return typeof value === 'string' && value !== '' ? value : ''
  } catch {
    return ''
  }
}

export function saveDefaultModelId(id: string): void {
  try {
    if (id === '') {
      window.localStorage.removeItem(DEFAULT_MODEL_STORAGE_KEY)
    } else {
      window.localStorage.setItem(DEFAULT_MODEL_STORAGE_KEY, id)
    }
  } catch {
    // 存不下就用本次会话的值，界面不为此报错。
  }
}

/** 默认 effort 档位：只在所选模型声明了它时才会被发送。 */
export function readDefaultVariant(): string {
  try {
    const value = window.localStorage.getItem(DEFAULT_VARIANT_STORAGE_KEY)
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

export function saveDefaultVariant(variant: string): void {
  try {
    if (variant === '') {
      window.localStorage.removeItem(DEFAULT_VARIANT_STORAGE_KEY)
    } else {
      window.localStorage.setItem(DEFAULT_VARIANT_STORAGE_KEY, variant)
    }
  } catch {
    // 存不下就用本次会话的值，界面不为此报错。
  }
}
