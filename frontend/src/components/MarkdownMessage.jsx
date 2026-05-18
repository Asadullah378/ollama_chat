import { useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Check, Copy } from 'lucide-react'

function CodeBlock({ className, children }) {
  const [copied, setCopied] = useState(false)
  const match = /language-(\w+)/.exec(className || '')
  const language = match ? match[1] : 'text'
  const code = String(children).replace(/\n$/, '')

  const copy = async () => {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!className) {
    return (
      <code className="rounded-md bg-slate-200 px-1.5 py-0.5 font-mono text-[0.85em] text-cyan-800 ring-1 ring-slate-300/80 dark:bg-slate-800/90 dark:text-cyan-100 dark:ring-slate-600/50">
        {children}
      </code>
    )
  }

  return (
    <div className="group relative my-4 max-w-full overflow-x-auto rounded-xl border border-slate-300 dark:border-slate-600/60 bg-[#0d1117] shadow-lg">
      <div className="flex items-center justify-between border-b border-slate-300 dark:border-slate-700/80 bg-white dark:bg-slate-900/90 px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400">
        <span className="font-mono text-slate-700 dark:text-slate-300">{language}</span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-slate-700 transition hover:bg-slate-100 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" /> Copy
            </>
          )}
        </button>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: '0.875rem 1rem',
          background: 'transparent',
          fontSize: '0.8125rem',
          lineHeight: 1.55,
        }}
        codeTagProps={{ className: 'font-mono' }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

/** Horizontal scroll only on this strip; keeps the rest of the message full-width. */
function TableScroll({ children }) {
  return (
    <div className="my-6 w-full max-w-full overflow-x-auto overscroll-x-contain rounded-lg border border-slate-300 dark:border-slate-600/70 bg-white dark:bg-slate-950/25 shadow-inner [scrollbar-color:rgba(148,163,184,0.35)_transparent]">
      {children}
    </div>
  )
}

function MarkdownTable({ node: _node, children, className, ...rest }) {
  return (
    <TableScroll>
      <table
        {...rest}
        className={[
          'w-max min-w-full border-collapse text-left text-sm text-slate-800 dark:text-slate-200',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {children}
      </table>
    </TableScroll>
  )
}

function MarkdownTh({ node: _node, children, className, ...rest }) {
  return (
    <th
      {...rest}
      className={[
        'sticky top-0 z-[1] border-b border-slate-300 dark:border-slate-600 bg-slate-200 dark:bg-slate-800 px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-900 dark:text-slate-100',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </th>
  )
}

function MarkdownTd({ node: _node, children, className, ...rest }) {
  return (
    <td
      {...rest}
      className={[
        'border-b border-slate-300 dark:border-slate-700/90 px-3 py-2.5 align-top text-sm leading-snug text-slate-800 dark:text-slate-200/95',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </td>
  )
}

function MarkdownTbody({ node: _node, children, className, ...rest }) {
  return (
    <tbody
      {...rest}
      className={[
        '[&>tr:last-child_td]:border-b-0 [&>tr:nth-child(even)_td]:bg-slate-50 dark:[&>tr:nth-child(even)_td]:bg-slate-900/35 [&>tr:hover_td]:bg-slate-100 dark:[&>tr:hover_td]:bg-slate-800/40',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </tbody>
  )
}

const VARIANT_CLASSES = {
  chat: [
    'prose prose-slate max-w-none min-w-0 dark:prose-invert',
    'prose-sm sm:prose-base',
    'prose-p:my-4 prose-p:leading-[1.65] prose-p:break-words',
    'prose-headings:scroll-mt-4 prose-headings:font-semibold prose-headings:tracking-tight',
    'prose-h1:mt-8 prose-h1:mb-4 prose-h1:text-xl prose-h2:mt-10 prose-h2:mb-3 prose-h2:text-lg prose-h3:mt-8 prose-h3:mb-2.5 prose-h3:text-base prose-h4:mt-7 prose-h4:mb-2 prose-h4:text-base',
    'prose-strong:font-semibold',
    'prose-a:break-all prose-a:text-cyan-600 prose-a:underline prose-a:decoration-cyan-500/40 prose-a:underline-offset-2 hover:prose-a:text-cyan-500 dark:prose-a:text-cyan-400 dark:hover:prose-a:text-cyan-300',
    'prose-blockquote:my-6 prose-blockquote:border-l-cyan-500/50 prose-blockquote:bg-slate-100 prose-blockquote:py-2 prose-blockquote:pl-4 prose-blockquote:not-italic dark:prose-blockquote:bg-slate-800/40',
    'prose-code:break-all',
    'prose-ul:my-5 prose-ul:pl-1 prose-ol:my-5 prose-ol:pl-1',
    'prose-li:my-1.5 prose-li:marker:text-cyan-600/80 dark:prose-li:marker:text-cyan-500/80',
    'prose-img:my-6 prose-img:max-w-full prose-img:rounded-lg prose-img:border prose-img:border-slate-200 dark:prose-img:border-slate-700/60',
  ].join(' '),
  reasoning: [
    'prose prose-slate max-w-none min-w-0 prose-sm dark:prose-invert',
    'prose-p:my-3 prose-p:leading-relaxed prose-p:break-words prose-p:text-slate-600 dark:prose-p:text-slate-400',
    'prose-headings:mt-6 prose-headings:mb-2 prose-headings:font-medium prose-headings:text-sm prose-headings:text-slate-700 dark:prose-headings:text-slate-300',
    'prose-strong:text-slate-800 dark:prose-strong:text-slate-300',
    'prose-code:break-all prose-code:text-violet-700 dark:prose-code:text-violet-200/90',
    'prose-a:text-violet-600 dark:prose-a:text-violet-400',
    'prose-ul:my-3 prose-ol:my-3 prose-li:my-1',
    'prose-blockquote:my-4',
  ].join(' '),
  document: [
    'prose prose-slate max-w-none min-w-0 dark:prose-invert',
    'prose-base sm:prose-lg',
    'prose-p:my-4 prose-p:leading-[1.65] prose-p:break-words prose-p:text-slate-800 dark:prose-p:text-slate-200/95',
    'prose-headings:font-semibold prose-headings:text-slate-900 dark:prose-headings:text-slate-50',
    'prose-h1:mt-8 prose-h1:mb-4 prose-h1:text-2xl prose-h2:mt-10 prose-h2:mb-3 prose-h2:text-xl prose-h3:mt-8 prose-h3:mb-2.5 prose-h3:text-lg',
    'prose-strong:text-slate-900 dark:prose-strong:text-white',
    'prose-a:text-cyan-600 prose-a:underline prose-a:decoration-cyan-500/40 dark:prose-a:text-cyan-400',
    'prose-blockquote:my-6 prose-blockquote:border-l-emerald-500/40 prose-blockquote:text-slate-700 dark:prose-blockquote:text-slate-300',
    'prose-ul:my-5 prose-ol:my-5 prose-li:my-1.5 prose-li:marker:text-emerald-600/80 dark:prose-li:marker:text-emerald-500/70',
    'prose-img:my-6 prose-img:max-w-full',
  ].join(' '),
}

/** Padding avoids margin-collapse eating space above/below the rule. */
function MarkdownHr({ node: _node, className, ...rest }) {
  return (
    <div className="w-full py-5 sm:py-6">
      <hr
        {...rest}
        className={['m-0 w-full border-0 border-t border-slate-300 dark:border-slate-600/80', className].filter(Boolean).join(' ')}
      />
    </div>
  )
}

function MarkdownHrCompact({ node: _node, className, ...rest }) {
  return (
    <div className="w-full py-4 sm:py-5">
      <hr
        {...rest}
        className={['m-0 w-full border-0 border-t border-slate-300 dark:border-slate-600/60', className].filter(Boolean).join(' ')}
      />
    </div>
  )
}

/**
 * Click handler for inline `Source N` pills: opens any closed `<details>`
 * ancestors of the matching list item, scrolls it into view, and briefly
 * outlines it so the user can see which excerpt was cited.
 */
function handleSourcePillClick(e) {
  const href = e.currentTarget.getAttribute('href') || ''
  if (!href.startsWith('#src-')) return
  e.preventDefault()
  if (typeof document === 'undefined') return
  const id = href.slice(1)
  const target = document.getElementById(id)
  if (!target) return
  let detail = target.closest('details')
  while (detail) {
    if (!detail.open) detail.open = true
    detail = detail.parentElement?.closest('details') ?? null
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' })
  target.classList.add(
    'ring-2',
    'ring-cyan-500/70',
    'dark:ring-cyan-300/70',
    'shadow-md',
  )
  window.setTimeout(() => {
    target.classList.remove(
      'ring-2',
      'ring-cyan-500/70',
      'dark:ring-cyan-300/70',
      'shadow-md',
    )
  }, 1600)
}

function createMarkdownComponents({ hr: HrComponent }) {
  return {
    code(props) {
      const { children, className } = props
      return <CodeBlock className={className}>{children}</CodeBlock>
    },
    a({ children, href }) {
      if (typeof href === 'string' && href.startsWith('#src-')) {
        return (
          <a
            href={href}
            onClick={handleSourcePillClick}
            className="not-prose mx-0.5 inline-flex items-center gap-1 rounded-md border border-cyan-400/60 bg-cyan-100/80 px-1.5 py-0 align-baseline text-[0.78em] font-medium leading-snug text-cyan-800 no-underline transition hover:border-cyan-500/80 hover:bg-cyan-200/80 dark:border-cyan-500/40 dark:bg-cyan-950/50 dark:text-cyan-200 dark:hover:border-cyan-300/70 dark:hover:bg-cyan-900/60"
          >
            {children}
          </a>
        )
      }
      return (
        <a
          href={href}
          className="break-words font-medium text-cyan-600 underline decoration-cyan-500/40 underline-offset-2 transition hover:text-cyan-500 dark:text-cyan-400 dark:hover:text-cyan-300"
          target="_blank"
          rel="noreferrer"
        >
          {children}
        </a>
      )
    },
    hr(props) {
      return <HrComponent {...props} />
    },
    table(props) {
      return <MarkdownTable {...props} />
    },
    th(props) {
      return <MarkdownTh {...props} />
    },
    td(props) {
      return <MarkdownTd {...props} />
    },
    tbody(props) {
      return <MarkdownTbody {...props} />
    },
  }
}

/**
 * Convert plain "Source N" / "Sources 1 and 2" / "Sources 1, 2 and 3"
 * mentions into anchor links pointing at the corresponding `<li>` rendered
 * by `RetrievedSources` (`id="src-{msgId}-{n}"`). Each link will be styled
 * as a cyan pill by the `a` component override above and, on click, will
 * scroll to + briefly highlight that excerpt.
 *
 * Only enabled when the assistant message actually has retrieved sources
 * attached, so we never invent links for messages that have nothing to
 * point at.
 */
function rewriteSourceMentions(text, msgId, max) {
  if (!text || !msgId || !max) return text || ''
  const re =
    /\b[Ss]ources?\s+(#?\d+(?:\s*(?:,\s*|\s+(?:and|&)\s+)\s*#?\d+)*)\b/g
  return text.replace(re, (full, list) => {
    const nums = list.match(/\d+/g)
    if (!nums || nums.length === 0) return full
    const valid = []
    const seen = new Set()
    for (const raw of nums) {
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 1 || n > max) continue
      if (seen.has(n)) continue
      seen.add(n)
      valid.push(n)
    }
    if (!valid.length) return full
    return valid.map((n) => `[Source ${n}](#src-${msgId}-${n})`).join(', ')
  })
}

/**
 * @param {{
 *   content: string,
 *   variant?: 'chat' | 'reasoning' | 'document',
 *   msgId?: string,
 *   sources?: Array<unknown>,
 * }} props
 */
export function MarkdownMessage({ content, variant = 'chat', msgId, sources }) {
  const prose = VARIANT_CLASSES[variant] || VARIANT_CLASSES.chat
  const components = useMemo(
    () =>
      createMarkdownComponents({
        hr: variant === 'reasoning' ? MarkdownHrCompact : MarkdownHr,
      }),
    [variant],
  )

  const numSources = Array.isArray(sources) ? sources.length : 0
  const processed = useMemo(() => {
    if (variant !== 'chat' || !numSources || !msgId) return content || ''
    return rewriteSourceMentions(content, msgId, numSources)
  }, [content, variant, msgId, numSources])

  return (
    <div className={`max-w-full min-w-0 overflow-x-hidden break-words ${prose}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={components}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
}
