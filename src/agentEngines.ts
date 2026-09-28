/**
 * Agent 引擎注册表：聊天可以在哪些后端之间切换。
 *
 * 背景： historically 聊天只能是 DeepSeek Harness（访客 `dsh web` + 上游前端），
 * OpenCode/Claude/Codex/Gemini/Antigravity 只是 PTY 里自动敲出的命令。
 * 对标 AndCode 的做法——一个自有聊天界面 + N 个本地服务后端：
 * 每个引擎是一条受控元数据，说明它的 transport（本机服务还是终端 fallback）、
 * 成熟度与默认端口；真正的会话能力由各引擎的 client/bridge 实现。
 */

export type EngineId = 'deepseek' | 'opencode' | 'claude' | 'codex' | 'gemini' | 'antigravity'

/** 引擎的接入方式：harness 是既有 DeepSeek 通道；opencode-serve 是本机 SSE 服务；pty 是终端 fallback。 */
export type EngineTransport = 'harness' | 'opencode-serve' | 'pty'

export type EngineStatus = 'stable' | 'beta'

export interface AgentEngine {
  id: EngineId
  /** 展示名。 */
  name: string
  /** 一句话说明。 */
  tagline: string
  transport: EngineTransport
  status: EngineStatus
  /** 本机服务默认端口（仅 serve 类引擎）。 */
  defaultPort?: number
  /** PTY fallback 时自动敲出的命令。 */
  cliCommand?: string
}

export const AGENT_ENGINES: readonly AgentEngine[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    tagline: '本地 OpenCode 服务 · SSE 流式会话',
    transport: 'opencode-serve',
    status: 'stable',
    defaultPort: 4097,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    tagline: 'Harness 官方前端 · 开箱即用',
    transport: 'harness',
    status: 'stable',
  },
  {
    id: 'claude',
    name: 'Claude Code',
    tagline: 'Anthropic 官方 CLI · 终端会话',
    transport: 'pty',
    status: 'beta',
    cliCommand: 'claude',
  },
  {
    id: 'codex',
    name: 'Codex',
    tagline: 'OpenAI 官方 CLI · 终端会话',
    transport: 'pty',
    status: 'beta',
    cliCommand: 'codex',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    tagline: 'Google 官方 CLI · 终端会话',
    transport: 'pty',
    status: 'beta',
    cliCommand: 'gemini',
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    tagline: 'Google agy · 按需安装后终端会话',
    transport: 'pty',
    status: 'beta',
    cliCommand: 'agy',
  },
]

export const ENGINE_STORAGE_KEY = 'octacode-engine-v1'

export const DEFAULT_ENGINE_ID: EngineId = 'opencode'

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === 'string' && AGENT_ENGINES.some(engine => engine.id === value)
}

export function engineById(id: EngineId): AgentEngine {
  const found = AGENT_ENGINES.find(engine => engine.id === id)
  if (!found) throw new Error('未知引擎')
  return found
}

/** 用户是否显式选过引擎：没有则首屏弹出引擎选择器，而不是替他决定。 */
export function hasStoredEngineId(): boolean {
  try {
    return window.localStorage.getItem(ENGINE_STORAGE_KEY) !== null
  } catch {
    return false
  }
}

/** 读用户上次选的引擎：非法值（含旧版本残留）回退到默认，不抛错。 */
export function readEngineId(): EngineId {
  try {
    const value = window.localStorage.getItem(ENGINE_STORAGE_KEY)
    return isEngineId(value) ? value : DEFAULT_ENGINE_ID
  } catch {
    return DEFAULT_ENGINE_ID
  }
}

export function saveEngineId(id: EngineId): boolean {
  if (!isEngineId(id)) return false
  try {
    window.localStorage.setItem(ENGINE_STORAGE_KEY, id)
  } catch {
    return false
  }
  return true
}
