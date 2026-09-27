import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// xterm 的样式表不在这里引入：终端面板本身是懒加载的（见 App.tsx 的 lazy import），
// 样式跟着 TerminalPanel 走才能让首屏 CSS 不包含终端相关的规则。
import './styles.css'
import { App } from './App'
import { AppErrorBoundary } from './components/AppErrorBoundary'
import { applyTheme, readThemeMode } from './theme'

// 首帧脚本（index.html）通常已落过一次主题；这里再补落一次，覆盖
// 「宿主页面缺少脚本」或「脚本被 CSP 拦下」的情形，避免存过深色却显示浅色。
// applyTheme 幂等且内部吞掉桥异常，首屏前调用安全。
try {
  applyTheme(readThemeMode())
} catch {
  // localStorage/DOM 不可用时仍要正常渲染，主题保持默认浅色。
}

const root = document.getElementById('root')

if (root === null) {
  throw new Error('应用根节点不存在')
}

// 顶层错误边界从 main.tsx 抽到了 components/AppErrorBoundary.tsx：
// 它现在带「导出诊断日志」入口，且文案走 i18n，需要独立的测试文件覆盖。
createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>,
)
