import { useEffect, useRef, useState } from 'react'
import { Cpu, Gauge } from 'lucide-react'

function formatMs(ms) {
  if (ms == null || Number.isNaN(ms)) return '—'
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`
  const m = Math.floor(s / 60)
  const r = Math.round(s - m * 60)
  return `${m}m ${r}s`
}

function tokensPerSec(tokens, ms) {
  if (!tokens || !ms || ms <= 0) return null
  return (tokens / (ms / 1000)).toFixed(1)
}

/**
 * Compact usage badge that sits next to an assistant message. Click to see
 * the full timing + token breakdown reported by Ollama.
 */
export function MessageUsage({ usage }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    const onEsc = (e) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  if (!usage) return null
  const {
    promptTokens,
    completionTokens,
    totalDurationMs,
    loadDurationMs,
    promptEvalDurationMs,
    evalDurationMs,
  } = usage

  if (
    promptTokens == null &&
    completionTokens == null &&
    totalDurationMs == null
  )
    return null

  const total =
    (Number(promptTokens) || 0) + (Number(completionTokens) || 0)
  const tps = tokensPerSec(completionTokens, evalDurationMs)

  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white/80 px-2 py-0.5 text-[11px] font-medium text-slate-600 shadow-sm hover:border-cyan-400/60 hover:text-cyan-700 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-400 dark:hover:border-cyan-500/40 dark:hover:text-cyan-300"
        title="Token + timing details"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Gauge className="h-3 w-3" />
        <span className="tabular-nums">{total.toLocaleString()} tok</span>
      </button>
      {open ? (
        <div
          role="dialog"
          className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-700 shadow-xl ring-1 ring-black/5 dark:border-slate-700/70 dark:bg-slate-900 dark:text-slate-300 dark:ring-white/10"
        >
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-200">
            <Cpu className="h-4 w-4 text-cyan-500" />
            Response usage
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <dt className="text-slate-500 dark:text-slate-400">Input tokens</dt>
            <dd className="text-right tabular-nums font-medium">
              {promptTokens?.toLocaleString() ?? '—'}
            </dd>
            <dt className="text-slate-500 dark:text-slate-400">Output tokens</dt>
            <dd className="text-right tabular-nums font-medium">
              {completionTokens?.toLocaleString() ?? '—'}
            </dd>
            <dt className="text-slate-500 dark:text-slate-400">Total tokens</dt>
            <dd className="text-right tabular-nums font-medium">
              {total.toLocaleString()}
            </dd>
            {tps ? (
              <>
                <dt className="text-slate-500 dark:text-slate-400">Speed</dt>
                <dd className="text-right tabular-nums font-medium">{tps} tok/s</dd>
              </>
            ) : null}
          </dl>
          <hr className="my-2 border-slate-200 dark:border-slate-700/70" />
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <dt className="text-slate-500 dark:text-slate-400">Total time</dt>
            <dd className="text-right tabular-nums font-medium">
              {formatMs(totalDurationMs)}
            </dd>
            <dt className="text-slate-500 dark:text-slate-400">Model load</dt>
            <dd className="text-right tabular-nums">{formatMs(loadDurationMs)}</dd>
            <dt className="text-slate-500 dark:text-slate-400">Prompt eval</dt>
            <dd className="text-right tabular-nums">
              {formatMs(promptEvalDurationMs)}
            </dd>
            <dt className="text-slate-500 dark:text-slate-400">Generation</dt>
            <dd className="text-right tabular-nums">{formatMs(evalDurationMs)}</dd>
          </dl>
        </div>
      ) : null}
    </div>
  )
}
