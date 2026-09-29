import { validatePluginCatalog, validatePluginRequest } from './plugins'
import { parseAgentModels, parseJsonPayload } from '../opencodeClient'
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { createBrowserBridge } from './browser'
import { validateSelfCheckOperation, type SelfCheckOperation } from '../runtimeSelfCheck'
import type {
  AgentEvent,
  AppThemeMode,
  PluginRequest,
  PluginCatalog,
  CodexEvent,
  DeviceCommand,
  DeviceCommandResult,
  DiagnosticLogExport,
  DiagnosticLogState,
  KeepAliveState,
  NotificationPermissionResult,
  RuntimeBridge,
  RuntimeProgress,
  RuntimeSettings,
  RuntimeSettingsUpdate,
  RuntimeSource,
  RuntimeState,
  ShizukuState,
  TerminalChunk,
  TerminalExit,
  TerminalKind,
} from './types'
import {
  assertBase64Input,
  assertDiagnosticRetentionDays,
  assertMailboxSubdirectory,
  assertRuntimeVersionTarget,
  assertSessionId,
  assertStorageDirPath,
  assertTerminalKind,
  assertTerminalSize,
  validateAgentCliName,
  validateAgentCliStates,
  validateAgentChatJson,
  validateAgentChatParts,
  validateAgentChatText,
  validateAgentChatTitle,
  validateAgentEngineServerState,
  validateAgentEvent,
  validateAgentMessageId,
  validateAgentModelId,
  validateAgentServerPort,
  validateAgentSessionId,
  validateAgentVariant,
  validateAttachmentBase64,
  validateAttachmentContent,
  validateAttachmentFileName,
  validateAttachmentGuestPath,
  validateAttachmentMime,
  validateCodexEngineState,
  validateCodexEvent,
  validateCodexMethod,
  validateCodexParams,
  validatePermissionReply,
  validateQuestionAnswers,
  validateStagedAttachment,
  validateAllFilesAccessResult,
  validateDeviceCommand,
  validateDeviceCommandParam,
  validateDeviceCommandResult,
  validateDiagnosticLogExport,
  validateDiagnosticLogState,
  validateDiagnosticLogText,
  validateHarnessLog,
  validateKeepAliveState,
  validateMailboxExportResult,
  validateMailboxImportResult,
  validateMailboxState,
  validateMediaPermissionResult,
  validateNotificationPermissionResult,
  validateOverlayBallState,
  validateRuntimeProgress,
  validateRuntimeSelfCheckReport,
  validateRuntimeState,
  validateRuntimeVersions,
  validateSettings,
  validateSettingsUpdate,
  validateShizukuState,
  validateStorageAccessState,
  validateStorageDirsState,
  validateStoredSettings,
  validateRuntimeSource,
  validateTerminalChunk,
  validateTerminalExit,
  validateTerminalSession,
} from './validation'

interface NativeRuntimePlugin {
  managePlugins(options: PluginRequest): Promise<PluginCatalog>
  setAppLanguage(options: { language: 'zh-CN' | 'en' }): Promise<void>
  /** 同步主题模式给原生，由原生把它落到状态栏（登记册 5.4）。 */
  setAppTheme(options: { mode: AppThemeMode }): Promise<void>
  getState(): Promise<RuntimeState>
  getSettings(): Promise<RuntimeSettings>
  saveSettings(settings: RuntimeSettingsUpdate): Promise<RuntimeSettings>
  install(source?: RuntimeSource): Promise<void>
  startHarness(): Promise<RuntimeState>
  openHarness(): Promise<void>
  stopRuntime(): Promise<RuntimeState>
  reset(options: { confirmation: string }): Promise<RuntimeState>
  createTerminal(options: { kind: TerminalKind; columns: number; rows: number }): Promise<{ sessionId: string }>
  writeTerminal(options: { sessionId: string; dataBase64: string }): Promise<void>
  resizeTerminal(options: { sessionId: string; columns: number; rows: number }): Promise<void>
  closeTerminal(options: { sessionId: string }): Promise<void>
  execDeviceCommand(options: { sessionId: string; command: DeviceCommand; param?: string }): Promise<DeviceCommandResult>
  getShizukuState(): Promise<ShizukuState>
  requestShizukuPermission(): Promise<ShizukuState>
  connectShizuku(): Promise<ShizukuState>
  openShizuku(): Promise<void>
  getKeepAliveState(): Promise<KeepAliveState>
  requestNotificationPermission(): Promise<NotificationPermissionResult>
  overlayBallState(): Promise<unknown>
  openOverlaySettings(): Promise<void>
  mailboxState(): Promise<unknown>
  getStorageAccessState(): Promise<unknown>
  requestMediaPermission(): Promise<unknown>
  openAllFilesAccessSettings(): Promise<unknown>
  importMailbox(): Promise<unknown>
  exportMailbox(options: { subdirectory?: string }): Promise<unknown>
  storageDirsState(): Promise<unknown>
  addStorageDirectory(): Promise<unknown>
  removeStorageDirectory(options: { path: string }): Promise<unknown>
  getHarnessLog(options: { maxBytes?: number }): Promise<unknown>
  runRuntimeSelfCheck(options: { operation: SelfCheckOperation }): Promise<unknown>
  runtimeVersions(): Promise<unknown>
  switchRuntimeVersion(options: { target: string }): Promise<unknown>
  deleteRuntimeVersion(options: { target: string }): Promise<unknown>
  agentCliState(): Promise<unknown>
  installAgentCli(options: { name: string }): Promise<unknown>
  agentEngineState(): Promise<unknown>
  startAgentServer(options: { port?: number }): Promise<unknown>
  stopAgentServer(): Promise<unknown>
  agentChatSessions(): Promise<unknown>
  agentChatCreate(options: { title: string; model?: string; variant?: string }): Promise<unknown>
  agentChatHistory(options: { sessionId: string }): Promise<unknown>
  agentSessionRename(options: { sessionId: string; title: string }): Promise<unknown>
  agentSessionDelete(options: { sessionId: string }): Promise<unknown>
  agentChatSend(options: { sessionId: string; text?: string; parts?: unknown }): Promise<unknown>
  stageAgentAttachment(options: { fileName: string; mime: string; dataBase64: string }): Promise<unknown>
  agentChatFile(options: { guestPath: string }): Promise<unknown>
  agentModels(): Promise<unknown>
  agentChatAbort(options: { sessionId: string }): Promise<unknown>
  agentChatFork(options: { sessionId: string; messageId: string }): Promise<unknown>
  agentPermissionReply(options: { sessionId: string; requestId: string; reply: string; message?: string }): Promise<unknown>
  agentQuestionReply(options: { sessionId: string; requestId: string; answers: string[] }): Promise<unknown>
  agentQuestionReject(options: { sessionId: string; requestId: string }): Promise<unknown>
  agentQuestionList(options: { sessionId: string }): Promise<unknown>
  agentPermissionFeed(): Promise<unknown>
  startAgentEventStream(): Promise<void>
  stopAgentEventStream(): Promise<void>
  codexEngineState(): Promise<{ running: boolean }>
  startCodexServer(): Promise<{ running: boolean }>
  stopCodexServer(): Promise<{ running: boolean }>
  codexRpc(options: { method: string; params?: string }): Promise<unknown>
  startCodexEventStream(): Promise<void>
  stopCodexEventStream(): Promise<void>
  getDiagnosticLogState(): Promise<DiagnosticLogState>
  readDiagnosticLog(options: { maxBytes?: number }): Promise<unknown>
  setDiagnosticLogSettings(options: { enabled: boolean; retentionDays: number }): Promise<DiagnosticLogState>
  shareDiagnosticLog(): Promise<DiagnosticLogExport>
  shareRuntimeWorkspace(): Promise<void>
  listRuntimeWorkspaceFiles(): Promise<{ files: string[] }>
  shareRuntimeWorkspaceFile(options: { path: string }): Promise<void>
  openRuntimeWorkspaceFile(options: { path: string }): Promise<void>
  deleteRuntimeWorkspaceFile(options: { path: string }): Promise<void>
  clearDiagnosticLog(): Promise<DiagnosticLogState>
  addListener(eventName: 'runtimeProgress', listener: (event: RuntimeProgress) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'terminalOutput', listener: (event: TerminalChunk) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'terminalExit', listener: (event: TerminalExit) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'agentEvent', listener: (event: AgentEvent) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'codexEvent', listener: (event: CodexEvent) => void): Promise<PluginListenerHandle>
}

const MAX_TERMINAL_INPUT_BYTES = 256 * 1024
const NativeRuntime = registerPlugin<NativeRuntimePlugin>('MobileRuntime')

function assertWorkspaceFilePath(path: string): string {
  const segments = path.split('/')
  if (path.length < 1 || path.length > 240 || path.startsWith('/') || path.includes('\\') ||
      segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('工作区文件路径无效')
  }
  return path
}

function validatedListener<T>(validator: (value: unknown) => T, listener: (event: T) => void): (event: T) => void {
  return event => {
    try {
      listener(validator(event))
    } catch {
      // Native event callbacks are outside Promise chains; malformed payloads fail closed here.
    }
  }
}

function createNativeBridge(): RuntimeBridge {
  return {
    managePlugins: request => NativeRuntime.managePlugins(validatePluginRequest(request)).then(validatePluginCatalog),
    setAppLanguage: language => {
      if (language !== 'zh-CN' && language !== 'en') return Promise.reject(new Error('不支持的应用语言'))
      return NativeRuntime.setAppLanguage({ language })
    },
    setAppTheme: mode => {
      // 与原生侧的校验保持同一组取值：非法值在过桥之前就拒绝，不让原生去猜。
      if (mode !== 'system' && mode !== 'light' && mode !== 'dark') {
        return Promise.reject(new Error('不支持的主题模式'))
      }
      return NativeRuntime.setAppTheme({ mode })
    },
    getState: () => NativeRuntime.getState().then(validateRuntimeState),
    getSettings: () => NativeRuntime.getSettings().then(validateStoredSettings),
    saveSettings: settings => NativeRuntime.saveSettings(validateSettingsUpdate(settings)).then(validateSettings),
    install: source => NativeRuntime.install(source === undefined ? undefined : validateRuntimeSource(source)),
    startHarness: () => NativeRuntime.startHarness().then(validateRuntimeState),
    openHarness: () => NativeRuntime.openHarness(),
    stopRuntime: () => NativeRuntime.stopRuntime().then(validateRuntimeState),
    reset: confirmation => {
      if (confirmation !== 'RESET_RUNTIME') return Promise.reject(new Error('重置确认无效'))
      return NativeRuntime.reset({ confirmation }).then(validateRuntimeState)
    },
    createTerminal: (kind, columns, rows) => {
      assertTerminalKind(kind)
      assertTerminalSize(columns, rows)
      return NativeRuntime.createTerminal({ kind, columns, rows }).then(validateTerminalSession)
    },
    writeTerminal: (sessionId, dataBase64) => {
      assertSessionId(sessionId)
      assertBase64Input(dataBase64, MAX_TERMINAL_INPUT_BYTES)
      return NativeRuntime.writeTerminal({ sessionId, dataBase64 })
    },
    resizeTerminal: (sessionId, columns, rows) => {
      assertSessionId(sessionId)
      assertTerminalSize(columns, rows)
      return NativeRuntime.resizeTerminal({ sessionId, columns, rows })
    },
    closeTerminal: sessionId => NativeRuntime.closeTerminal({ sessionId: assertSessionId(sessionId) }),
    execDeviceCommand: (sessionId, command, param) => {
      const validated = {
        sessionId: assertSessionId(sessionId),
        command: validateDeviceCommand(command),
        param: validateDeviceCommandParam(param),
      }
      return NativeRuntime.execDeviceCommand(validated).then(validateDeviceCommandResult)
    },
    getShizukuState: () => NativeRuntime.getShizukuState().then(validateShizukuState),
    requestShizukuPermission: () => NativeRuntime.requestShizukuPermission().then(validateShizukuState),
    connectShizuku: () => NativeRuntime.connectShizuku().then(validateShizukuState),
    openShizuku: () => NativeRuntime.openShizuku(),
    getKeepAliveState: () => NativeRuntime.getKeepAliveState().then(validateKeepAliveState),
    requestNotificationPermission: () => NativeRuntime.requestNotificationPermission().then(validateNotificationPermissionResult),
    getOverlayBallState: () => NativeRuntime.overlayBallState().then(validateOverlayBallState),
    openOverlaySettings: () => NativeRuntime.openOverlaySettings(),
    getMailboxState: () => NativeRuntime.mailboxState().then(validateMailboxState),
    getStorageAccessState: () => NativeRuntime.getStorageAccessState().then(validateStorageAccessState),
    requestMediaPermission: () => NativeRuntime.requestMediaPermission().then(validateMediaPermissionResult),
    openAllFilesAccessSettings: () => NativeRuntime.openAllFilesAccessSettings().then(validateAllFilesAccessResult),
    importMailbox: () => NativeRuntime.importMailbox().then(validateMailboxImportResult),
    // 导出起点先在前端拦一道明显非法的取值（绝对路径、`..`），原生侧还有同一套规则兜底。
    exportMailbox: subdirectory => {
      const target = assertMailboxSubdirectory(subdirectory)
      return NativeRuntime.exportMailbox(target === undefined ? {} : { subdirectory: target })
        .then(validateMailboxExportResult)
    },
    // 目录白名单：选区与校验都在原生侧（SAF 回调里做），这里只负责校验载荷与路径入参。
    getStorageDirs: () => NativeRuntime.storageDirsState().then(validateStorageDirsState),
    addStorageDirectory: () => NativeRuntime.addStorageDirectory().then(validateStorageDirsState),
    removeStorageDirectory: path => NativeRuntime
      .removeStorageDirectory({ path: assertStorageDirPath(path) })
      .then(validateStorageDirsState),
    // 窗口参数由原生侧收敛到受控档位；这里只负责透传用户选择的字节数。
    getHarnessLog: options => NativeRuntime.getHarnessLog({ maxBytes: options?.maxBytes }).then(validateHarnessLog),
    // 操作类型只允许 check / repair：未知取值在进入原生侧之前就被拒绝。
    runRuntimeSelfCheck: operation => NativeRuntime
      .runRuntimeSelfCheck({ operation: validateSelfCheckOperation(operation) })
      .then(validateRuntimeSelfCheckReport),
    // 版本槽与体积由原生侧回传；目标取值在前端就拦死（目前只有上一版本可切换或删除）。
    getRuntimeVersions: () => NativeRuntime.runtimeVersions().then(validateRuntimeVersions),
    switchRuntimeVersion: target => NativeRuntime
      .switchRuntimeVersion({ target: assertRuntimeVersionTarget(target) })
      .then(validateRuntimeVersions),
    deleteRuntimeVersion: target => NativeRuntime
      .deleteRuntimeVersion({ target: assertRuntimeVersionTarget(target) })
      .then(validateRuntimeVersions),
    // 按需 Agent：名称形态前端先拦一道，原生侧再与清单全等匹配。
    agentCliState: () => NativeRuntime.agentCliState().then(validateAgentCliStates),
    installAgentCli: name => NativeRuntime
      .installAgentCli({ name: validateAgentCliName(name) })
      .then(validateAgentCliStates),
    // 本机 Agent 服务（opencode serve）：端口前端先拦，状态载荷不含凭据。
    agentEngineState: () => NativeRuntime.agentEngineState().then(validateAgentEngineServerState),
    startAgentServer: port => NativeRuntime
      .startAgentServer(port === undefined ? {} : { port: validateAgentServerPort(port) })
      .then(validateAgentEngineServerState),
    stopAgentServer: () => NativeRuntime.stopAgentServer().then(validateAgentEngineServerState),
    // Agent 聊天中继：id/标题/正文形态前端先拦，原生侧代发 HTTP 后原文返回。
    agentChatSessions: () => NativeRuntime.agentChatSessions().then(validateAgentChatJson),
    agentChatCreate: (title, modelID, variant) => NativeRuntime
      .agentChatCreate({
        title: validateAgentChatTitle(title),
        ...(modelID === undefined ? {} : { model: validateAgentModelId(modelID) }),
        ...(variant === undefined ? {} : { variant: validateAgentVariant(variant) }),
      })
      .then(validateAgentChatJson),
    agentChatHistory: sessionId => NativeRuntime
      .agentChatHistory({ sessionId: validateAgentSessionId(sessionId) })
      .then(validateAgentChatJson),
    agentSessionRename: (sessionId, title) => NativeRuntime
      .agentSessionRename({ sessionId: validateAgentSessionId(sessionId), title: validateAgentChatTitle(title) })
      .then(validateAgentChatJson),
    agentSessionDelete: sessionId => NativeRuntime
      .agentSessionDelete({ sessionId: validateAgentSessionId(sessionId) })
      .then(validateAgentChatJson),
    agentChatSend: (sessionId, text, parts) => NativeRuntime
      .agentChatSend({
        sessionId: validateAgentSessionId(sessionId),
        ...(text === '' ? {} : { text: validateAgentChatText(text) }),
        ...(parts === undefined ? {} : { parts: validateAgentChatParts(parts) }),
      })
      .then(validateAgentChatJson),
    // 附件落点与读取：文件名/mime/base64/访客路径形态前端先拦，原生侧再拦一次。
    stageAgentAttachment: (fileName, mime, dataBase64) => NativeRuntime
      .stageAgentAttachment({
        fileName: validateAttachmentFileName(fileName),
        mime: validateAttachmentMime(mime),
        dataBase64: validateAttachmentBase64(dataBase64),
      })
      .then(validateStagedAttachment),
    agentChatFile: guestPath => NativeRuntime
      .agentChatFile({ guestPath: validateAttachmentGuestPath(guestPath) })
      .then(validateAttachmentContent),
    // 模型目录：原文经 8MB 上限后归一化，不含密钥与地址。
    agentModels: () => NativeRuntime.agentModels().then(value => ({
      models: parseAgentModels(parseJsonPayload(validateAgentChatJson(value).json)),
    })),
    // 中止与分叉：id 形态前端先拦，原生侧代发后原文返回。
    agentChatAbort: sessionId => NativeRuntime
      .agentChatAbort({ sessionId: validateAgentSessionId(sessionId) })
      .then(validateAgentChatJson),
    agentChatFork: (sessionId, messageId) => NativeRuntime
      .agentChatFork({ sessionId: validateAgentSessionId(sessionId), messageId: validateAgentMessageId(messageId) })
      .then(validateAgentChatJson),
    // 审批：reply 只认服务端枚举，answers 只认选项标签数组；message 可选。
    agentPermissionReply: (sessionId, requestId, reply, message) => NativeRuntime
      .agentPermissionReply({
        sessionId: validateAgentSessionId(sessionId),
        requestId: validateAgentMessageId(requestId),
        reply: validatePermissionReply(reply),
        ...(message === undefined || message === '' ? {} : { message: validateAgentChatText(message) }),
      })
      .then(validateAgentChatJson),
    agentQuestionReply: (sessionId, requestId, answers) => NativeRuntime
      .agentQuestionReply({
        sessionId: validateAgentSessionId(sessionId),
        requestId: validateAgentMessageId(requestId),
        answers: validateQuestionAnswers(answers),
      })
      .then(validateAgentChatJson),
    agentQuestionReject: (sessionId, requestId) => NativeRuntime
      .agentQuestionReject({
        sessionId: validateAgentSessionId(sessionId),
        requestId: validateAgentMessageId(requestId),
      })
      .then(validateAgentChatJson),
    agentQuestionList: sessionId => NativeRuntime
      .agentQuestionList({ sessionId: validateAgentSessionId(sessionId) })
      .then(validateAgentChatJson),
    agentPermissionFeed: () => NativeRuntime.agentPermissionFeed().then(validateAgentChatJson),
    // 事件流：订阅后每块服务端事件以 agentEvent 送达；停服/显式停止时断开。
    startAgentEventStream: () => NativeRuntime.startAgentEventStream(),
    stopAgentEventStream: () => NativeRuntime.stopAgentEventStream(),
    addAgentEventListener: listener => NativeRuntime.addListener('agentEvent', validatedListener(validateAgentEvent, listener)),
    // Codex 服务：stdio 私有通道无端口密码；方法名白名单 + params 序列化后过桥。
    codexEngineState: () => NativeRuntime.codexEngineState().then(validateCodexEngineState),
    startCodexServer: () => NativeRuntime.startCodexServer().then(validateCodexEngineState),
    stopCodexServer: () => NativeRuntime.stopCodexServer().then(validateCodexEngineState),
    codexRpc: (method, params) => NativeRuntime
      .codexRpc({ method: validateCodexMethod(method), ...(params === undefined ? {} : { params: validateCodexParams(params) }) })
      .then(validateAgentChatJson),
    startCodexEventStream: () => NativeRuntime.startCodexEventStream(),
    stopCodexEventStream: () => NativeRuntime.stopCodexEventStream(),
    addCodexEventListener: listener => NativeRuntime.addListener('codexEvent', validatedListener(validateCodexEvent, listener)),
    readDiagnosticLog: options => NativeRuntime.readDiagnosticLog({ maxBytes: options?.maxBytes }).then(validateDiagnosticLogText),
    getDiagnosticLogState: () => NativeRuntime.getDiagnosticLogState().then(validateDiagnosticLogState),
    setDiagnosticLogSettings: (enabled, retentionDays) => {
      const days = assertDiagnosticRetentionDays(retentionDays)
      return NativeRuntime.setDiagnosticLogSettings({ enabled, retentionDays: days }).then(validateDiagnosticLogState)
    },
    shareDiagnosticLog: () => NativeRuntime.shareDiagnosticLog().then(validateDiagnosticLogExport),
    shareRuntimeWorkspace: () => NativeRuntime.shareRuntimeWorkspace(),
    listRuntimeWorkspaceFiles: () => NativeRuntime.listRuntimeWorkspaceFiles().then(value => value.files),
    shareRuntimeWorkspaceFile: path => NativeRuntime.shareRuntimeWorkspaceFile({ path: assertWorkspaceFilePath(path) }),
    openRuntimeWorkspaceFile: path => NativeRuntime.openRuntimeWorkspaceFile({ path: assertWorkspaceFilePath(path) }),
    deleteRuntimeWorkspaceFile: path => NativeRuntime.deleteRuntimeWorkspaceFile({ path: assertWorkspaceFilePath(path) }),
    clearDiagnosticLog: () => NativeRuntime.clearDiagnosticLog().then(validateDiagnosticLogState),
    addRuntimeProgressListener: listener => NativeRuntime.addListener('runtimeProgress', validatedListener(validateRuntimeProgress, listener)),
    addTerminalOutputListener: listener => NativeRuntime.addListener('terminalOutput', validatedListener(validateTerminalChunk, listener)),
    addTerminalExitListener: listener => NativeRuntime.addListener('terminalExit', validatedListener(validateTerminalExit, listener)),
  }
}

export const runtimeBridge: RuntimeBridge = Capacitor.isNativePlatform()
  ? createNativeBridge()
  : createBrowserBridge()
