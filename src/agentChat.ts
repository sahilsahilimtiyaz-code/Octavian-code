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
import type { AgentChatPart, AttachmentContent, StagedAttachment } from './platform/types'
import {
  parseJsonPayload,
  parseMessageList,
  parseSession,
  parseSessionList,
} from './opencodeClient'

export interface AgentChatTransport {
  listSessions: () => Promise<OpenCodeSession[]>
  createSession: (title: string) => Promise<OpenCodeSession>
  listMessages: (sessionId: string) => Promise<ChatMessage[]>
  sendMessage: (sessionId: string, text: string, parts?: AgentChatPart[]) => Promise<void>
  stageAttachment: (fileName: string, mime: string, dataBase64: string) => Promise<StagedAttachment>
  readAttachment: (guestPath: string) => Promise<AttachmentContent>
}

export function createNativeAgentChat(bridge: RuntimeBridge): AgentChatTransport {
  return {
    listSessions: () =>
      bridge.agentChatSessions().then(payload => parseSessionList(parseJsonPayload(payload.json))),
    createSession: title =>
      bridge.agentChatCreate(title).then(payload => parseSession(parseJsonPayload(payload.json))),
    listMessages: sessionId =>
      bridge.agentChatHistory(sessionId).then(payload => parseMessageList(parseJsonPayload(payload.json))),
    sendMessage: (sessionId, text, parts) =>
      bridge.agentChatSend(sessionId, text, parts).then(() => undefined),
    stageAttachment: (fileName, mime, dataBase64) => bridge.stageAgentAttachment(fileName, mime, dataBase64),
    readAttachment: guestPath => bridge.agentChatFile(guestPath),
  }
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
