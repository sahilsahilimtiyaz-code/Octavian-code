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
  sendMessage: (sessionId: string, text: string) => Promise<void>
}

export function createNativeAgentChat(bridge: RuntimeBridge): AgentChatTransport {
  return {
    listSessions: () =>
      bridge.agentChatSessions().then(payload => parseSessionList(parseJsonPayload(payload.json))),
    createSession: title =>
      bridge.agentChatCreate(title).then(payload => parseSession(parseJsonPayload(payload.json))),
    listMessages: sessionId =>
      bridge.agentChatHistory(sessionId).then(payload => parseMessageList(parseJsonPayload(payload.json))),
    sendMessage: (sessionId, text) => bridge.agentChatSend(sessionId, text).then(() => undefined),
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
