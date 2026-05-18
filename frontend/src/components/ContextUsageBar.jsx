import { Gauge } from 'lucide-react'

/**
 * Header progress bar showing how much of the model's context window the
 * current conversation is using. `used` is the latest assistant turn's
 * `prompt_tokens + completion_tokens` (Ollama re-evaluates the entire chat
 * each turn, so that's the real "current context size").
 */
export function ContextUsageBar({ used, limit, model }) {
  if (!used && !limit) return null

  const pct = limit ? Math.min(100, Math.round(((used || 0) / limit) * 100)) : null

  let barClass = 'bg-cyan-500'
  let textClass = 'text-slate-600 dark:text-slate-400'
  if (pct != null) {
    if (pct >= 90) {
      barClass = 'bg-rose-500'
      textClass = 'text-rose-700 dark:text-rose-300'
    } else if (pct >= 70) {
      barClass = 'bg-amber-500'
      textClass = 'text-amber-700 dark:text-amber-300'
    }
  }

  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200/80 bg-slate-50/70 px-2.5 py-1 dark:border-slate-700/60 dark:bg-slate-900/60"
      title={
        limit
          ? `${used?.toLocaleString() ?? 0} / ${limit.toLocaleString()} tokens — ${model || ''}`
          : `${used?.toLocaleString() ?? 0} tokens used (context window unknown)`
      }
    >
      <Gauge className={`h-3.5 w-3.5 shrink-0 ${textClass}`} />
      <div className="flex min-w-[100px] flex-col gap-0.5">
        <div
          className={`flex items-center justify-between gap-2 text-[11px] font-medium ${textClass}`}
        >
          <span>Context</span>
          <span className="tabular-nums">
            {(used || 0).toLocaleString()}
            {limit ? (
              <>
                <span className="text-slate-400 dark:text-slate-500"> / </span>
                {limit.toLocaleString()}
                <span className="ml-1 text-slate-400 dark:text-slate-500">({pct}%)</span>
              </>
            ) : null}
          </span>
        </div>
        {limit ? (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-800">
            <div
              className={`h-full ${barClass} transition-[width] duration-300`}
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
