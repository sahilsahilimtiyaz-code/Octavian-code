import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  Check,
  FileText,
  GitFork,
  Image,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  SendHorizontal,
  Square,
  SquareTerminal,
  Trash2,
  X,
} from 'lucide-react'
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  createNativeAgentChat,
  errorMessageWithHint,
  formatTokens,
  guessAttachmentMime,
  pollUntilSettled,
  readDefaultAgent,
  readDefaultModelId,
  readDefaultVariant,
  sanitizeAttachmentName,
  saveDefaultAgent,
  saveDefaultModelId,
  saveDefaultVariant,
  sumUsage,
} from '../agentChat'
import { renderMarkdown } from '../markdown'
import { t } from '../i18n'
import type { ChatAttachment, ChatMessage, OpenCodeSession } from '../opencodeClient'
import type {
  AgentChatPart,
  AgentAgentOption,
  AgentEngineServerState,
  AgentEvent,
  AgentModelOption,
  AgentPermissionRequest,
  AgentQuestionRequest,
  PermissionDefaultsMode,
  RuntimeBridge,
} from '../platform/types'
import { validateAttachmentMime } from '../platform/validation'

interface OpenCodeChatPanelProps {
  bridge: RuntimeBridge
  /** 访客运行时是否已安装：没装则连服务都起不来，先走安装。 */
  installed: boolean
  /** Harness 是否在运行：在跑时不允许启动 Agent 服务（共用投递文件）。 */
  harnessRunning: boolean
  onInstall: () => void
  onOpenTerminal: () => void
}

/** 待发送的附件：选文件后先落点，发送时只带访客路径引用。 */
interface StagedFile {
  fileName: string
  mime: string
  guestPath: string
}

function errorMessage(error: unknown): string {
  // 原文 + 码对应的下一步（agentErrorHint）：横幅里一次看全，不用来回翻。
  return errorMessageWithHint(t('操作失败，请重试。'), error)
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(t('文件读取失败。')))
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      const comma = url.indexOf(',')
      if (comma < 0) {
        reject(new Error(t('文件读取失败。')))
        return
      }
      resolve(url.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}

/**
 * OpenCode 聊天面板：自有聊天界面的第一块拼图。
 *
 * 会话、消息、发送全部走原生中继（`runtimeBridge.agentChat*`）：Web 侧不直连
 * 本机服务、不碰密码。附件先落点（`inbox/attachments`）再以路径引用发送；
 * 图片引用按需读回画缩略图。发送后用“消息表不再变长”跟随轮询，有 SSE
 * 之前先这样跑；卸载时迟到的轮询一律丢弃。
 */
function AttachmentView({ attachment, thumb }: { attachment: ChatAttachment; thumb?: string }) {
  const name = attachment.url.slice(attachment.url.lastIndexOf('/') + 1) || t('附件')
  if (thumb !== undefined) {
    return <img className="chat-thumb" src={thumb} alt={name} loading="lazy" />
  }
  return (
    <span className="chat-chip">
      {attachment.kind === 'image' ? <Image size={14} /> : <FileText size={14} />}
      {name}
    </span>
  )
}

function usageSummary(messages: ChatMessage[]): ReactNode {
  const usage = sumUsage(messages)
  if (usage === null) return null
  return (
    <p className="settings-note">
      {t('本会话用量：输入 ')}{formatTokens(usage.input)}{t(' · 输出 ')}{formatTokens(usage.output)}
    </p>
  )
}
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
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [sessionBusy, setSessionBusy] = useState<string | null>(null)
  const [failedSend, setFailedSend] = useState<string | null>(null)
  const [regenerating, setRegenerating] = useState(false)
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)
  const [staged, setStaged] = useState<StagedFile[]>([])
  const [staging, setStaging] = useState(false)
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [thumbFailed, setThumbFailed] = useState<Record<string, boolean>>({})
  const [models, setModels] = useState<AgentModelOption[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [modelsRefreshing, setModelsRefreshing] = useState(false)
  const [policy, setPolicy] = useState<PermissionDefaultsMode>('ask')
  const [policyBusy, setPolicyBusy] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>(() => readDefaultModelId())
  const [selectedVariant, setSelectedVariant] = useState<string>(() => readDefaultVariant())
  const [agents, setAgents] = useState<AgentAgentOption[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string>(() => readDefaultAgent())
  const [sessionModels, setSessionModels] = useState<Record<string, string>>({})
  const [permissions, setPermissions] = useState<AgentPermissionRequest[]>([])
  const [questions, setQuestions] = useState<AgentQuestionRequest[]>([])
  const [approvalsBusy, setApprovalsBusy] = useState<string | null>(null)
  const [pickedAnswers, setPickedAnswers] = useState<Record<string, string[]>>({})
  const [stopping, setStopping] = useState(false)
  const [forking, setForking] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  /**
   * 当前会话的**同步锚点**（与 CodexChatPanel 同一套）：state 的 `activeId`
   * 要等重渲染才生效，而 `listMessages` 的 resolve、轮询、SSE 事件都在这之前
   * 回来。异步结果一律与它比对——旧会话的迟到结果直接丢弃，否则切走后
   * 旧会话的消息/审批卡会盖掉正在看的新会话。
   */
  const activeIdRef = useRef<string | null>(null)

  /** 切换会话的唯一入口：先落同步锚点，再触发 state 更新。 */
  const selectSession = useCallback((id: string | null) => {
    activeIdRef.current = id
    setActiveId(id)
  }, [])

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
            selectSession(selectId)
          } else if (value.length > 0 && activeIdRef.current === null) {
            // 只在从未选中过时自动选第一条：每次刷新都重置会把用户手动选的会话顶掉。
            selectSession(value[0].id)
          }
        },
        error => {
          if (cancelled.current) return
          setLoading(false)
          setChatError(errorMessage(error))
        },
      )
    },
    [transport, selectSession],
  )

  useEffect(() => {
    if (server?.running === true) refreshSessions()
  }, [server?.running, refreshSessions])

  const refreshModels = useCallback(() => {
    setModelsError(null)
    void transport.listModels().then(
      value => {
        if (cancelled.current) return
        setModels(value)
        setModelsRefreshing(false)
      },
      error => {
        if (cancelled.current) return
        setModelsRefreshing(false)
        setModelsError(errorMessage(error))
      },
    )
  }, [transport])

  const refreshPolicy = useCallback(() => {
    void transport.permissionDefaults().then(
      mode => {
        if (!cancelled.current) setPolicy(mode)
      },
      () => undefined,
    )
  }, [transport])

  const refreshAgents = useCallback(() => {
    void transport.listAgents().then(
      value => {
        if (!cancelled.current) setAgents(value)
      },
      () => undefined,
    )
  }, [transport])

  useEffect(() => {
    if (server?.running === true) {
      refreshModels()
      refreshPolicy()
      refreshAgents()
    }
  }, [server?.running, refreshModels, refreshPolicy, refreshAgents])

  const setPolicyMode = (mode: 'ask' | 'lenient' | 'strict') => {
    setPolicyBusy(true)
    void transport.permissionDefaultsSet(mode).then(
      next => {
        if (cancelled.current) return
        setPolicyBusy(false)
        setPolicy(next)
      },
      error => {
        if (cancelled.current) return
        setPolicyBusy(false)
        setChatError(errorMessage(error))
      },
    )
  }

  // 当前选中的模型条目：目录里找不到（密钥没配/模型下线）就按未选择处理，
  // 新会话走服务端默认，而不是拿一个不存在的 id 去建会话。
  const selectedOption = models.find(option => option.id === selectedModel)
  const variantOptions = selectedOption?.variants ?? []
  const effectiveVariant = variantOptions.includes(selectedVariant) ? selectedVariant : ''

  const pickModel = (id: string) => {
    setSelectedModel(id)
    saveDefaultModelId(id)
    const next = models.find(option => option.id === id)
    if (next === undefined || !next.variants.includes(selectedVariant)) {
      setSelectedVariant('')
      saveDefaultVariant('')
    }
  }

  const pickVariant = (variant: string) => {
    setSelectedVariant(variant)
    saveDefaultVariant(variant)
  }

  // 当前选中的代理：目录里找不到就按没选处理（密钥没配/代理下线时）。
  const effectiveAgent = agents.some(option => option.id === selectedAgent) ? selectedAgent : ''

  const pickAgent = (id: string) => {
    setSelectedAgent(id)
    saveDefaultAgent(id)
  }

  const refreshMessages = useCallback(
    (sessionId: string, follow = false) => {
      // 归属闸：为别的会话发起的读取直接作废（发起时它还是当前会话，随后被切走）。
      if (activeIdRef.current !== sessionId) return
      const isStale = () => cancelled.current || activeIdRef.current !== sessionId
      if (follow) setFollowing(true)
      void transport.listMessages(sessionId).then(
        value => {
          if (isStale()) return
          setMessages(value)
          if (follow) {
            void pollUntilSettled(() => transport.listMessages(sessionId), {
              intervalMs: 2000,
              shouldContinue: () => !isStale(),
            }).then(
              settled => {
                if (isStale()) return
                setMessages(settled)
                setFollowing(false)
              },
              () => {
                if (isStale()) return
                setFollowing(false)
              },
            )
          }
        },
        error => {
          if (isStale()) return
          setChatError(errorMessage(error))
          if (follow) setFollowing(false)
        },
      )
    },
    [transport],
  )

  useEffect(() => {
    // 切走会话：旧会话的进行中状态不带过来。`following` 若不清会永远为 true
    // （为旧会话跑的轮询已被归属闸终止，不会再有人来关它），界面卡在“正在输入”。
    setFollowing(false)
    setSending(false)
    setRegenerating(false)
    setStopping(false)
    setQuestions([])
    setPermissions([])
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

  const attachFiles = (files: FileList | null) => {
    if (files === null || files.length === 0) return
    const room = ATTACHMENT_MAX_PER_MESSAGE - staged.length
    if (room <= 0) {
      setChatError(t('一次最多 4 个附件，先发送或移除已选的。'))
      return
    }
    const picked = Array.from(files).slice(0, room)
    setStaging(true)
    setChatError(null)
    void Promise.all(
      picked.map(async file => {
        if (file.size > ATTACHMENT_MAX_BYTES) throw new Error(t('附件超过 8MB 上限。'))
        const mime = file.type !== '' ? file.type : guessAttachmentMime(file.name) ?? ''
        validateAttachmentMime(mime)
        const dataBase64 = await readFileAsBase64(file)
        let safeName = sanitizeAttachmentName(file.name)
        const extension = /\.([A-Za-z0-9]+)$/.exec(file.name)?.[1]?.toLowerCase()
        if (!safeName.includes('.') && extension !== undefined && guessAttachmentMime(`x.${extension}`) === mime) {
          safeName = `${safeName}.${extension}`
        }
        const stagedOne = await transport.stageAttachment(safeName, mime, dataBase64)
        return { fileName: safeName, mime, guestPath: stagedOne.path }
      }),
    ).then(
      added => {
        if (cancelled.current) return
        setStaging(false)
        setStaged(previous => [...previous, ...added])
      },
      error => {
        if (cancelled.current) return
        setStaging(false)
        setChatError(errorMessage(error))
      },
    )
  }

  const removeStaged = (guestPath: string) => {
    setStaged(previous => previous.filter(item => item.guestPath !== guestPath))
  }

  // 画廊：消息里的图片引用按需读成 data URL；读不到的只记一次失败，显示文件名。
  useEffect(() => {
    if (server?.running !== true) return
    const wanted = new Set<string>()
    for (const message of messages) {
      for (const attachment of message.attachments) {
        if (
          attachment.kind === 'image' &&
          (attachment.mime.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(attachment.url))
        ) {
          wanted.add(attachment.url)
        }
      }
    }
    wanted.forEach(url => {
      if (thumbs[url] !== undefined || thumbFailed[url] === true) return
      void transport.readAttachment(url).then(
        content => {
          if (!cancelled.current) {
            setThumbs(previous => ({ ...previous, [url]: `data:${content.mime};base64,${content.dataBase64}` }))
          }
        },
        () => {
          if (!cancelled.current) setThumbFailed(previous => ({ ...previous, [url]: true }))
        },
      )
    })
  }, [messages, server?.running, transport, thumbs, thumbFailed])

  const refreshApprovals = useCallback(
    (sessionId: string) => {
      // 与消息同一条归属闸：审批卡是会话私有状态，旧会话的迟到轮询不许覆盖。
      if (activeIdRef.current !== sessionId) return
      const isStale = () => cancelled.current || activeIdRef.current !== sessionId
      void transport.listQuestions(sessionId).then(
        value => {
          if (!isStale()) setQuestions(value)
        },
        () => {
          // 待答轮询失败不炸出横幅：审批卡片缺席比满屏报错好，下轮再试。
        },
      )
      void transport.permissionFeed(sessionId).then(
        value => {
          if (!isStale()) setPermissions(value)
        },
        () => undefined,
      )
    },
    [transport],
  )

  const handleAgentEvent = useCallback(
    (event: AgentEvent) => {
      const sessionId = activeIdRef.current
      // 审批与问答事件立刻拉一次卡片；其它事件在跟随时顺手刷新一次消息表。
      if (event.type.includes('permission') || event.type.includes('question')) {
        if (sessionId !== null) refreshApprovals(sessionId)
        return
      }
      if (sessionId !== null && (sending || following)) {
        void transport.listMessages(sessionId).then(
          value => {
            if (cancelled.current || activeIdRef.current !== sessionId) return
            setMessages(value)
          },
          () => undefined,
        )
      }
    },
    [refreshApprovals, sending, following, transport],
  )

  useEffect(() => {
    if (server?.running !== true || !supported) return
    let stop: (() => void) | undefined
    let done = false
    void transport
      .subscribeEvents(event => {
        if (!done) handleAgentEvent(event)
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
  }, [server?.running, supported, transport, handleAgentEvent])

  // 跟随期间顺带轮询审批（SSE 万一没通，卡片最多晚几秒出现，不会永远缺席）。
  useEffect(() => {
    if (activeId === null || (!sending && !following)) return
    const sessionId = activeId
    refreshApprovals(sessionId)
    const timer = window.setInterval(() => {
      if (!cancelled.current) refreshApprovals(sessionId)
    }, 4000)
    return () => window.clearInterval(timer)
  }, [activeId, sending, following, refreshApprovals])

  const startRename = (session: OpenCodeSession) => {
    setDeleting(null)
    setRenaming({ id: session.id, draft: session.title })
  }

  const confirmRename = () => {
    if (renaming === null) return
    const title = renaming.draft.trim()
    if (title === '' || title.length > 120) {
      setChatError(t('会话标题为 1–120 个字符。'))
      return
    }
    const renamedId = renaming.id
    setSessionBusy(renamedId)
    setChatError(null)
    void transport.renameSession(renamedId, title).then(
      () => {
        if (cancelled.current) return
        setSessionBusy(null)
        setRenaming(null)
        setSessions(previous => previous.map(item => (item.id === renamedId ? { ...item, title } : item)))
      },
      error => {
        if (cancelled.current) return
        setSessionBusy(null)
        setChatError(errorMessage(error))
      },
    )
  }

  const confirmDelete = (sessionId: string) => {
    setSessionBusy(sessionId)
    setChatError(null)
    void transport.deleteSession(sessionId).then(
      () => {
        if (cancelled.current) return
        setSessionBusy(null)
        setDeleting(null)
        setRenaming(current => (current?.id === sessionId ? null : current))
        const remaining = sessions.filter(item => item.id !== sessionId)
        setSessions(remaining)
        if (activeIdRef.current === sessionId) {
          selectSession(remaining.length > 0 ? remaining[0].id : null)
        }
      },
      error => {
        if (cancelled.current) return
        setSessionBusy(null)
        setDeleting(null)
        setChatError(errorMessage(error))
      },
    )
  }

  const createSession = () => {
    setCreating(true)
    setChatError(null)
    const title = `${t('新会话')} ${new Date().toLocaleString()}`
    const model = selectedOption?.id
    const variant = model !== undefined && effectiveVariant !== '' ? effectiveVariant : undefined
    const agent = effectiveAgent === '' ? undefined : effectiveAgent
    void transport.createSession(title, model, variant, agent).then(
      session => {
        if (cancelled.current) return
        setCreating(false)
        setSessions(previous => [session, ...previous])
        const labelParts = [model, variant, agent].filter((part): part is string => part !== undefined && part !== '')
        if (labelParts.length > 0) {
          const label = labelParts.join(' · ')
          setSessionModels(previous => ({ ...previous, [session.id]: label }))
        }
        selectSession(session.id)
      },
      error => {
        if (cancelled.current) return
        setCreating(false)
        setChatError(errorMessage(error))
      },
    )
  }

  const send = () => {
    const sessionId = activeId
    if (sessionId === null || sending) return
    const text = composer.trim()
    const withFiles = staged.length > 0
    const parts: AgentChatPart[] = []
    if (text !== '') parts.push({ type: 'text', text })
    for (const item of staged) {
      parts.push({
        type: item.mime.startsWith('image/') ? 'image' : 'file',
        mime: item.mime,
        url: item.guestPath,
      })
    }
    if (parts.length === 0) return
    setComposer('')
    setStaged([])
    setSending(true)
    setFailedSend(null)
    setChatError(null)
    void transport
      .sendMessage(sessionId, text, withFiles ? parts : undefined)
      .then(() => transport.listMessages(sessionId))
      .then(
        value => {
          if (cancelled.current) return
          // 发言期间切走了会话：结果属于旧会话，不许写进新会话的转录。
          if (activeIdRef.current !== sessionId) return
          setMessages(value)
          setSending(false)
          refreshMessages(sessionId, true)
        },
        error => {
          if (cancelled.current) return
          if (activeIdRef.current !== sessionId) return
          setSending(false)
          // 发送失败把正文还给输入框：字不能丢，重试按钮直接再发一次。
          if (!withFiles) {
            setComposer(text)
            setFailedSend(text)
          }
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

  /**
   * 重新生成：删掉最后一条用户消息之后的所有回复，原样重发那条用户消息。
   *
   * 先验后删：只要有一条待删消息没有服务端 id，整单取消，一条都不碰——
   * 删一半发一半是最坏的结果。
   */
  const regenerate = () => {
    if (activeId === null || busy || regenerating) return
    const sessionId = activeId
    const reversed = [...messages].reverse()
    const lastUserOffset = reversed.findIndex(message => message.role === 'user')
    if (lastUserOffset === -1) {
      setChatError(t('没有可重新生成的用户消息。'))
      return
    }
    const lastUser = reversed[lastUserOffset]
    const trailing = reversed.slice(0, lastUserOffset)
    if (lastUser.id === '' || trailing.some(message => message.id === '')) {
      setChatError(t('该会话缺少消息标识，无法重写，请用分叉另起一局。'))
      return
    }
    setRegenerating(true)
    setChatError(null)
    void (async () => {
      try {
        // 切走会话不中断循环：删一半发一半是最坏结果，服务端的重写要整单做完；
        // 只把 UI 收尾挡在归属闸外（切走时切换效果已复位这些状态）。
        for (const message of trailing) {
          if (cancelled.current) return
          await transport.deleteMessage(sessionId, message.id)
        }
        if (cancelled.current) return
        await transport.sendMessage(sessionId, lastUser.text)
        if (cancelled.current || activeIdRef.current !== sessionId) return
        setRegenerating(false)
        refreshMessages(sessionId, true)
      } catch (error) {
        if (cancelled.current || activeIdRef.current !== sessionId) return
        setRegenerating(false)
        setChatError(errorMessage(error))
      }
    })()
  }

  /**
   * 编辑重发：改某条用户消息，删掉它及之后的一切，用改过的正文重发。
   * 同样先验后删，无 id 不动手。
   */
  const confirmEdit = () => {
    if (editing === null || activeId === null || busy) return
    const sessionId = activeId
    const draft = editing.draft.trim()
    if (draft === '') {
      setChatError(t('消息内容不能为空。'))
      return
    }
    const index = messages.findIndex(message => message.id === editing.id && message.id !== '')
    if (index === -1) {
      setChatError(t('找不到要编辑的消息，请刷新后重试。'))
      return
    }
    const targets = messages.slice(index)
    if (targets.some(message => message.id === '')) {
      setChatError(t('该会话缺少消息标识，无法重写，请用分叉另起一局。'))
      return
    }
    setEditing(null)
    setSending(true)
    setChatError(null)
    void (async () => {
      try {
        for (const message of targets) {
          if (cancelled.current) return
          await transport.deleteMessage(sessionId, message.id)
        }
        if (cancelled.current) return
        await transport.sendMessage(sessionId, draft)
        if (cancelled.current || activeIdRef.current !== sessionId) return
        setSending(false)
        refreshMessages(sessionId, true)
      } catch (error) {
        if (cancelled.current || activeIdRef.current !== sessionId) return
        setSending(false)
        setComposer(draft)
        setFailedSend(draft)
        setChatError(errorMessage(error))
      }
    })()
  }

  const busy = sending || following

  /** 停止本轮：先让服务端 abort，再停掉本地的跟随轮询，两侧都停才算真停。 */
  const stopRun = () => {
    const sessionId = activeId
    if (sessionId === null || (!sending && !following) || stopping) return
    setStopping(true)
    void transport.abortSession(sessionId).then(
      () => {
        if (cancelled.current) return
        setStopping(false)
        if (activeIdRef.current !== sessionId) return
        setSending(false)
        setFollowing(false)
        refreshMessages(sessionId)
      },
      error => {
        if (cancelled.current) return
        setStopping(false)
        if (activeIdRef.current !== sessionId) return
        setSending(false)
        setFollowing(false)
        setChatError(errorMessage(error))
      },
    )
  }

  /** 从最后一条用户消息分叉：原会话保留，新会话接管继续。 */
  const forkSession = () => {
    if (activeId === null || forking || sending || following) return
    const lastUser = [...messages].reverse().find(message => message.role === 'user' && message.id !== '')
    if (lastUser === undefined) {
      setChatError(t('没有可分叉的用户消息。'))
      return
    }
    forkFrom(lastUser.id)
  }

  /**
   * 从任意一条消息分叉：原会话保留到分叉点，新会话接管继续。
   * 无服务端 id 的消息不显示入口（见气泡），这里再拦一道。
   */
  const forkFrom = (messageId: string) => {
    if (activeId === null || forking || sending || following) return
    if (messageId === '') {
      setChatError(t('该消息缺少标识，无法分叉。'))
      return
    }
    const sessionId = activeId
    setForking(true)
    setChatError(null)
    void transport.forkSession(sessionId, messageId).then(
      session => {
        if (cancelled.current) return
        setForking(false)
        setSessions(previous => [session, ...previous])
        selectSession(session.id)
      },
      error => {
        if (cancelled.current) return
        setForking(false)
        setChatError(errorMessage(error))
      },
    )
  }

  const replyPermission = (requestId: string, reply: 'once' | 'always' | 'reject') => {
    if (activeId === null) return
    const key = `permission:${requestId}`
    setApprovalsBusy(key)
    void transport.replyPermission(activeId, requestId, reply).then(
      () => {
        if (cancelled.current) return
        setApprovalsBusy(null)
        refreshApprovals(activeId)
      },
      error => {
        if (cancelled.current) return
        setApprovalsBusy(null)
        setChatError(errorMessage(error))
      },
    )
  }

  const toggleAnswer = (key: string, label: string) => {
    setPickedAnswers(previous => {
      const current = previous[key] ?? []
      return {
        ...previous,
        [key]: current.includes(label) ? current.filter(item => item !== label) : [...current, label],
      }
    })
  }

  const submitAnswers = (requestId: string, questionIndex: number) => {
    if (activeId === null) return
    const key = `${requestId}:${questionIndex}`
    const answers = pickedAnswers[key] ?? []
    if (answers.length === 0) {
      setChatError(t('请先勾选至少一个选项。'))
      return
    }
    const busyKey = `question:${key}`
    setApprovalsBusy(busyKey)
    void transport.replyQuestion(activeId, requestId, answers).then(
      () => {
        if (cancelled.current) return
        setApprovalsBusy(null)
        refreshApprovals(activeId)
      },
      error => {
        if (cancelled.current) return
        setApprovalsBusy(null)
        setChatError(errorMessage(error))
      },
    )
  }

  const rejectQuestion = (requestId: string) => {
    if (activeId === null) return
    const busyKey = `question-reject:${requestId}`
    setApprovalsBusy(busyKey)
    void transport.rejectQuestion(activeId, requestId).then(
      () => {
        if (cancelled.current) return
        setApprovalsBusy(null)
        refreshApprovals(activeId)
      },
      error => {
        if (cancelled.current) return
        setApprovalsBusy(null)
        setChatError(errorMessage(error))
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
          {server === null ? t('读取中') : server.running ? `${t('服务运行中')} :${server.port}` : t('服务未启动')}
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
        <section className="chat-modelbar" aria-label={t('模型')}>
          <select
            className="chat-select"
            value={selectedOption?.id ?? ''}
            onChange={event => pickModel(event.target.value)}
            aria-label={t('新会话模型')}
          >
            <option value="">{t('默认模型')}</option>
            {Array.from(
              models.reduce((groups, option) => {
                const group = groups.get(option.providerName) ?? []
                group.push(option)
                groups.set(option.providerName, group)
                return groups
              }, new Map<string, AgentModelOption[]>()),
            ).map(([providerName, options]) => (
              <optgroup key={providerName} label={providerName}>
                {options.map(option => (
                  <option key={option.id} value={option.id} disabled={option.deprecated}>
                    {option.name}{option.deprecated ? t('（已下线）') : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {variantOptions.length > 0 && (
            <select
              className="chat-select"
              value={effectiveVariant}
              onChange={event => pickVariant(event.target.value)}
              aria-label={t('Effort 档位')}
              title={t('该模型声明的 effort 档位；不选则用服务端默认')}
            >
              <option value="">{t('默认档位')}</option>
              {variantOptions.map(variant => (
                <option key={variant} value={variant}>{variant}</option>
              ))}
            </select>
          )}
          {agents.length > 0 && (
            <select
              className="chat-select"
              value={effectiveAgent}
              onChange={event => pickAgent(event.target.value)}
              aria-label={t('执行代理')}
              title={t('新会话的默认执行代理；不选则用服务端默认')}
            >
              <option value="">{t('默认代理')}</option>
              {agents.map(option => (
                <option key={option.id} value={option.id} title={option.description}>
                  {option.name}
                </option>
              ))}
            </select>
          )}
          <button
            className="icon-button chat-row-button"
            type="button"
            onClick={() => {
              setModelsRefreshing(true)
              refreshModels()
            }}
            disabled={modelsRefreshing}
            title={t('刷新模型目录')}
            aria-label={t('刷新模型目录')}
          >
            {modelsRefreshing ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          </button>
          {modelsError !== null && <span className="settings-note">{modelsError}</span>}
        </section>
      )}

      {server?.running === true && (
        <section className="chat-modelbar" aria-label={t('审批策略')}>
          <span className="settings-note">{t('默认审批')}</span>
          <div className="segmented" role="tablist" aria-label={t('默认审批策略')}>
            {(
              [
                ['ask', t('每次询问')],
                ['lenient', t('宽松')],
                ['strict', t('严格')],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={policy === mode}
                className={policy === mode ? 'active' : ''}
                disabled={policyBusy}
                onClick={() => setPolicyMode(mode)}
                title={
                  mode === 'ask'
                    ? t('缺省：每条敏感操作都弹窗确认')
                    : mode === 'lenient'
                      ? t('编辑与常用命令默认放行，保存后重启服务生效')
                      : t('编辑与命令默认拒绝，保存后重启服务生效')
                }
              >
                {label}
              </button>
            ))}
          </div>
          {policy === 'custom' && (
            <span className="settings-note">{t('终端手写过其它规则：选一档即覆盖。')}</span>
          )}
        </section>
      )}

      {server?.running === true && (
        <>
          <section className="chat-sessions" aria-label={t('会话')}>
            <button className="button button-secondary compact-button" type="button" onClick={createSession} disabled={creating}>
              {creating ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}{t('新会话')}
            </button>
            <button
              className="button button-secondary compact-button"
              type="button"
              onClick={forkSession}
              disabled={forking || sending || following || activeId === null}
              title={t('从最后一条用户消息分叉出新会话，原会话保留')}
            >
              {forking ? <Loader2 className="spin" size={16} /> : <GitFork size={16} />}{t('分叉')}
            </button>
            <button
              className="button button-secondary compact-button"
              type="button"
              onClick={regenerate}
              disabled={regenerating || sending || following || activeId === null || messages.length === 0}
              title={t('删掉最后一条用户消息之后的回复，原样重发那条消息')}
            >
              {regenerating ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}{t('重新生成')}
            </button>
            {loading && <span className="settings-note">{t('正在读取会话')}</span>}
            {sessions.map(session => {
              const busyRow = sessionBusy === session.id
              const armingDelete = deleting === session.id
              if (renaming?.id === session.id) {
                return (
                  <span className="chat-session-row" key={session.id}>
                    <input
                      className="chat-rename-input"
                      type="text"
                      value={renaming.draft}
                      maxLength={120}
                      onChange={event => setRenaming({ id: session.id, draft: event.target.value })}
                      onKeyDown={event => {
                        if (event.key === 'Enter') confirmRename()
                        if (event.key === 'Escape') setRenaming(null)
                      }}
                      aria-label={t('会话新标题')}
                      autoFocus
                    />
                    <button
                      className="icon-button chat-row-button"
                      type="button"
                      onClick={confirmRename}
                      disabled={busyRow}
                      aria-label={t('保存标题')}
                    >
                      {busyRow ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
                    </button>
                    <button
                      className="icon-button chat-row-button"
                      type="button"
                      onClick={() => setRenaming(null)}
                      aria-label={t('取消')}
                    >
                      <X size={16} />
                    </button>
                  </span>
                )
              }
              return (
                <span className="chat-session-row" key={session.id}>
                  <button
                    type="button"
                    className={session.id === activeId ? 'chat-session active' : 'chat-session'}
                    onClick={() => selectSession(session.id)}
                  >
                    {session.title}
                  </button>
                  <button
                    className="icon-button chat-row-button"
                    type="button"
                    onClick={() => startRename(session)}
                    title={t('重命名')}
                    aria-label={t('重命名会话')}
                  >
                    <Pencil size={15} />
                  </button>
                  {armingDelete ? (
                    <button
                      className="button button-danger-quiet compact-button"
                      type="button"
                      onClick={() => confirmDelete(session.id)}
                      disabled={busyRow}
                      title={t('再次点击确认删除，删除后不可恢复')}
                    >
                      {busyRow ? <Loader2 className="spin" size={16} /> : t('确认删除')}
                    </button>
                  ) : (
                    <button
                      className="icon-button chat-row-button"
                      type="button"
                      onClick={() => setDeleting(session.id)}
                      title={t('删除会话')}
                      aria-label={t('删除会话')}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </span>
              )
            })}
          </section>

          {chatError !== null && (
            <div className="inline-alert warning" role="alert">
              <div><strong>{chatError}</strong></div>
              {failedSend !== null && (
                <button className="button button-secondary compact-button" type="button" onClick={send}>
                  <RefreshCw size={16} />{t('重试发送')}
                </button>
              )}
              {/401|403|登录/.test(chatError) && (
                <button className="button button-secondary compact-button" type="button" onClick={onOpenTerminal}>
                  <SquareTerminal size={16} />{t('打开终端登录')}
                </button>
              )}
            </div>
          )}

          {(permissions.length > 0 || questions.length > 0) && (
            <section className="chat-approvals" aria-label={t('待审批')}>
              {permissions.map(request => (
                <div className="approval-card" key={`permission:${request.id}`}>
                  <div className="approval-title">{t('权限审批')}</div>
                  <div className="approval-detail">{request.action}</div>
                  {request.resources.length > 0 && (
                    <div className="approval-resources">{request.resources.join(' · ')}</div>
                  )}
                  <div className="approval-actions">
                    <button
                      className="button button-secondary compact-button"
                      type="button"
                      disabled={approvalsBusy !== null}
                      onClick={() => replyPermission(request.id, 'once')}
                    >
                      {approvalsBusy === `permission:${request.id}` ? <Loader2 className="spin" size={16} /> : <Check size={16} />}{t('仅一次')}
                    </button>
                    <button
                      className="button button-secondary compact-button"
                      type="button"
                      disabled={approvalsBusy !== null}
                      onClick={() => replyPermission(request.id, 'always')}
                    >
                      {t('始终允许')}
                    </button>
                    <button
                      className="button button-danger-quiet compact-button"
                      type="button"
                      disabled={approvalsBusy !== null}
                      onClick={() => replyPermission(request.id, 'reject')}
                    >
                      {t('拒绝')}
                    </button>
                  </div>
                </div>
              ))}
              {questions.map(request => (
                <div className="approval-card" key={`question:${request.id}`}>
                  {request.questions.map((question, questionIndex) => {
                    const key = `${request.id}:${questionIndex}`
                    const picked = pickedAnswers[key] ?? []
                    return (
                      <div className="approval-question" key={key}>
                        {question.header !== '' && <div className="approval-title">{question.header}</div>}
                        {question.question !== '' && <div className="approval-detail">{question.question}</div>}
                        {question.options.map(option => (
                          <label className="approval-option" key={option.label}>
                            <input
                              type="checkbox"
                              checked={picked.includes(option.label)}
                              onChange={() => toggleAnswer(key, option.label)}
                            />
                            <span>{option.label}</span>
                            {option.description !== '' && <small>{option.description}</small>}
                          </label>
                        ))}
                        <div className="approval-actions">
                          <button
                            className="button button-primary compact-button"
                            type="button"
                            disabled={approvalsBusy !== null || picked.length === 0}
                            onClick={() => submitAnswers(request.id, questionIndex)}
                          >
                            {approvalsBusy === `question:${key}` ? <Loader2 className="spin" size={16} /> : <Check size={16} />}{t('提交答案')}
                          </button>
                          <button
                            className="button button-secondary compact-button"
                            type="button"
                            disabled={approvalsBusy !== null}
                            onClick={() => rejectQuestion(request.id)}
                          >
                            {t('拒绝')}
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}
            </section>
          )}

          <section className="chat-transcript" aria-live="polite" aria-label={t('对话')}>
            {activeId !== null && sessionModels[activeId] !== undefined && (
              <p className="settings-note">{t('当前会话模型：')}{sessionModels[activeId]}</p>
            )}
            {usageSummary(messages)}
            {messages.map((message, index) => (
              <div
                // 键加 index 后缀兜底唯一：服务端 id 缺失/重复时 React 会复用错
                // DOM 节点（滚动锚点跳动、气泡串内容），id 前缀保证新增时稳定。
                key={message.id !== '' ? `${message.id}:${index}` : `m${index}`}
                className={message.role === 'user' ? 'chat-message user message-in' : 'chat-message assistant message-in'}
              >
                <div className="chat-bubble">
                  {message.reasoning.length > 0 && (
                    <details className="chat-reasoning">
                      <summary>{t('思考过程')}</summary>
                      {message.reasoning.map((thought, thoughtIndex) => (
                        <p key={thoughtIndex}>{thought}</p>
                      ))}
                    </details>
                  )}
                  {editing?.id === message.id && message.id !== '' ? (
                    <span className="chat-edit">
                      <textarea
                        value={editing.draft}
                        rows={3}
                        onChange={event => setEditing({ id: message.id, draft: event.target.value })}
                        aria-label={t('编辑消息')}
                        autoFocus
                      />
                      <span className="chat-edit-actions">
                        <button
                          className="button button-primary compact-button"
                          type="button"
                          onClick={confirmEdit}
                          disabled={busy}
                        >
                          {t('保存重发')}
                        </button>
                        <button
                          className="button button-secondary compact-button"
                          type="button"
                          onClick={() => setEditing(null)}
                        >
                          {t('取消')}
                        </button>
                      </span>
                    </span>
                  ) : (
                    <>
                      {message.text === '' && message.attachments.length === 0 ? (
                        t('(空消息)')
                      ) : (
                        <span dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
                      )}
                      {message.id !== '' && (
                        <span className="chat-message-actions">
                          {message.role === 'user' && (
                            <button
                              className="chat-edit-button"
                              type="button"
                              onClick={() => {
                                setEditing({ id: message.id, draft: message.text })
                              }}
                              disabled={busy}
                              title={t('编辑后重发')}
                            >
                              {t('编辑')}
                            </button>
                          )}
                          <button
                            className="chat-edit-button"
                            type="button"
                            onClick={() => forkFrom(message.id)}
                            disabled={busy || forking}
                            title={t('从这条消息分叉出新会话')}
                          >
                            {t('分叉')}
                          </button>
                        </span>
                      )}
                    </>
                  )}
                  {message.attachments.length > 0 && (
                    <span className="chat-attachments">
                      {message.attachments.map(attachment => (
                        <AttachmentView
                          key={attachment.url}
                          attachment={attachment}
                          thumb={thumbs[attachment.url]}
                        />
                      ))}
                    </span>
                  )}
                </div>
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

          {staged.length > 0 && (
            <div className="chat-staged" aria-label={t('待发送附件')}>
              {staged.map(item => (
                <span className="chat-chip" key={item.guestPath}>
                  {item.mime.startsWith('image/') ? <Image size={14} /> : <FileText size={14} />}
                  {item.fileName}
                  <button type="button" aria-label={t('移除附件')} onClick={() => removeStaged(item.guestPath)}>
                    <X size={14} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className={busy ? 'chat-composer busy' : 'chat-composer'}>
            <input
              ref={fileInput}
              type="file"
              hidden
              multiple
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,.txt,.md"
              aria-hidden="true"
              tabIndex={-1}
              onChange={event => {
                attachFiles(event.target.files)
                event.target.value = ''
              }}
            />
            <button
              className="icon-button"
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={activeId === null || sending || staging}
              title={t('添加附件（图片、PDF、文本，单个 8MB 以内）')}
              aria-label={t('添加附件')}
            >
              {staging ? <Loader2 className="spin" size={18} /> : <Paperclip size={18} />}
            </button>
            <input
              type="text"
              value={composer}
              onChange={event => setComposer(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') send()
              }}
              placeholder={t('输入消息，回车发送')}
              aria-label={t('输入消息')}
              disabled={activeId === null || busy}
            />
            <button
              className="button button-primary"
              type="button"
              onClick={busy ? stopRun : send}
              disabled={activeId === null || stopping || staging || (!busy && composer.trim() === '' && staged.length === 0)}
              aria-label={busy ? t('停止') : t('发送')}
              title={busy ? t('中止本轮运行') : undefined}
            >
              {busy ? (
                stopping ? <Loader2 className="spin" size={18} /> : <Square size={18} />
              ) : staging ? (
                <Loader2 className="spin" size={18} />
              ) : (
                <SendHorizontal size={18} />
              )}
            </button>
          </div>
          <p className="settings-note">{t('模型用 OpenCode 自己的登录（终端运行 opencode auth login）；供应商 Key 与 Harness 不互通。')}</p>
        </>
      )}
    </div>
  )
}
