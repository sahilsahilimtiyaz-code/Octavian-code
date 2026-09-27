import { describe, expect, it } from 'vitest'
import { MODEL_PROVIDER_IDS } from './platform/types'
import { validateCustomModelProviders, validateCustomProviderId, validateCustomProviderUrl } from './platform/customProviders'
import { PROVIDER_PRESETS, findPreset, presetToProvider } from './providerPresets'

/**
 * 预设目录的安全网：每条预设都必须能原样通过自定义供应商校验。
 *
 * 预设一旦写坏（非法 slug、与内置 id 冲突、URL 不合法、模型超限），
 * 用户点「添加预设供应商」就会得到一个保存即报错的坏条目。
 * 这里把「保存时会跑的那套校验」提前到单测里，避免坏预设溜到用户眼前。
 */
describe('供应商预设', () => {
  it('预设 id 唯一且不与内置供应商冲突', () => {
    const ids = PROVIDER_PRESETS.map(preset => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    const builtins = new Set<string>(MODEL_PROVIDER_IDS)
    for (const id of ids) {
      expect(builtins.has(id)).toBe(false)
      expect(() => validateCustomProviderId(id)).not.toThrow()
    }
  })

  it('每条预设的地址与模型整体可通过保存校验', () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(() => validateCustomProviderUrl(preset.baseUrl)).not.toThrow()
      const providers = validateCustomModelProviders([{
        id: preset.id,
        name: preset.name,
        api: preset.api,
        baseUrl: preset.baseUrl,
        models: preset.models,
      }])
      expect(providers).toHaveLength(1)
      expect(providers[0].models.length).toBeGreaterThan(0)
    }
  })

  it('本机回环预设走 HTTP 也合法（仅回环允许）', () => {
    for (const id of ['ollama', 'lm-studio']) {
      const preset = findPreset(id)
      expect(preset).toBeDefined()
      expect(preset?.baseUrl.startsWith('http://127.0.0.1')).toBe(true)
      expect(() => validateCustomProviderUrl(preset?.baseUrl)).not.toThrow()
    }
  })

  it('其余预设一律 HTTPS', () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.id === 'ollama' || preset.id === 'lm-studio') continue
      expect(preset.baseUrl.startsWith('https://')).toBe(true)
    }
  })

  it('id 冲突时自动加数字后缀，且后缀仍合法', () => {
    const preset = findPreset('together')
    expect(preset).toBeDefined()
    const first = presetToProvider(preset!, [])
    expect(first.id).toBe('together')
    const second = presetToProvider(preset!, ['together'])
    expect(second.id).toBe('together-2')
    expect(() => validateCustomProviderId(second.id)).not.toThrow()
    // 深拷贝：改一条不影响另一条。
    second.models[0].id = 'changed'
    expect(first.models[0].id).not.toBe('changed')
  })

  it('未知 id 查不到预设', () => {
    expect(findPreset('not-a-preset')).toBeUndefined()
  })
})
