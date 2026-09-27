/**
 * 移动适配层依赖的全部官方锚点契约。
 *
 * 背景：android.css 不做任何官方产物修改，全部规则通过官方暴露的
 * 稳定锚点命中（data-* 属性、语义结构、CSS 变量）。官方升级时若
 * 锚点消失，对应规则会**静默失效**（历史事故：适配层早期版本因选择
 * 器特异性被 CSS Modules 哈希类压过，44px 触控与 16px 防缩放规则在
 * 真机上一条都没生效）。这里把锚点集中声明，并在构建期与运行时分发
 * 前显式校验：锚点缺失 → 立即失败并指明受影响的规则，而不是等用户
 * 在真机上发现布局损坏。
 *
 * 维护方式：官方升级后若某个锚点确实消失，先修复 android.css 中依赖
 * 它的规则，再删除此处的对应条目——删除动作必须与样式修改同一次提交，
 * 避免清单与样式脱节。
 */

/** 静态锚点：来自 @deepseek-ai/dsh-web-frontend 的 dist 产物。 */
export const STATIC_ANCHORS = [
  { token: 'md-code-block', purpose: '代码块横向滚动与惯性滚动（.md-code-block）' },
  { token: 'md-table-wide', purpose: '宽表格横向滚动（.md-table-wide）' },
]

/** 运行时锚点：来自客户端 UI 插件产物（dsh-client-ui-* 等，由 ModuleLoader 加载）。 */
export const RUNTIME_ANCHORS = [
  { token: 'data-shell-overlay', purpose: '侧栏抽屉的 frame 结构匹配（:has(> [data-shell-overlay])）' },
  { token: 'data-rightbar-col', purpose: '侧栏抽屉的 frame 结构匹配（:has(> [data-rightbar-col])）' },
  { token: 'data-sidebar-collapsed', purpose: '侧栏展开/折叠态判定（覆盖式抽屉仅在展开态生效）' },
  { token: 'data-side', purpose: '拖拽把手从命中树移除（[data-side] 隐藏）' },
  { token: 'data-phase', purpose: 'composer 间距变量的作用域锚点（[data-phase]）与忙闲判定（busy 边框只在 submitting/adjudicating 下激活）' },
  { token: 'data-composer-card', purpose: 'living-light 边框的挂载面（composer 卡片本体，::before/::after 发光层锚定于此）' },
  { token: '--dsh-composer-side-clearance', purpose: '窄屏侧向留白回收（变量覆盖）' },
  { token: '--dsh-chat-content-width', purpose: '内容宽度跟随列，替换 680px 桌面下限（变量覆盖）' },
]

/**
 * 在若干文本中校验锚点是否存在。
 * @param {Array<{ token: string, purpose: string }>} anchors - 待校验锚点。
 * @param {string} corpus - 全部待搜索文本拼接后的语料。
 * @returns {Array<{ token: string, purpose: string }>} 缺失的锚点（全部存在时为空数组）。
 */
export function findMissingAnchors(anchors, corpus) {
  return anchors.filter(anchor => !corpus.includes(anchor.token))
}

/**
 * 目录项是否为常规文件（含 d_type 缺失时的回退）。
 *
 * 部分挂载（FUSE/PRoot 等）不填充 `d_type`，`Dirent.isFile()` 对一切返回 false，
 * 仅凭它过滤会把整个目录判定为空——构建与锚点检查会误报“锚点缺失”。
 * 回退用 `lstat`（不跟随符号链接：链接在新旧两条路径下都不计入，保持语义一致），
 * 只有确认是常规文件才返回 true。
 * @param {import('node:fs').Dirent} entry - readdir 返回的目录项。
 * @param {string} fullPath - 该目录项的完整路径（调用方负责拼接）。
 * @param {(path: string) => Promise<import('node:fs').Stats>} lstat - 注入的 lstat，便于测试。
 * @returns {Promise<boolean>} 是否为常规文件。
 */
export async function isRegularFile(entry, fullPath, lstat) {
  if (entry.isFile()) return true
  // 注意：不可信的反向判定——某些挂载不填充 d_type，此时 isDirectory() 等
  // 同样不可信（实测把常规文件报成符号链接），因此不能提前 return false，
  // 必须走到 lstat。用 lstat 而不用 stat：不跟随链接，与旧语义一致。
  try {
    const st = await lstat(fullPath)
    if (st.isSymbolicLink()) return false
    return st.isFile()
  } catch {
    return false
  }
}

/**
 * 缺失锚点的统一报错文案。
 * @param {string} scope - 校验范围描述（如「官方前端 dist」「运行时插件产物」）。
 * @param {Array<{ token: string, purpose: string }>} missing - 缺失锚点。
 * @returns {string} 供 throw / 终端输出的错误信息。
 */
export function missingAnchorsMessage(scope, missing) {
  const lines = missing.map(anchor => `  - ${anchor.token}（${anchor.purpose}）`)
  return [
    `${scope}缺少适配层依赖的锚点，以下规则会静默失效：`,
    ...lines,
    '处理方式：修复 android.css 中依赖该锚点的规则，并在同一次提交中更新 scripts/anchor-contract.mjs。',
  ].join('\n')
}
