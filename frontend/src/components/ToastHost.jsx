import { X } from 'lucide-react'
import { useToastStore } from '../store/useToastStore'

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex max-w-sm flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg backdrop-blur ${
            t.variant === 'success'
              ? 'border-emerald-400/50 bg-emerald-50 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-950/90 dark:text-emerald-100'
              : t.variant === 'info'
                ? 'border-sky-400/50 bg-sky-50 text-sky-950 dark:border-sky-500/40 dark:bg-slate-900/95 dark:text-sky-50'
                : 'border-rose-400/50 bg-rose-50 text-rose-900 dark:border-rose-500/40 dark:bg-rose-950/90 dark:text-rose-50'
          }`}
        >
          <p className="flex-1 leading-snug">{t.message}</p>
          <button
            type="button"
            className="rounded p-0.5 text-slate-600 hover:bg-slate-200/80 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-white/10 dark:hover:text-white"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  )
}
