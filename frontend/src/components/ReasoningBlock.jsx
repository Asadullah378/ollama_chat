import { ChevronRight, Loader2, Sparkles } from 'lucide-react'
import { MarkdownMessage } from './MarkdownMessage'

/**
 * Collapsible model reasoning (Ollama `message.thinking`). Closed by default; user opens to read.
 * While the reply is still streaming, a small spinner on the summary indicates activity.
 */
export function ReasoningBlock({ text, streaming }) {
  if (!text?.trim()) return null

  return (
    <details className="group mb-3 overflow-hidden rounded-xl border border-violet-300/60 bg-gradient-to-b from-violet-50 to-slate-50 shadow-inner shadow-violet-200/30 dark:border-violet-500/25 dark:from-violet-950/35 dark:to-slate-950/40 dark:shadow-violet-950/20">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs font-medium text-violet-800 dark:text-violet-100/95 [&::-webkit-details-marker]:hidden">
        <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-300" />
        <span>Model reasoning</span>
        {streaming ? (
          <Loader2
            className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-500/80 dark:text-violet-300/80"
            aria-label="Reasoning still streaming"
          />
        ) : null}
        <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-violet-500/80 transition-transform duration-200 group-open:rotate-90 dark:text-violet-400/80" />
      </summary>
      <div className="max-h-56 max-w-full overflow-y-auto overflow-x-auto border-t border-violet-200/80 px-3 py-2.5 dark:border-violet-500/15">
        <MarkdownMessage content={text} variant="reasoning" />
      </div>
    </details>
  )
}
