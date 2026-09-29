import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  it('渲染围栏代码块（内容不解释，只转义）', () => {
    expect(renderMarkdown('```js\nconst a = **x**;\n```')).toBe(
      '<pre><code>const a = **x**;</code></pre>',
    )
    expect(renderMarkdown('```\nunclosed')).toBe('<pre><code>unclosed</code></pre>')
  })

  it('渲染行内元素：代码、粗体、斜体、链接', () => {
    expect(renderMarkdown('`a` **b** *c*')).toBe(
      '<p><code>a</code> <strong>b</strong> <em>c</em></p>',
    )
    expect(renderMarkdown('[t](https://example.com/x)')).toBe(
      '<p><a href="https://example.com/x" target="_blank" rel="noopener noreferrer">t</a></p>',
    )
  })

  it('渲染标题、列表、引用与分隔线', () => {
    expect(renderMarkdown('# H\n\n- a\n- b\n\n1. x\n2. y')).toBe(
      '<h4>H</h4><ul><li>a</li><li>b</li></ul><ol><li>x</li><li>y</li></ol>',
    )
    expect(renderMarkdown('> q\n\n---')).toBe('<blockquote>q</blockquote><hr />')
  })

  it('XSS：脚本、事件处理器、危险协议一律不生效', () => {
    const evil = '<script>alert(1)</script> <img src=x onerror=alert(2)> [t](javascript:alert(3)) <b onmouseover=alert(4)>b</b>'
    const html = renderMarkdown(evil)
    // 可执行形态一个都不能有；转义后的可见文本不算。
    expect(html).not.toMatch(/<(script|img|iframe|svg|object|embed|form|input|button)[\s>]/)
    expect(html).not.toMatch(/<[^>]*\son\w+=/)
    expect(html).not.toMatch(/href\s*=\s*["']?\s*javascript:/i)
    expect(html).toContain('&lt;script&gt;')
  })

  it('普通文本成段，相邻行合并', () => {
    expect(renderMarkdown('a\nb\n\nc')).toBe('<p>a b</p><p>c</p>')
  })
})
