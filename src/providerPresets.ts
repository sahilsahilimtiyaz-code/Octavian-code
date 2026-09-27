import type { CustomModelProvider, CustomProviderApi } from './platform/types'

/**
 * 全球供应商预设：一键填入自定义供应商表单。
 *
 * 设计约束（登记册 §3.2 的自定义通道）：
 * - 预设**不是**内置供应商：不碰 `MODEL_PROVIDER_IDS` / `RuntimeModels.kt` /
 *   `validation.ts` 的白名单，天然避开原生锁步与 pi-ai 目录校验风险。
 * - 每条预设都必须能原样通过 `validateCustomModelProviders`：
 *   id 为小写 slug 且不与内置 id 重复，baseUrl 为合法 URL（含本机回环的 HTTP），
 *   模型含合法 id / 上下文 / 最大输出。`providerPresets.test.ts` 把这点钉死。
 * - 地址与模型只是合理默认：密钥永远由用户在表单里另填，走加密存储，
 *   与其它自定义供应商完全一致（`RuntimeStore` 凭据文件 / env 注入）。
 */

export interface ProviderPresetModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

export interface ProviderPreset {
  /** 小写 slug：须通过 validateCustomProviderId，且不在 MODEL_PROVIDER_IDS 里。 */
  id: string
  name: string
  api: CustomProviderApi
  baseUrl: string
  models: ProviderPresetModel[]
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    api: 'openai-completions',
    baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxTokens: 16384 },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128000, maxTokens: 16384 },
    ],
  },
  {
    id: 'together',
    name: 'Together AI',
    api: 'openai-completions',
    baseUrl: 'https://api.together.xyz/v1',
    models: [
      { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', name: 'Llama 3.1 70B Turbo', contextWindow: 131072, maxTokens: 8192 },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', name: 'Qwen2.5 72B Turbo', contextWindow: 131072, maxTokens: 8192 },
    ],
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    api: 'openai-completions',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    models: [
      { id: 'accounts/fireworks/models/llama-v3p1-405b-instruct', name: 'Llama 3.1 405B', contextWindow: 131072, maxTokens: 8192 },
    ],
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    api: 'openai-completions',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    models: [
      { id: 'meta-llama/Meta-Llama-3.1-70B-Instruct', name: 'Llama 3.1 70B', contextWindow: 131072, maxTokens: 8192 },
    ],
  },
  {
    id: 'cohere',
    name: 'Cohere',
    api: 'openai-completions',
    baseUrl: 'https://api.cohere.com/compatibility/v1',
    models: [
      { id: 'command-r-plus-08-2024', name: 'Command R+ (08-2024)', contextWindow: 128000, maxTokens: 4096 },
    ],
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    api: 'openai-completions',
    baseUrl: 'https://api.perplexity.ai',
    models: [
      { id: 'llama-3.1-sonar-large-128k-online', name: 'Sonar Large 128K Online', contextWindow: 127072, maxTokens: 8192 },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama（本机）',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: [
      { id: 'llama3.1', name: 'Llama 3.1（本机）', contextWindow: 128000, maxTokens: 8192 },
      { id: 'qwen2.5', name: 'Qwen2.5（本机）', contextWindow: 32768, maxTokens: 8192 },
    ],
  },
  {
    id: 'lm-studio',
    name: 'LM Studio（本机）',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:1234/v1',
    models: [
      { id: 'local-model', name: '已加载的本地模型', contextWindow: 32768, maxTokens: 8192 },
    ],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow 硅基流动',
    api: 'openai-completions',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [
      { id: 'Qwen/Qwen2.5-72B-Instruct', name: 'Qwen2.5 72B', contextWindow: 32768, maxTokens: 8192 },
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', contextWindow: 64000, maxTokens: 8192 },
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot Kimi',
    api: 'openai-completions',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      { id: 'moonshot-v1-128k', name: 'moonshot-v1-128k', contextWindow: 128000, maxTokens: 8192 },
      { id: 'kimi-k2-0711-preview', name: 'Kimi K2 Preview', contextWindow: 200000, maxTokens: 16384 },
    ],
  },
  {
    id: 'qwen',
    name: 'Qwen 通义千问',
    api: 'openai-completions',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: [
      { id: 'qwen-plus', name: 'Qwen Plus', contextWindow: 131072, maxTokens: 8192 },
      { id: 'qwen-max', name: 'Qwen Max', contextWindow: 32000, maxTokens: 8192 },
    ],
  },
  {
    id: 'zhipu-glm',
    name: 'Zhipu 智谱 GLM',
    api: 'openai-completions',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { id: 'glm-4-plus', name: 'GLM-4 Plus', contextWindow: 131072, maxTokens: 8192 },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    api: 'openai-completions',
    baseUrl: 'https://api.minimax.chat/v1',
    models: [
      { id: 'MiniMax-Text-01', name: 'MiniMax Text 01', contextWindow: 1000000, maxTokens: 16384 },
    ],
  },
  {
    id: 'doubao',
    name: 'Doubao 火山方舟',
    api: 'openai-completions',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [
      { id: 'doubao-seed-1-6-250615', name: 'Doubao Seed 1.6', contextWindow: 256000, maxTokens: 16384 },
    ],
  },
]

/**
 * 预设转表单条目：深拷贝模型数组，避免多条目共享同一引用。
 * id 已存在时自动加数字后缀（`azure-openai-2`），后缀同样符合 slug 规则。
 */
export function presetToProvider(preset: ProviderPreset, existingIds: readonly string[]): CustomModelProvider {
  const taken = new Set(existingIds)
  let id = preset.id
  let counter = 2
  while (taken.has(id)) {
    id = `${preset.id}-${counter}`
    counter++
  }
  return {
    id,
    name: preset.name,
    api: preset.api,
    baseUrl: preset.baseUrl,
    models: preset.models.map(model => ({ ...model })),
  }
}

export function findPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(preset => preset.id === id)
}
