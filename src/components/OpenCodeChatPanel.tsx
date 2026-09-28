import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Plus, Power, RefreshCw, SendHorizontal, SquareTerminal } from 'lucide-react'
import { createNativeAgentChat, pollUntilSettled } from '../agentChat'
import { t } from '../i18n'
import type { ChatMessage, OpenCodeSession } from '../opencodeClient'
import type { AgentEngineServerState, RuntimeBridge } from '../platform/types'

interface OpenCodeChatPanelProps {
  bridge: RuntimeBridge
  /** 访客运行时是否已安装：没装则连服务都起不来，先走安装。 */
  installed: boolean
  /** Harness 是否在运行：在跑时不允许启动 Agent 服务（共用投递文件）。 */
  harnessRunning: boolean
  onInstall: () => void
  onOpenTerminal: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : t('操作失败，请重试。')
}

/**
 * OpenCode 聊天面板：自有聊天界面的第一块拼图。
 *
 * 会话、消息、发送全部走原生中继（`runtimeBridge.agentChat*`）：Web 侧不直连
 * 本机服务、不碰密码。发送后用“消息表不再变长”跟随轮询（见 pollUntilSettled），
 * 有 SSE 之前先这样跑；卸载时迟到的轮询一律丢弃。
 */
export function OpenCodeChatPanel({ bridge, installed, harnessRunning, onInstall, onOpenTerminal }: OpenCodeChatPanelProps) {
  const transport = useMemo(() => createNativeAgentChat(bridge), [bridge])
  // 桥方法缺失（旧版原生 / 不完整桩）：宁可显示升级提示，也不在 effect 里抛错整棵树卸载。
  const supported = typeof bridge.agentEngineState === 'function'
  const [server, setServer] = useState<AgentEngineServerState | null>(null)
  const [serverBusy, setServerBusy] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<OpenCodeSession[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [following, setFollowing] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const [composer, setComposer] = useState('')
  const [creating, setCreating] = useState(false)
  const cancelled = useRef(false)

  useEffect(() => {
    cancelled.current = false
    return () => {
      cancelled.current = true
    }
  }, [])

  const refreshServer = useCallback(() => {
    if (!supported) {
      setServerError(t('当前版本不支持 Agent 服务，请更新应用后重试。'))
      return
    }
    setServerError(null)
    void bridge.agentEngineState().then(
      value => {
        if (!cancelled.current) setServer(value)
      },
      error => {
        if (!cancelled.current) setServerError(errorMessage(error))
      },
    )
  }, [bridge, supported])

  useEffect(() => {
    refreshServer()
  }, [refreshServer])

  const refreshSessions = useCallback(
    (selectId?: string) => {
      setLoading(true)
      setChatError(null)
      void transport.listSessions().then(
        value => {
          if (cancelled.current) return
          setSessions(value)
          setLoading(false)
          if (selectId !== undefined) {
            setActiveId(selectId)
          } else if (value.length > 0 && activeId === null) {
            setActiveId(value[0].id)
          }
        },
        error => {
          if (cancelled.current) return
          setLoading(false)
          setChatError(errorMessage(error))
        },
      )
    },
    [transport, activeId],
  )

  useEffect(() => {
    if (server?.running === true) refreshSessions()
  }, [server?.running, refreshSessions])

  const refreshMessages = useCallback(
    (sessionId: string, follow = false) => {
      if (follow) setFollowing(true)
      void transport.listMessages(sessionId).then(
        value => {
          if (cancelled.current) return
          setMessages(value)
          if (follow) {
            void pollUntilSettled(() => transport.listMessages(sessionId), { intervalMs: 2000 }).then(
              settled => {
                if (!cancelled.current) {
                  setMessages(settled)
                  setFollowing(false)
                }
              },
              () => {
                if (!cancelled.current) setFollowing(false)
              },
            )
          }
        },
        error => {
          if (cancelled.current) return
          setChatError(errorMessage(error))
          if (follow) setFollowing(false)
        },
      )
    },
    [transport],
  )

  useEffect(() => {
    if (activeId !== null) {
      setMessages([])
      refreshMessages(activeId)
    } else {
      setMessages([])
    }
  }, [activeId, refreshMessages])

  const toggleServer = () => {
    setServerBusy(true)
    setServerError(null)
    const action = server?.running === true ? bridge.stopAgentServer() : bridge.startAgentServer()
    void action.then(
      value => {
        if (cancelled.current) return
        setServerBusy(false)
        setServer(value)
      },
      error => {
        if (cancelled.current) return
        setServerBusy(false)
        setServerError(errorMessage(error))
      },
    )
  }

  const createSession = () => {
    setCreating(true)
    setChatError(null)
    const title = `${t('新会话')} ${new Date().toLocaleString()}`
    void transport.createSession(title).then(
      session => {
        if (cancelled.current) return
        setCreating(false)
        setSessions(previous => [session, ...previous])
        setActiveId(session.id)
      },
      error => {
        if (cancelled.current) return
        setCreating(false)
        setChatError(errorMessage(error))
      },
    )
  }

  const send = () => {
    if (activeId === null || composer.trim() === '' || sending) return
    const text = composer
    setComposer('')
    setSending(true)
    setChatError(null)
    void transport
      .sendMessage(activeId, text)
      .then(() => transport.listMessages(activeId))
      .then(
        value => {
          if (cancelled.current) return
          setMessages(value)
          setSending(false)
          refreshMessages(activeId, true)
        },
        error => {
          if (cancelled.current) return
          setSending(false)
          const message = errorMessage(error)
          // 401/403 基本就是模型没登录：中继只透状态码，文案在这里补。
          setChatError(
            /401|403/.test(message)
              ? t('模型尚未登录：在终端运行 opencode auth login 后重试。')
              : message,
          )
        },
      )
  }

  if (!installed) {
    return (
      <section className="launch-panel">
        <div className="launch-copy">
          <h2>{t('先安装运行环境')}</h2>
          <p>{t('OpenCode 服务跑在访客 Ubuntu 里，没有运行时起不来。')}</p>
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
        <span className={`phase-badge ${server?.running === true ? 'phase-green' : 'phase-blue'}`}>
          <span className="phase-dot" />
          {server === null ? t('读取中') : server.running ? t('服务运行中') : t('服务未启动')}
        </span>
        <button
          className="button button-secondary compact-button"
          type="button"
          onClick={toggleServer}
          disabled={serverBusy || (server?.running !== true && harnessRunning)}
          title={server?.running !== true && harnessRunning ? t('Harness 运行时不能同时启动 Agent 服务，请先停止 Harness。') : undefined}
        >
          {serverBusy ? <Loader2 className="spin" size={16} /> : <Power size={16} />}
          {server?.running === true ? t('停止服务') : t('启动服务')}
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

      {server?.running === true && (
        <>
          <section className="chat-sessions" aria-label={t('会话')}>
            <button className="button button-secondary compact-button" type="button" onClick={createSession} disabled={creating}>
              {creating ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}{t('新会话')}
            </button>
            {loading && <span className="settings-note">{t('正在读取会话')}</span>}
            {sessions.map(session => (
              <button
                key={session.id}
                type="button"
                className={session.id === activeId ? 'chat-session active' : 'chat-session'}
                onClick={() => setActiveId(session.id)}
              >
                {session.title}
              </button>
            ))}
          </section>

          {chatError !== null && (
            <div className="inline-alert warning" role="alert">
              <div><strong>{chatError}</strong></div>
              {/401|403|登录/.test(chatError) && (
                <button className="button button-secondary compact-button" type="button" onClick={onOpenTerminal}>
                  <SquareTerminal size={16} />{t('打开终端登录')}
                </button>
              )}
            </div>
          )}

          <section className="chat-transcript" aria-live="polite" aria-label={t('对话')}>
            {messages.map((message, index) => (
              <div key={message.id !== '' ? message.id : `m${index}`} className={message.role === 'user' ? 'chat-message user message-in' : 'chat-message assistant message-in'}>
                <div className="chat-bubble">{message.text === '' ? t('(空消息)') : message.text}</div>
              </div>
            ))}
            {(sending || following) && (
              <div className="chat-message assistant">
                <div className="chat-bubble typing-dots" aria-label={t('正在输入')}>
                  <span /><span /><span />
                </div>
              </div>
            )}
            {messages.length === 0 && !sending && !following && (
              <p className="settings-note">{t('还没有消息，在下面输入第一句话。')}</p>
            )}
          </section>

          <div className="chat-composer">
            <input
              type="text"
              value={composer}
              onChange={event => setComposer(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') send()
              }}
              placeholder={t('输入消息，回车发送')}
              aria-label={t('输入消息')}
              disabled={activeId === null || sending}
            />
            <button
              className="button button-primary"
              type="button"
              onClick={send}
              disabled={activeId === null || composer.trim() === '' || sending}
              aria-label={t('发送')}
            >
              {sending ? <Loader2 className="spin" size={18} /> : <SendHorizontal size={18} />}
            </button>
          </div>
          <p className="settings-note">{t('模型用 OpenCode 自己的登录（终端运行 opencode auth login）；供应商 Key 与 Harness 不互通。')}</p>
        </>
      )}
    </div>
  )
}
