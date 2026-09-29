import { describe, expect, it, vi } from 'vitest'
import { createCodexChat, createNativeAgentChat, formatTokens, pollUntilSettled, sumUsage } from './agentChat'
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

  it('默认审批策略透传模式', async () => {
    const bridge = stubBridge({
      agentPermissionDefaults: () => Promise.resolve({ mode: 'strict' }),
      agentPermissionDefaultsSet: () => Promise.resolve({ mode: 'lenient' }),
    })
    const chat = createNativeAgentChat(bridge)
    await expect(chat.permissionDefaults()).resolves.toBe('strict')
    await expect(chat.permissionDefaultsSet('lenient')).resolves.toBe('lenient')
  })

  it('消息删除透传', async () => {
    const calls: Array<[string, string]> = []
    const bridge = stubBridge({
      agentMessageDelete: (sessionId: string, messageId: string) => {
        calls.push([sessionId, messageId])
        return Promise.resolve({ json: 'true' })
      },
    })
    const chat = createNativeAgentChat(bridge)
    await chat.deleteMessage('s1', 'm1')
    expect(calls).toEqual([['s1', 'm1']])
  })

  it('改名删除透传', async () => {
    const calls: string[] = []
    const bridge = stubBridge({
      agentSessionRename: () => {
        calls.push('rename')
        return Promise.resolve({ json: '{"id":"s1","title":"t"}' })
      },
      agentSessionDelete: () => {
        calls.push('delete')
        return Promise.resolve({ json: 'true' })
      },
    })
    const chat = createNativeAgentChat(bridge)
    await chat.renameSession('s1', 't')
    await chat.deleteSession('s1')
    expect(calls).toEqual(['rename', 'delete'])
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

describe('createCodexChat', () => {
  it('透传 codexRpc 并归一化线程与消息', async () => {
    const bridge = stubBridge({
      codexRpc: (method: string) => {
        if (method === 'thread/list') return Promise.resolve({ json: '[{"id":"thr_1","title":"t"}]' })
        if (method === 'thread/read') {
          return Promise.resolve({
            json: '[{"id":"m1","role":"assistant","items":[{"type":"agentMessage","text":"hi"}]}]',
          })
        }
        return Promise.resolve({ json: 'null' })
      },
      startCodexEventStream: () => Promise.resolve(undefined),
      stopCodexEventStream: () => Promise.resolve(undefined),
      addCodexEventListener: () => Promise.resolve({ remove: () => Promise.resolve(undefined) }),
    })
    const chat = createCodexChat(bridge)
    await expect(chat.listThreads()).resolves.toEqual([{ id: 'thr_1', title: 't' }])
    await expect(chat.readThread('thr_1')).resolves.toEqual([
      { id: 'm1', role: 'assistant', text: 'hi', attachments: [], reasoning: [], tools: [] },
    ])
    const stop = await chat.subscribeEvents(() => undefined)
    stop()
  })
})

describe('用量汇总与格式化', () => {
  it('sumUsage 累加带用量的消息，没有返回 null', () => {
    expect(sumUsage([{ usage: { input: 10, output: 5 } }, {}, { usage: { input: 3, output: 0 } }])).toEqual({
      input: 13,
      output: 5,
    })
    expect(sumUsage([{}, {}])).toBeNull()
  })

  it('formatTokens 按千/百万缩写', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1200)).toBe('1.2k')
    expect(formatTokens(3400000)).toBe('3.4M')
  })
})
