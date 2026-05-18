import { useState } from 'react'
import { BookOpenText, ChevronRight } from 'lucide-react'

/**
 * Compact accordion showing which document chunks were retrieved for an
 * assistant message (only rendered when RAG was used and at least one
 * source matched).
 *
 * Each list item gets a stable DOM id (`src-{msgId}-{n}`) so the
 * `Source N` pills inside the markdown reply can scroll to and highlight the
 * matching excerpt.
 *
 * @param {{ msgId?: string, sources?: Array<{
 *   chunk_id: string,
 *   document_id: string,
 *   document_name: string,
 *   chunk_index: number,
 *   heading_path: string,
 *   kind: string,
 *   similarity: number,
 *   preview: string,
 * }> }} props
 */
export function RetrievedSources({ msgId, sources }) {
  const [open, setOpen] = useState(false)
  if (!sources || sources.length === 0) return null

  return (
    <details
      id={msgId ? `src-list-${msgId}` : undefined}
      className="min-w-0 w-full rounded-lg border border-cyan-300/60 bg-cyan-50/70 text-xs text-cyan-950 shadow-sm dark:border-cyan-500/25 dark:bg-cyan-950/30 dark:text-cyan-100"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 outline-none">
        <BookOpenText className="h-4 w-4 shrink-0 opacity-80" />
        <span className="font-medium">
          Retrieved {sources.length} {sources.length === 1 ? 'excerpt' : 'excerpts'}
        </span>
        <span className="ml-auto inline-flex items-center text-[10px] uppercase tracking-wider text-cyan-700 dark:text-cyan-300/80">
          {open ? 'Hide' : 'Show'}
          <ChevronRight
            className={`ml-1 h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`}
          />
        </span>
      </summary>
      <ol className="space-y-2 border-t border-cyan-300/40 px-3 py-2 dark:border-cyan-500/20">
        {sources.map((s, i) => (
          <li
            id={msgId ? `src-${msgId}-${i + 1}` : undefined}
            key={s.chunk_id || `${s.document_id}-${s.chunk_index}-${i}`}
            className="scroll-mt-24 rounded-md border border-cyan-200/60 bg-white/60 px-2 py-1.5 transition-shadow duration-300 dark:border-cyan-500/20 dark:bg-cyan-950/40"
          >
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-700/80 dark:text-cyan-300/80">
                #{i + 1}
              </span>
              <span className="truncate font-medium text-cyan-900 dark:text-cyan-100">
                {s.document_name}
              </span>
              {s.heading_path ? (
                <span className="truncate text-cyan-700/80 dark:text-cyan-300/70">
                  · {s.heading_path}
                </span>
              ) : null}
              <span className="ml-auto text-[10px] text-cyan-700/70 dark:text-cyan-300/70">
                {Math.round((s.similarity ?? 0) * 100)}% match
              </span>
            </div>
            {s.preview ? (
              <p className="mt-1 max-h-32 overflow-hidden text-[11px] leading-snug text-slate-700 dark:text-slate-200/90">
                {s.preview}
              </p>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  )
}
