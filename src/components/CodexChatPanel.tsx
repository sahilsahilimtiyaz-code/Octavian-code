import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitFork, Loader2, Plus, Power, RefreshCw, SendHorizontal, Square } from 'lucide-react'
import {
  createCodexChat,
  pollCodexUntilSettled,
} from '../agentChat'
import { t } from '../i18n'
import type { CodexModelOption, CodexThread } from '../codexClient'
import type { ChatMessage } from '../opencodeClient'
import type { RuntimeBridge } from '../platform/types'

interface CodexChatPanelProps {
  bridge: RuntimeBridge
  /** 访客运行时是否已安装：没装则服务起不来，先走安装。 */
  installed: boolean
  onInstall: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : t('操作失败，请重试。')
}

/**
 * Codex 聊天面板：自有聊天界面的第二块拼图（第一块是 OpenCode）。
 *
 * 会话模型是 thread/turn 制：thread/start 开局，turn/start 发言，
 * turn/interrupt 中止，thread/fork 分叉；turn/started、item/*、
 * turn/completed 经 codexEvent 事件流到达。传输是宿主的 stdio
 * JSON-RPC 管道（无端口无密码），协议形状在 codexClient 里。
 *
 * v1 有意不做的两件事（端点/形状未经二进制证实，不画假按钮）：
 * 审批卡片（通知方法名未确认）、附件发送（LocalImage 形状未确认）。
 */
export function CodexChatPanel({ bridge, installed, onInstall }: CodexChatPanelProps) {
  const transport = useMemo(() => createCodexChat(bridge), [bridge])
  const supported = typeof bridge.codexEngineState === 'function'
  const [running, setRunning] = useState(false)
  const [serverBusy, setServerBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [threads, setThreads] = useState<CodexThread[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [following, setFollowing] = useState(false)
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [forking, setForking] = useState(false)
  const [creating, setCreating] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [composer, setComposer] = useState('')
  const [models, setModels] = useState<CodexModelOption[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [usage, setUsage] = useState<string | null>(null)
  const cancelled = useRef(false)

  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])

  const refreshServer = useCallback(() => {
    if (!supported) {
      setServerError(t('当前版本不支持 Codex 服务，请更新应用后重试。'))
      return
    }
    setServerError(null)
    void bridge.codexEngineState().then(
      value => {
        if (!cancelled.current) setRunning(value.running)
      },
      error => {
        if (!cancelled.current) setServerError(errorMessage(error))
      },
    )
  }, [bridge, supported])

  useEffect(() => {
    refreshServer()
  }, [refreshServer])

  const refreshThreads = useCallback(() => {
    setLoading(true)
    void transport.listThreads().then(
      value => {
        if (cancelled.current) return
        setThreads(value)
        setLoading(false)
        if (value.length > 0 && activeId === null) setActiveId(value[0].id)
      },
      error => {
        if (cancelled.current) return
        setLoading(false)
        setChatError(errorMessage(error))
      },
    )
  }, [transport, activeId])

  const refreshModels = useCallback(() => {
    void transport.listModels().then(
      value => {
        if (!cancelled.current) setModels(value)
      },
      () => undefined,
    )
  }, [transport])

  useEffect(() => {
    if (running) {
      refreshThreads()
      refreshModels()
    }
  }, [running, refreshThreads, refreshModels])

  const refreshMessages = useCallback(
    (threadId: string, follow = false) => {
      if (follow) setFollowing(true)
      void transport.readThread(threadId).then(
        value => {
          if (cancelled.current) return
          setMessages(value)
          if (follow) {
            void pollCodexUntilSettled(() => transport.readThread(threadId), { intervalMs: 2000 }).then(
              settled => {
                if (!cancelled.current) {
                  setMessages(settled)
                  setFollowing(false)
                  setActiveTurnId(null)
                }
              },
              () => {
                if (!cancelled.current) {
                  setFollowing(false)
                  setActiveTurnId(null)
                }
              },
            )
          }
        },
        error => {
          if (cancelled.current) return
          setChatError(errorMessage(error))
          if (follow) {
            setFollowing(false)
            setActiveTurnId(null)
          }
        },
      )
    },
    [transport],
  )

  useEffect(() => {
    if (activeId !== null) {
      setMessages([])
      setUsage(null)
      refreshMessages(activeId)
    } else {
      setMessages([])
    }
  }, [activeId, refreshMessages])

  // 事件流：turn/completed 收尾，token 用量落脚，陌生通知忽略。
  useEffect(() => {
    if (!running || !supported) return
    let stop: (() => void) | undefined
    let done = false
    void transport
      .subscribeEvents(event => {
        if (done || cancelled.current) return
        if (event.method === 'turn/completed') {
          if (activeId !== null) refreshMessages(activeId)
          setFollowing(false)
          setActiveTurnId(null)
        } else if (event.method === 'thread/tokenUsage/updated') {
          try {
            setUsage(JSON.stringify(event.params))
          } catch {
            // 用量展示失败不影响对话。
          }
        } else if (event.method === 'turn/started' || event.method.startsWith('item/')) {
          if (activeId !== null && (sending || following)) {
            void transport.readThread(activeId).then(
              value => {
                if (!cancelled.current) setMessages(value)
              },
              () => undefined,
            )
          }
        }
      })
      .then(
        closer => {
          if (cancelled.current || done) {
            closer()
            return
          }
          stop = closer
        },
        () => undefined,
      )
    return () => {
      done = true
      stop?.()
    }
  }, [running, supported, transport, activeId, sending, following, refreshMessages])

  const toggleServer = () => {
    setServerBusy(true)
    setServerError(null)
    const action = running ? bridge.stopCodexServer() : bridge.startCodexServer()
    void action.then(
      value => {
        if (cancelled.current) return
        setServerBusy(false)
        setRunning(value.running)
      },
      error => {
        if (cancelled.current) return
        setServerBusy(false)
        setServerError(errorMessage(error))
      },
    )
  }

  const createThread = () => {
    setCreating(true)
    setChatError(null)
    void transport.startThread(selectedModel === '' ? undefined : selectedModel).then(
      thread => {
        if (cancelled.current) return
        setCreating(false)
        setThreads(previous => [thread, ...previous])
        setActiveId(thread.id)
      },
      error => {
        if (cancelled.current) return
        setCreating(false)
        setChatError(errorMessage(error))
      },
    )
  }

  const send = () => {
    if (activeId === null || sending) return
    const text = composer.trim()
    if (text === '') return
    setComposer('')
    setSending(true)
    setChatError(null)
    void transport
      .startTurn(activeId, text, selectedModel === '' ? undefined : selectedModel)
      .then(
        turnId => {
          if (cancelled.current) return
          setActiveTurnId(turnId === '' ? null : turnId)
          setSending(false)
          refreshMessages(activeId, true)
        },
        error => {
          if (cancelled.current) return
          setSending(false)
          setChatError(errorMessage(error))
        },
      )
  }

  const busy = sending || following

  const stopRun = () => {
    if (activeId === null || !busy || stopping) return
    if (activeTurnId === null) {
      // turn id 还没回来：先停本地跟随，下一轮事件会自然收尾。
      setSending(false)
      setFollowing(false)
      return
    }
    setStopping(true)
    void transport.interruptTurn(activeId, activeTurnId).then(
      () => {
        if (cancelled.current) return
        setStopping(false)
        setSending(false)
        setFollowing(false)
        setActiveTurnId(null)
        refreshMessages(activeId)
      },
      error => {
        if (cancelled.current) return
        setStopping(false)
        setSending(false)
        setFollowing(false)
        setActiveTurnId(null)
        setChatError(errorMessage(error))
      },
    )
  }

  const forkThread = () => {
    if (activeId === null || forking || busy) return
    setForking(true)
    setChatError(null)
    void transport.forkThread(activeId).then(
      thread => {
        if (cancelled.current) return
        setForking(false)
        setThreads(previous => [thread, ...previous])
        setActiveId(thread.id)
      },
      error => {
        if (cancelled.current) return
        setForking(false)
        setChatError(errorMessage(error))
      },
    )
  }

  if (!installed) {
    return (
      <section className="launch-panel">
        <div className="launch-copy">
          <h2>{t('先安装运行环境')}</h2>
          <p>{t('Codex 服务跑在访客 Ubuntu 里，没有运行时起不来。')}</p>
        </div>
        <div className="launch-actions">
          <button className="button button-primary" type="button" onClick={onInstall}>
            {t('安装并进入对话')}
          </button>
        </div>
      </section>
    )
  }

  return (
    <div className="chat-engine">
      <section className="chat-serverbar">
        <span className={`phase-badge ${running ? 'phase-green' : 'phase-blue'}`}>
          <span className="phase-dot" />
          {running ? t('服务运行中') : t('服务未启动')}
        </span>
        <button
          className="button button-secondary compact-button"
          type="button"
          onClick={toggleServer}
          disabled={serverBusy}
        >
          {serverBusy ? <Loader2 className="spin" size={16} /> : <Power size={16} />}
          {running ? t('停止服务') : t('启动服务')}
        </button>
        <button className="icon-button" type="button" title={t('刷新')} aria-label={t('刷新')} onClick={refreshServer}>
          <RefreshCw size={17} />
        </button>
      </section>
      {serverError !== null && (
        <div className="inline-alert warning" role="alert">
          <div><strong>{serverError}</strong></div>
        </div>
      )}

      {running && (
        <>
          <section className="chat-modelbar" aria-label={t('模型')}>
            <select
              className="chat-select"
              value={selectedModel}
              onChange={event => setSelectedModel(event.target.value)}
              aria-label={t('新会话模型')}
            >
              <option value="">{t('默认模型')}</option>
              {models.map(option => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
          </section>

          <section className="chat-sessions" aria-label={t('会话')}>
            <button className="button button-secondary compact-button" type="button" onClick={createThread} disabled={creating}>
              {creating ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}{t('新会话')}
            </button>
            <button
              className="button button-secondary compact-button"
              type="button"
              onClick={forkThread}
              disabled={forking || busy || activeId === null}
              title={t('分叉当前会话，原会话保留')}
            >
              {forking ? <Loader2 className="spin" size={16} /> : <GitFork size={16} />}{t('分叉')}
            </button>
            {loading && <span className="settings-note">{t('正在读取会话')}</span>}
            {threads.map(thread => (
              <button
                key={thread.id}
                type="button"
                className={thread.id === activeId ? 'chat-session active' : 'chat-session'}
                onClick={() => setActiveId(thread.id)}
              >
                {thread.title}
              </button>
            ))}
          </section>

          {chatError !== null && (
            <div className="inline-alert warning" role="alert">
              <div><strong>{chatError}</strong></div>
            </div>
          )}

          <section className="chat-transcript" aria-live="polite" aria-label={t('对话')}>
            {messages.map((message, index) => (
              <div key={message.id !== '' ? message.id : `m${index}`} className={message.role === 'user' ? 'chat-message user message-in' : 'chat-message assistant message-in'}>
                <div className="chat-bubble">
                  {message.reasoning.length > 0 && (
                    <details className="chat-reasoning">
                      <summary>{t('思考过程')}</summary>
                      {message.reasoning.map((thought, thoughtIndex) => (
                        <p key={thoughtIndex}>{thought}</p>
                      ))}
                    </details>
                  )}
                  {message.text === '' ? t('(空消息)') : message.text}
                  {(message.tools ?? []).length > 0 && (
                    <span className="chat-attachments">
                      {(message.tools ?? []).map(tool => (
                        <span className="chat-chip" key={tool.slice(0, 48)}>{tool.slice(0, 120)}</span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <div className="chat-message assistant">
                <div className="chat-bubble typing-dots" aria-label={t('正在输入')}>
                  <span /><span /><span />
                </div>
              </div>
            )}
            {messages.length === 0 && !busy && (
              <p className="settings-note">{t('还没有消息，在下面输入第一句话。')}</p>
            )}
          </section>
          {usage !== null && <p className="settings-note">{usage}</p>}

          <div className={busy ? 'chat-composer busy' : 'chat-composer'}>
            <input
              type="text"
              value={composer}
              onChange={event => setComposer(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !busy) send()
              }}
              placeholder={t('输入消息，回车发送')}
              aria-label={t('输入消息')}
              disabled={activeId === null || busy}
            />
            <button
              className="button button-primary"
              type="button"
              onClick={busy ? stopRun : send}
              disabled={activeId === null || stopping || (!busy && composer.trim() === '')}
              aria-label={busy ? t('停止') : t('发送')}
              title={busy ? t('中止本轮运行') : undefined}
            >
              {busy ? (
                stopping ? <Loader2 className="spin" size={18} /> : <Square size={18} />
              ) : (
                <SendHorizontal size={18} />
              )}
            </button>
          </div>
          <p className="settings-note">{t('模型用 Codex 自己的登录（终端运行 codex login）；中途可用停止键中断。')}</p>
        </>
      )}
    </div>
  )
}
