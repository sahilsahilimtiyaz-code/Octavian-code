/**
 * 轻量 Markdown 渲染：只做聊天消息需要的子集，不引入新依赖。
 *
 * 安全模型是“默认转义”：先把全文按 HTML 转义，再只生成白名单标签
 * （pre/code/strong/em/a/ul/ol/li/blockquote/h4/hr/p）。a 的 href 只接受
 * http/https，其它一律退化成纯文本。因此输出可以直接进
 * dangerouslySetInnerHTML，不存在注入通道——测试里有 XSS 用例守着。
 *
 * 支持：围栏代码块（```可带语言名）、# 标题（只到 ####，再深按正文）、
 * - 无序列表、1. 有序列表、> 引用、--- 分隔线、行内 `代码`、**粗体**、
 * *斜体*、[文本](链接)。表格、脚注、任务列表 v1 不做：聊天里极少见，
 * 保持解析器小而可审计。
 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderInline(escaped: string): string {
  // 顺序关键：先行内代码（内容不再解释），再链接，再加粗，最后斜体。
  const codeSpans: string[] = []
  const withCode = escaped.replace(/`([^`\n]+)`/g, (_, code: string) => {
    codeSpans.push(`<code>${code}</code>`)
    return `%%MDCODE${codeSpans.length - 1}%%`
  })
  const withLinks = withCode.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, text: string, url: string) => {
    if (!/^https?:\/\//.test(url)) return `${text} (${url})`
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`
  })
  const withBold = withLinks.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  const withEmphasis = withBold.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  return withEmphasis.replace(/%%MDCODE(\d+)%%/g, (_, index: string) => codeSpans[Number(index)] ?? '')
}

interface Block {
  html: string
}

export function renderMarkdown(source: string): string {
  const lines = source.split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let listKind: 'ul' | 'ol' | null = null
  let listItems: string[] = []
  let inFence = false
  let fenceLines: string[] = []

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ html: `<p>${renderInline(paragraph.join(' '))}</p>` })
      paragraph = []
    }
  }

  const flushList = (): void => {
    if (listKind !== null && listItems.length > 0) {
      const tag = listKind
      blocks.push({ html: `<${tag}>${listItems.map(item => `<li>${renderInline(item)}</li>`).join('')}</${tag}>` })
      listItems = []
      listKind = null
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    if (inFence) {
      if (/^```/.test(line)) {
        inFence = false
        blocks.push({ html: `<pre><code>${fenceLines.join('\n')}</code></pre>` })
        fenceLines = []
      } else {
        // 围栏内是原文：转义但不解释任何行内语法。
        fenceLines.push(escapeHtml(line))
      }
      continue
    }
    if (/^```/.test(line)) {
      flushParagraph()
      flushList()
      inFence = true
      fenceLines = []
      continue
    }
    if (/^\s*$/.test(line)) {
      flushParagraph()
      flushList()
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading !== null) {
      flushParagraph()
      flushList()
      blocks.push({ html: `<h4>${renderInline(escapeHtml(heading[2].trim()))}</h4>` })
      continue
    }
    if (/^---+\s*$/.test(line)) {
      flushParagraph()
      flushList()
      blocks.push({ html: '<hr />' })
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote !== null) {
      flushParagraph()
      flushList()
      blocks.push({ html: `<blockquote>${renderInline(escapeHtml(quote[1]))}</blockquote>` })
      continue
    }
    const unordered = /^\s*[-*]\s+(.*)$/.exec(line)
    if (unordered !== null) {
      flushParagraph()
      if (listKind !== 'ul') {
        flushList()
        listKind = 'ul'
      }
      listItems.push(escapeHtml(unordered[1]))
      continue
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered !== null) {
      flushParagraph()
      if (listKind !== 'ol') {
        flushList()
        listKind = 'ol'
      }
      listItems.push(escapeHtml(ordered[1]))
      continue
    }
    flushList()
    paragraph.push(escapeHtml(line.trim()))
  }
  if (inFence) {
    // 围栏没闭合：按原文照单全收，不吞内容。
    blocks.push({ html: `<pre><code>${fenceLines.join('\n')}</code></pre>` })
  }
  flushParagraph()
  flushList()
  return blocks.map(block => block.html).join('')
}
