import { describe, expect, it, vi } from 'vitest'
import { createNativeAgentChat, pollUntilSettled } from './agentChat'
import { parseMessageList, parseSession, parseSessionList } from './opencodeClient'
import type { ChatMessage } from './opencodeClient'
import type { RuntimeBridge } from './platform/types'

describe('agentChat parsers', () => {
  it('parseSession 给缺标题的会话兜底', () => {
    expect(parseSession({ id: 's1' })).toEqual({ id: 's1', title: '未命名会话' })
    expect(() => parseSession({})).toThrow()
  })

  it('parseSessionList 拒绝非数组', () => {
    expect(() => parseSessionList({})).toThrow()
  })

  it('parseMessageList 跳过非法条目不断流', () => {
    expect(
      parseMessageList([{ role: 'user', parts: [{ type: 'text', text: 'hi' }] }, { role: 'system' }]),
    ).toEqual([{ id: '', role: 'user', text: 'hi' }])
  })
})

function stubBridge(overrides: Partial<RuntimeBridge>): RuntimeBridge {
  return overrides as RuntimeBridge
}

describe('createNativeAgentChat', () => {
  it('透传原文并归一化', async () => {
    const bridge = stubBridge({
      agentChatSessions: () => Promise.resolve({ json: '[{"id":"s1","title":"t"}]' }),
      agentChatCreate: () => Promise.resolve({ json: '{"id":"s2"}' }),
      agentChatHistory: () => Promise.resolve({ json: '[{"role":"user","parts":[]}]' }),
      agentChatSend: () => Promise.resolve({ json: 'null' }),
    })
    const chat = createNativeAgentChat(bridge)
    await expect(chat.listSessions()).resolves.toEqual([{ id: 's1', title: 't' }])
    await expect(chat.createSession('hi')).resolves.toEqual({ id: 's2', title: '未命名会话' })
    await expect(chat.listMessages('s1')).resolves.toEqual([{ id: '', role: 'user', text: '' }])
    await expect(chat.sendMessage('s1', 'hi')).resolves.toBeUndefined()
  })

  it('原文非法时抛错', async () => {
    const bridge = stubBridge({
      agentChatSessions: () => Promise.resolve({ json: 'not-json' }),
    })
    const chat = createNativeAgentChat(bridge)
    await expect(chat.listSessions()).rejects.toThrow()
  })
})

describe('pollUntilSettled', () => {
  it('连续两次快照一致即停', async () => {
    const snapshots: ChatMessage[][] = [
      [{ id: 'a', role: 'user', text: 'hi' }],
      [
        { id: 'a', role: 'user', text: 'hi' },
        { id: 'b', role: 'assistant', text: 'hello' },
      ],
    ]
    let calls = 0
    const listMessages = vi.fn((): Promise<ChatMessage[]> => {
      const snapshot = snapshots[Math.min(calls, snapshots.length - 1)]
      calls += 1
      return Promise.resolve([...snapshot])
    })
    const result = await pollUntilSettled(listMessages, { intervalMs: 1, maxRounds: 10 })
    expect(result).toHaveLength(2)
    expect(calls).toBeLessThanOrEqual(4)
  })

  it('超时返回最后一次快照', async () => {
    const listMessages = vi.fn(
      (): Promise<ChatMessage[]> => Promise.resolve([{ id: 'a', role: 'user', text: 'n' }]),
    )
    const result = await pollUntilSettled(listMessages, { intervalMs: 1, maxRounds: 3 })
    expect(result).toHaveLength(1)
  })
})
