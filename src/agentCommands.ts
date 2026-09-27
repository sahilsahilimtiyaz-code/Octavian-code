/**
 * Ubuntu 终端一键启动的 Agent 命令目录。
 *
 * 只描述「敲什么命令」：`opencode / claude / codex / gemini` 随整包运行时内置
 * （P3），`agy` 走按需下载（D1，未安装时仍可选中，显示下载指引且不自动输入）。
 * 登录提示只写**已核实**的路径（codex 的 device-auth）与各家通用的
 * 「跟随终端内提示 / 配 API Key」两条路，不编造具体流程。
 */

export interface AgentCommand {
  /** 终端里实际敲的命令：白名单字符集，由 `TerminalPanel` 再校验一次。 */
  command: string
  /** 展示名（如 OpenCode）。 */
  label: string
  /** 该命令由哪条通道提供：`builtin` 随整包，`ondemand` 需另行下载。 */
  source: 'builtin' | 'ondemand'
  /** 与 `AgentCliState.name` 对应的键（仅按需条目使用）。 */
  agentName?: string
  /** 登录指引在 `AGENT_LOGIN_HINTS` 中的键（中文原文，调用处经 `t()` 翻译）。 */
  loginHintKey: string
}

export const AGENT_COMMANDS: readonly AgentCommand[] = [
  { command: 'opencode', label: 'OpenCode', source: 'builtin', loginHintKey: 'opencode-login' },
  { command: 'claude', label: 'Claude Code', source: 'builtin', loginHintKey: 'claude-login' },
  { command: 'codex', label: 'Codex', source: 'builtin', loginHintKey: 'codex-login' },
  { command: 'gemini', label: 'Gemini', source: 'builtin', loginHintKey: 'gemini-login' },
  { command: 'agy', label: 'Antigravity', source: 'ondemand', agentName: 'agy', loginHintKey: 'agy-login' },
]

/** 登录指引（中文原文；英文见 `src/locales/en.ts` 相同键）。 */
export const AGENT_LOGIN_HINTS: Readonly<Record<string, string>> = {
  'opencode-login': '首次运行按终端内提示完成登录，或在「模型与密钥」配好各供应商的 API Key。',
  'claude-login': '首次运行按终端内提示用订阅登录，或设置 ANTHROPIC_API_KEY 后使用。',
  'codex-login': '推荐 codex login --device-auth（浏览器打开链接输码），或用 API Key：printenv OPENAI_API_KEY | codex login --with-api-key。',
  'gemini-login': '首次运行按终端内提示用 Google 账号登录，或设置 GEMINI_API_KEY 后使用。',
  'agy-login': '首次运行按终端内提示登录 Google 账号；需先在运行环境页下载 agy。',
}

export function findAgentCommand(command: string): AgentCommand | undefined {
  return AGENT_COMMANDS.find(item => item.command === command)
}
