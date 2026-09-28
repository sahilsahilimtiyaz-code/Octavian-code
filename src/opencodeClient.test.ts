import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeMessage, OpenCodeClient, parseSseBlock } from './opencodeClient'

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
    ).toEqual({ id: 'm1', role: 'assistant', text: 'hello world', attachments: [] })
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
    })
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
