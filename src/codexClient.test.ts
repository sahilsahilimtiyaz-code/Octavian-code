import { describe, expect, it } from 'vitest'
import {
  CodexClient,
  codexEventThreadId,
  normalizeCodexItem,
  parseCodexMessages,
  parseCodexModels,
} from './codexClient'
import type { CodexRpc } from './codexClient'

function stubRpc(responses: Record<string, unknown>): { rpc: CodexRpc; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = []
  return {
    calls,
    rpc: {
      call: (method: string, params?: Record<string, unknown>) => {
        calls.push([method, params])
        if (!(method in responses)) return Promise.reject(new Error(`未知方法 ${method}`))
        return Promise.resolve(responses[method])
      },
    },
  }
}

describe('normalizeCodexItem', () => {
  it('reasoning 进思考表，shell/工具进工具条，正文进文本', () => {
    const collect = { text: [] as string[], reasoning: [] as string[], tools: [] as string[] }
    normalizeCodexItem({ type: 'reasoning', text: '想想' }, collect)
    normalizeCodexItem({ type: 'agentMessage', text: '答' }, collect)
    normalizeCodexItem({ type: 'shellCommand', command: 'ls' }, collect)
    normalizeCodexItem({ type: 'fileEdit', content: 'diff' }, collect)
    normalizeCodexItem(null, collect)
    expect(collect).toEqual({ text: ['答'], reasoning: ['想想'], tools: ['ls', 'diff'] })
  })
})

describe('codexEventThreadId', () => {
  it('认 camelCase 与 snake_case 两种形态', () => {
    expect(codexEventThreadId({ threadId: 'thr_1' })).toBe('thr_1')
    expect(codexEventThreadId({ thread_id: 'thr_1' })).toBe('thr_1')
    // snake_case 形态优先级更低时无所谓——两种都得认，服务端两版都发过。
    expect(codexEventThreadId({ threadId: 'a', thread_id: 'b' })).toBe('a')
  })

  it('拿不到会话 id 时返回 null（调用方按“无法归属”处理）', () => {
    expect(codexEventThreadId(null)).toBeNull()
    expect(codexEventThreadId(undefined)).toBeNull()
    expect(codexEventThreadId('thr_1')).toBeNull()
    expect(codexEventThreadId([])).toBeNull()
    expect(codexEventThreadId({})).toBeNull()
    expect(codexEventThreadId({ threadId: '' })).toBeNull()
    expect(codexEventThreadId({ threadId: 42 })).toBeNull()
  })
})

describe('parseCodexMessages', () => {
  it('归一化消息表，非法条目跳过', () => {
    expect(
      parseCodexMessages([
        { id: 'm1', role: 'user', items: [{ type: 'userMessage', text: 'hi' }] },
        { id: 'm2', role: 'assistant', parts: [{ type: 'reasoning', text: 'r' }, { type: 'text', text: 'ok' }] },
        { role: 'system' },
      ]),
    ).toEqual([
      { id: 'm1', role: 'user', text: 'hi', reasoning: [], tools: [] },
      { id: 'm2', role: 'assistant', text: 'ok', reasoning: ['r'], tools: [] },
    ])
  })
})

describe('parseCodexModels', () => {
  it('接受数组与 map 写法', () => {
    expect(parseCodexModels([{ id: 'gpt-5.1-codex', name: 'Codex' }, 'o4-mini'])).toEqual([
      { id: 'gpt-5.1-codex', name: 'Codex' },
      { id: 'o4-mini', name: 'o4-mini' },
    ])
    expect(parseCodexModels({ models: { a: { name: 'A' } } })).toEqual([{ id: 'a', name: 'A' }])
    expect(() => parseCodexModels(null)).toThrow()
  })
})

describe('CodexClient', () => {
  it('建会话/发言/中断走文档端点', async () => {
    const { rpc, calls } = stubRpc({
      'thread/start': { thread: { id: 'thr_1', title: 't' } },
      'turn/start': { turn: { id: 'turn_1' } },
      'turn/interrupt': {},
    })
    const client = new CodexClient(rpc)
    await expect(client.startThread('gpt-5.1-codex')).resolves.toEqual({ id: 'thr_1', title: 't' })
    await expect(client.startTurn('thr_1', 'hi')).resolves.toBe('turn_1')
    await client.interruptTurn('thr_1', 'turn_1')
    expect(calls.map(call => call[0])).toEqual(['thread/start', 'turn/start', 'turn/interrupt'])
    const turnParams = calls[1][1] as Record<string, unknown>
    expect(turnParams.threadId).toBe('thr_1')
    await expect(client.startTurn('thr_1', '   ')).rejects.toThrow()
  })

  it('分叉带 lastTurnId，模型目录归一化', async () => {
    const { rpc, calls } = stubRpc({
      'thread/fork': { thread: { id: 'thr_2' } },
      'model/list': [{ id: 'm' }],
    })
    const client = new CodexClient(rpc)
    await expect(client.forkThread('thr_1', 'turn_9')).resolves.toEqual({ id: 'thr_2', title: '未命名会话' })
    expect(calls[0][1]).toEqual({ threadId: 'thr_1', lastTurnId: 'turn_9' })
    await expect(client.listModels()).resolves.toEqual([{ id: 'm', name: 'm' }])
  })
})
