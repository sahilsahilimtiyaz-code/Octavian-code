import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  normalizeMessage,
  OpenCodeClient,
  parseAgentModels,
  parsePermissionFeed,
  parseQuestionList,
  parseSseBlock,
} from './opencodeClient'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status })
}

describe('parseSseBlock', () => {
  it('解析 event + data 字段，data 优先按 JSON 解析', () => {
    const event = parseSseBlock('event: message.part.updated\ndata: {"part":{"text":"hi"}}')
    expect(event?.type).toBe('message.part.updated')
    expect(event?.data).toEqual({ part: { text: 'hi' } })
  })

  it('没有 data 的块返回 null，非 JSON data 原样透出', () => {
    expect(parseSseBlock(': keep-alive')).toBeNull()
    expect(parseSseBlock('data: plain')).toEqual({ type: 'message', data: 'plain' })
  })
})

describe('normalizeMessage', () => {
  it('只拼接 text parts，忽略其它分段', () => {
    expect(
      normalizeMessage({
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'hello ' },
          { type: 'tool', text: 'should-ignore' },
          { type: 'text', text: 'world' },
        ],
      }),
    ).toEqual({ id: 'm1', role: 'assistant', text: 'hello world', attachments: [], reasoning: [] })
  })

  it('非法 role 或非对象返回 null', () => {
    expect(normalizeMessage({ role: 'system', parts: [] })).toBeNull()
    expect(normalizeMessage(null)).toBeNull()
  })

  it('文件与图片分段收进附件表，正文只留文本', () => {
    expect(
      normalizeMessage({
        id: 'm2',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'see ' },
          { type: 'image', mime: 'image/png', url: '/mnt/inbox/attachments/1-a.png' },
          { type: 'file', mime: 'application/pdf', path: '/mnt/inbox/attachments/1-b.pdf' },
          { type: 'file', mime: 'text/plain', filename: 'c.txt' },
          { type: 'file', mime: 'image/png' },
        ],
      }),
    ).toEqual({
      id: 'm2',
      role: 'assistant',
      text: 'see ',
      attachments: [
        { kind: 'image', mime: 'image/png', url: '/mnt/inbox/attachments/1-a.png' },
        { kind: 'file', mime: 'application/pdf', url: '/mnt/inbox/attachments/1-b.pdf' },
        { kind: 'file', mime: 'text/plain', url: 'c.txt' },
      ],
      reasoning: [],
    })
  })

  it('思考分段收进 reasoning 表', () => {
    expect(
      normalizeMessage({
        id: 'm3',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: '先想想' },
          { type: 'Thinking', content: '再想想' },
          { type: 'text', text: '答' },
          { type: 'reasoning' },
        ],
      }),
    ).toEqual({
      id: 'm3',
      role: 'assistant',
      text: '答',
      attachments: [],
      reasoning: ['先想想', '再想想'],
    })
  })
})

describe('parseAgentModels', () => {
  it('接受 providers 数组 + models 数组', () => {
    expect(
      parseAgentModels({
        providers: [
          {
            id: 'anthropic',
            name: 'Anthropic',
            models: [{ id: 'anthropic/claude-sonnet-4-6', name: 'Sonnet', variants: ['default', 'max'] }],
          },
        ],
      }),
    ).toEqual([
      {
        id: 'anthropic/claude-sonnet-4-6',
        name: 'Sonnet',
        providerId: 'anthropic',
        providerName: 'Anthropic',
        variants: ['default', 'max'],
        deprecated: false,
      },
    ])
  })

  it('接受 providers 与 models 的 map 写法，跳过 hidden，标出 deprecated', () => {
    expect(
      parseAgentModels({
        providers: {
          openai: {
            name: 'OpenAI',
            models: {
              'openai/gpt-5': { name: 'GPT-5', effort: ['low', 'high'] },
              'openai/old': { name: 'Old', status: 'deprecated' },
              'openai/secret': { name: 'Secret', hidden: true },
            },
          },
        },
      }),
    ).toEqual([
      {
        id: 'openai/gpt-5',
        name: 'GPT-5',
        providerId: 'openai',
        providerName: 'OpenAI',
        variants: ['low', 'high'],
        deprecated: false,
      },
      {
        id: 'openai/old',
        name: 'Old',
        providerId: 'openai',
        providerName: 'OpenAI',
        variants: [],
        deprecated: true,
      },
    ])
  })

  it('缺字段兜底：无名用 id，无 id 用键，坏条目跳过', () => {
    expect(parseAgentModels({ providers: [{ models: [{}, 'nope'] }] })).toEqual([
      {
        id: 'provider-0/0',
        name: '0',
        providerId: 'provider-0',
        providerName: 'provider-0',
        variants: [],
        deprecated: false,
      },
    ])
    expect(() => parseAgentModels({})).toThrow('模型目录格式无效')
    expect(() => parseAgentModels(null)).toThrow()
  })
})

describe('OpenCodeClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('listSessions 归一化 id 与标题', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse([{ id: 's1', title: 't' }, { id: 's2' }]))),
    )
    const client = new OpenCodeClient('http://127.0.0.1:4097/', { username: 'opencode', password: 'pw' })
    await expect(client.listSessions()).resolves.toEqual([
      { id: 's1', title: 't' },
      { id: 's2', title: '未命名会话' },
    ])
  })

  it('createSession 按需带上 model 与 variant', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ id: 's9', title: 't' })))
    vi.stubGlobal('fetch', fetchMock)
    const client = new OpenCodeClient('http://127.0.0.1:4097', { username: 'opencode', password: 'pw' })
    await client.createSession('t', 'anthropic/claude-sonnet-4-6', 'max')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      title: 't',
      model: 'anthropic/claude-sonnet-4-6',
      variant: 'max',
    })
  })

  it('listModels 走 /config/providers 并归一化', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ providers: [] }))),
    )
    const client = new OpenCodeClient('http://127.0.0.1:4097', { username: 'opencode', password: 'pw' })
    await expect(client.listModels()).resolves.toEqual([])
  })

  it('非 200 按状态码抛错', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 401 }))),
    )
    const client = new OpenCodeClient('http://127.0.0.1:4097', { username: 'opencode', password: 'pw' })
    await expect(client.listSessions()).rejects.toThrow('401')
  })

  it('sendMessage 拼出正确的路径与载荷', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({})))
    vi.stubGlobal('fetch', fetchMock)
    const client = new OpenCodeClient('http://127.0.0.1:4097', { username: 'opencode', password: 'pw' })
    await client.sendMessage('s1', 'hello')
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:4097/session/s1/message')
    expect(JSON.parse(init.body as string)).toEqual({ parts: [{ type: 'text', text: 'hello' }] })
  })

  it('sendMessage 拒绝空消息与空会话', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({}))),
    )
    const client = new OpenCodeClient('http://127.0.0.1:4097', { username: 'opencode', password: 'pw' })
    await expect(client.sendMessage('', 'hi')).rejects.toThrow()
    await expect(client.sendMessage('s1', '   ')).rejects.toThrow()
  })

  it('sendMessage 支持直接发分段（含附件引用）', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({})))
    vi.stubGlobal('fetch', fetchMock)
    const client = new OpenCodeClient('http://127.0.0.1:4097', { username: 'opencode', password: 'pw' })
    const parts = [
      { type: 'text' as const, text: 'look' },
      { type: 'image' as const, mime: 'image/png', url: '/mnt/inbox/attachments/1-a.png' },
    ]
    await client.sendMessage('s1', '', parts)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ parts })
    await expect(client.sendMessage('s1', '', [])).rejects.toThrow()
  })

  it('subscribe 把跨包切断的 SSE 块拼起来再回调', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('event: a\ndata: {"n":'))
        controller.enqueue(encoder.encode('1}\n\nevent: b\ndata: x\n\n'))
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(stream, { status: 200 }))),
    )
    const client = new OpenCodeClient('http://127.0.0.1:4097', { username: 'opencode', password: 'pw' })
    const seen: string[] = []
    const stop = client.subscribe(event => {
      seen.push(event.type)
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    stop()
    expect(seen).toEqual(['a', 'b'])
  })
})

describe('中止/分叉与审批直连', () => {
  function clientWith(calls: Array<[string, RequestInit]>) {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      calls.push([url, init ?? {}])
      return Promise.resolve(jsonResponse({}))
    })
    vi.stubGlobal('fetch', fetchMock)
    return new OpenCodeClient('http://127.0.0.1:4097', { username: 'opencode', password: 'pw' })
  }

  it('abort 打到会话中止端点', async () => {
    const calls: Array<[string, RequestInit]> = []
    const client = clientWith(calls)
    await client.abortSession('s1')
    expect(calls[0][0]).toBe('http://127.0.0.1:4097/session/s1/abort')
    expect((calls[0][1].method ?? 'GET')).toBe('POST')
    await expect(client.abortSession('')).rejects.toThrow()
  })

  it('fork 带 messageID 并归一化新会话', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ id: 's2', title: 'fork' }))),
    )
    const client = new OpenCodeClient('http://127.0.0.1:4097', { username: 'opencode', password: 'pw' })
    await expect(client.forkSession('s1', 'm1')).resolves.toEqual({ id: 's2', title: 'fork' })
    await expect(client.forkSession('s1', '')).rejects.toThrow()
  })

  it('权限审批只接受枚举值', async () => {
    const calls: Array<[string, RequestInit]> = []
    const client = clientWith(calls)
    await client.replyPermission('s1', 'r1', 'once')
    expect(calls[0][0]).toBe('http://127.0.0.1:4097/api/session/s1/permission/r1/reply')
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ reply: 'once' })
    await client.replyPermission('s1', 'r1', 'always', 'ok')
    expect(JSON.parse(calls[1][1].body as string)).toEqual({ reply: 'always', message: 'ok' })
    await expect(client.replyPermission('s1', 'r1', 'maybe' as never)).rejects.toThrow()
  })

  it('问答审批走 reply/reject 端点', async () => {
    const calls: Array<[string, RequestInit]> = []
    const client = clientWith(calls)
    await client.replyQuestion('s1', 'q1', ['A 选项'])
    expect(calls[0][0]).toBe('http://127.0.0.1:4097/api/session/s1/question/q1/reply')
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ answers: ['A 选项'] })
    await client.rejectQuestion('s1', 'q1')
    expect(calls[1][0]).toBe('http://127.0.0.1:4097/api/session/s1/question/q1/reject')
    await expect(client.replyQuestion('s1', 'q1', [])).rejects.toThrow()
  })
})

describe('审批列表解析', () => {
  it('parseQuestionList 归一化问答请求', () => {
    expect(
      parseQuestionList([
        {
          id: 'q1',
          sessionID: 's1',
          questions: [
            {
              header: '确认',
              question: '继续吗？',
              options: [{ label: '是', description: '继续' }, { label: '否' }, {}],
            },
          ],
        },
        { sessionID: 's1' },
      ]),
    ).toEqual([
      {
        id: 'q1',
        sessionId: 's1',
        questions: [
          {
            header: '确认',
            question: '继续吗？',
            options: [
              { label: '是', description: '继续' },
              { label: '否', description: '' },
            ],
          },
        ],
      },
    ])
    expect(() => parseQuestionList({})).toThrow()
  })

  it('parsePermissionFeed 归一化待批请求', () => {
    expect(
      parsePermissionFeed([
        { id: 'p1', sessionID: 's1', action: 'edit', resources: ['a.ts'] },
        { requestID: 'p2', sessionId: 's1', permission: 'bash' },
        {},
      ]),
    ).toEqual([
      { id: 'p1', sessionId: 's1', action: 'edit', resources: ['a.ts'] },
      { id: 'p2', sessionId: 's1', action: 'bash', resources: [] },
    ])
  })
})
