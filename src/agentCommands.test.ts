import { describe, expect, it } from 'vitest'
import { AGENT_COMMANDS, AGENT_LOGIN_HINTS, findAgentCommand } from './agentCommands'

/**
 * Agent 命令目录的安全网：目录里的每一项都会被原样敲进终端，
 * 因此命令字符集、唯一性与登录提示的完整性在这里钉死，
 * 而不是等用户在真机上敲出坏字符才发现。
 */
describe('Agent 命令目录', () => {
  it('命令唯一且只含白名单字符', () => {
    const commands = AGENT_COMMANDS.map(item => item.command)
    expect(new Set(commands).size).toBe(commands.length)
    for (const command of commands) {
      expect(command).toMatch(/^[A-Za-z0-9._-]+$/)
      expect(command.length).toBeLessThanOrEqual(64)
    }
  })

  it('每条都有来源标注与登录提示', () => {
    for (const item of AGENT_COMMANDS) {
      expect(item.source === 'builtin' || item.source === 'ondemand').toBe(true)
      if (item.source === 'ondemand') expect(item.agentName).toBe(item.command)
      const hint = AGENT_LOGIN_HINTS[item.loginHintKey]
      expect(typeof hint).toBe('string')
      expect(hint.length).toBeGreaterThan(0)
    }
  })

  it('按命令名可查到条目，未知返回 undefined', () => {
    expect(findAgentCommand('opencode')?.label).toBe('OpenCode')
    expect(findAgentCommand('agy')?.source).toBe('ondemand')
    expect(findAgentCommand('not-an-agent')).toBeUndefined()
  })
})
