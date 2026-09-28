import { describe, expect, it } from 'vitest'
import { AGENT_ENGINES, DEFAULT_ENGINE_ID, engineById, isEngineId } from './agentEngines'

describe('agentEngines', () => {
  it('注册表覆盖六个引擎，OpenCode 为默认', () => {
    expect(AGENT_ENGINES.map(engine => engine.id)).toEqual([
      'opencode',
      'deepseek',
      'claude',
      'codex',
      'gemini',
      'antigravity',
    ])
    expect(DEFAULT_ENGINE_ID).toBe('opencode')
    expect(engineById('opencode').transport).toBe('opencode-serve')
    expect(engineById('opencode').defaultPort).toBe(4097)
  })

  it('非法 id 被拒绝', () => {
    expect(isEngineId('cursor')).toBe(false)
    expect(isEngineId(null)).toBe(false)
    expect(() => engineById('cursor' as never)).toThrow()
  })
})
