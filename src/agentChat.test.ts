import { describe, expect, it, vi } from 'vitest'
import { createNativeAgentChat, pollUntilSettled } from './agentChat'
import { guessAttachmentMime, sanitizeAttachmentName } from './agentChat'
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
    ).toEqual([{ id: '', role: 'user', text: 'hi', attachments: [], reasoning: [] }])
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
    await expect(chat.createSession('hi', 'anthropic/x', 'max')).resolves.toEqual({ id: 's2', title: '未命名会话' })
    await expect(chat.listMessages('s1')).resolves.toEqual([{ id: '', role: 'user', text: '', attachments: [], reasoning: [] }])
    await expect(chat.sendMessage('s1', 'hi')).resolves.toBeUndefined()
  })

  it('原文非法时抛错', async () => {
    const bridge = stubBridge({
      agentChatSessions: () => Promise.resolve({ json: 'not-json' }),
    })
    const chat = createNativeAgentChat(bridge)
    await expect(chat.listSessions()).rejects.toThrow()
  })

  it('附件落点与读取透传桥接载荷', async () => {
    const bridge = stubBridge({
      stageAgentAttachment: () => Promise.resolve({ path: '/mnt/inbox/attachments/1-a.png' }),
      agentChatFile: () => Promise.resolve({ mime: 'image/png', dataBase64: 'aGk=' }),
    })
    const chat = createNativeAgentChat(bridge)
    await expect(chat.stageAttachment('a.png', 'image/png', 'aGk=')).resolves.toEqual({
      path: '/mnt/inbox/attachments/1-a.png',
    })
    await expect(chat.readAttachment('/mnt/inbox/attachments/1-a.png')).resolves.toEqual({
      mime: 'image/png',
      dataBase64: 'aGk=',
    })
  })

  it('中止/分叉/审批透传并归一化', async () => {
    const calls: string[] = []
    const bridge = stubBridge({
      agentChatAbort: () => {
        calls.push('abort')
        return Promise.resolve({ json: 'true' })
      },
      agentChatFork: () => {
        calls.push('fork')
        return Promise.resolve({ json: '{"id":"s9","title":"fork"}' })
      },
      agentPermissionReply: () => {
        calls.push('permission')
        return Promise.resolve({ json: 'null' })
      },
      agentQuestionReply: () => {
        calls.push('question-reply')
        return Promise.resolve({ json: 'null' })
      },
      agentQuestionReject: () => {
        calls.push('question-reject')
        return Promise.resolve({ json: 'true' })
      },
      agentQuestionList: () =>
        Promise.resolve({ json: '[{"id":"q1","sessionID":"s1","questions":[]}]' }),
      agentPermissionFeed: () =>
        Promise.resolve({ json: '[{"id":"p1","sessionID":"s1","action":"edit"}]' }),
      startAgentEventStream: () => Promise.resolve(undefined),
      stopAgentEventStream: () => Promise.resolve(undefined),
      addAgentEventListener: () => Promise.resolve({ remove: () => Promise.resolve(undefined) }),
    })
    const chat = createNativeAgentChat(bridge)
    await chat.abortSession('s1')
    await expect(chat.forkSession('s1', 'm1')).resolves.toEqual({ id: 's9', title: 'fork' })
    await chat.replyPermission('s1', 'p1', 'once')
    await chat.replyQuestion('s1', 'q1', ['是'])
    await chat.rejectQuestion('s1', 'q1')
    await expect(chat.listQuestions('s1')).resolves.toEqual([{ id: 'q1', sessionId: 's1', questions: [] }])
    await expect(chat.permissionFeed('s1')).resolves.toEqual([
      { id: 'p1', sessionId: 's1', action: 'edit', resources: [] },
    ])
    const stop = await chat.subscribeEvents(() => undefined)
    stop()
    expect(calls).toEqual(['abort', 'fork', 'permission', 'question-reply', 'question-reject'])
  })
})

describe('attachment helpers', () => {
  it('按后缀猜 mime，猜不出返回 null', () => {
    expect(guessAttachmentMime('a.PNG')).toBe('image/png')
    expect(guessAttachmentMime('report.pdf')).toBe('application/pdf')
    expect(guessAttachmentMime('notes.md')).toBe('text/markdown')
    expect(guessAttachmentMime('archive.zip')).toBeNull()
    expect(guessAttachmentMime('noext')).toBeNull()
  })

  it('文件名只留安全字符，非法退回 file', () => {
    expect(sanitizeAttachmentName('报告 2024/终版.png')).toBe('.png')
    expect(sanitizeAttachmentName('a/b\\c.jpg')).toBe('c.jpg')
    expect(sanitizeAttachmentName('...')).toBe('file')
    expect(sanitizeAttachmentName('')).toBe('file')
    expect(sanitizeAttachmentName('normal-file_1.PNG')).toBe('normal-file_1.PNG')
  })
})

describe('pollUntilSettled', () => {
  it('连续两次快照一致即停', async () => {
    const snapshots: ChatMessage[][] = [
      [{ id: 'a', role: 'user', text: 'hi', attachments: [], reasoning: [] }],
      [
        { id: 'a', role: 'user', text: 'hi', attachments: [], reasoning: [] },
        { id: 'b', role: 'assistant', text: 'hello', attachments: [], reasoning: [] },
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
      (): Promise<ChatMessage[]> => Promise.resolve([{ id: 'a', role: 'user', text: 'n', attachments: [], reasoning: [] }]),
    )
    const result = await pollUntilSettled(listMessages, { intervalMs: 1, maxRounds: 3 })
    expect(result).toHaveLength(1)
  })
})
