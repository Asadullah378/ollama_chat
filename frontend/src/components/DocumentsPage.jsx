import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  FileText,
  FileUp,
  Hash,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import {
  deleteLibraryDocument,
  getLibraryDocument,
  listLibraryDocuments,
  reindexLibraryDocument,
  uploadLibraryDocument,
} from '../lib/api'
import { useToastStore } from '../store/useToastStore'
import { MarkdownMessage } from './MarkdownMessage'

function formatBytes(n) {
  if (n == null) return '—'
  const v = Number(n)
  if (Number.isNaN(v)) return String(n)
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} GB`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} MB`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} KB`
  return `${v} B`
}

function formatDurationMs(ms) {
  if (ms == null || Number.isNaN(ms) || ms <= 0) return null
  const v = Number(ms)
  if (v < 1000) return `${v} ms`
  const s = v / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)} s`
  const m = Math.floor(s / 60)
  const r = Math.round(s - m * 60)
  return `${m}m ${r}s`
}

function formatTokens(n) {
  if (n == null || Number.isNaN(n)) return null
  const v = Number(n)
  if (!v) return null
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`
  return String(v)
}

function DocumentStats({ row, compact }) {
  const mdTok = formatTokens(row.markdown_token_count)
  const ragTok = formatTokens(row.chunks_token_count)
  const mineruMs = formatDurationMs(row.mineru_duration_ms)
  const embedMs = formatDurationMs(row.embedding_duration_ms)
  const totalMs = formatDurationMs(row.total_processing_ms)
  if (!mdTok && !ragTok && !mineruMs && !embedMs) return null
  return (
    <div
      className={`mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 ${
        compact ? 'text-[10.5px]' : 'text-[11px]'
      } text-slate-600 dark:text-slate-400`}
    >
      {mdTok ? (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white/70 px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-900/60"
          title="Tokens used when sending the full markdown (RAG off). Estimated with tiktoken cl100k_base."
        >
          <Hash className="h-3 w-3 opacity-70" />
          Full {mdTok} tok
        </span>
      ) : null}
      {ragTok ? (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-cyan-300/70 bg-cyan-50 px-1.5 py-0.5 text-cyan-800 dark:border-cyan-500/30 dark:bg-cyan-950/30 dark:text-cyan-200"
          title="Sum of tokens across all RAG chunks (upper bound for retrieval mode)."
        >
          <Database className="h-3 w-3 opacity-70" />
          RAG {ragTok} tok
        </span>
      ) : null}
      {(mineruMs || embedMs || totalMs) && !compact ? (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white/70 px-1.5 py-0.5 dark:border-slate-700 dark:bg-slate-900/60"
          title={`MinerU: ${mineruMs || '—'} · Embedding: ${embedMs || '—'} · Total: ${
            totalMs || '—'
          }`}
        >
          <Clock className="h-3 w-3 opacity-70" />
          {totalMs || mineruMs || embedMs}
        </span>
      ) : null}
    </div>
  )
}

const STATUS_STYLES = {
  pending: {
    label: 'Queued',
    cls: 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400',
    Icon: Loader2,
    iconAnimated: false,
  },
  embedding: {
    label: 'Embedding…',
    cls: 'border-cyan-300/70 bg-cyan-50 text-cyan-800 dark:border-cyan-500/30 dark:bg-cyan-950/30 dark:text-cyan-200',
    Icon: Loader2,
    iconAnimated: true,
  },
  ready: {
    label: 'RAG ready',
    cls: 'border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/30 dark:text-emerald-200',
    Icon: CheckCircle2,
    iconAnimated: false,
  },
  failed: {
    label: 'Embed failed',
    cls: 'border-rose-300/70 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-950/30 dark:text-rose-200',
    Icon: AlertTriangle,
    iconAnimated: false,
  },
  disabled: {
    label: 'RAG off',
    cls: 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400',
    Icon: Database,
    iconAnimated: false,
  },
}

function EmbeddingStatus({ row, onReindex, busy }) {
  const status = row.embedding_status || 'pending'
  const style = STATUS_STYLES[status] || STATUS_STYLES.pending
  const Icon = style.Icon
  const showReindex = status === 'failed' || status === 'ready'
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${style.cls}`}
        >
          <Icon className={`h-3 w-3 ${style.iconAnimated ? 'animate-spin' : ''}`} />
          {style.label}
          {status === 'ready' && row.chunk_count ? (
            <span className="opacity-70">· {row.chunk_count} chunks</span>
          ) : null}
        </span>
        {showReindex ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full border border-slate-300 px-1.5 py-0.5 text-[10px] text-slate-600 hover:border-cyan-500/50 hover:text-cyan-600 disabled:opacity-40 dark:border-slate-700 dark:text-slate-400"
            onClick={(e) => {
              e.stopPropagation()
              onReindex(row.id)
            }}
            disabled={busy}
            title="Re-embed this document"
          >
            <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
            Re-embed
          </button>
        ) : null}
      </div>
      {status === 'failed' && row.embedding_error ? (
        <p className="break-words text-[11px] leading-snug text-rose-700 dark:text-rose-300">
          {row.embedding_error}
        </p>
      ) : null}
    </div>
  )
}

export function DocumentsPage() {
  const toast = useToastStore((s) => s.push)
  const [draft, setDraft] = useState('')
  const [applied, setApplied] = useState('')
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [preview, setPreview] = useState(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [reindexingId, setReindexingId] = useState(null)
  const [uploading, setUploading] = useState(false)
  const itemsRef = useRef(items)
  itemsRef.current = items

  const runQuery = useCallback(async () => {
    setLoading(true)
    try {
      const data = await listLibraryDocuments({ q: applied.trim() || undefined, limit: 100, offset: 0 })
      setItems(data.items || [])
      setTotal(data.total ?? 0)
    } catch (e) {
      toast(e.message || 'Failed to load documents', 'error')
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [applied, toast])

  const refreshQuiet = useCallback(async () => {
    try {
      const data = await listLibraryDocuments({ q: applied.trim() || undefined, limit: 100, offset: 0 })
      setItems(data.items || [])
      setTotal(data.total ?? 0)
    } catch {
      /* ignore silent refresh failures */
    }
  }, [applied])

  useEffect(() => {
    void runQuery()
  }, [runQuery])

  useEffect(() => {
    const anyInFlight = items.some(
      (r) => r.embedding_status === 'pending' || r.embedding_status === 'embedding',
    )
    if (!anyInFlight) return undefined
    const t = setInterval(refreshQuiet, 3000)
    return () => clearInterval(t)
  }, [items, refreshQuiet])

  const onReindex = async (id) => {
    setReindexingId(id)
    try {
      await reindexLibraryDocument(id)
      toast('Re-embedding scheduled', 'success')
      await refreshQuiet()
    } catch (e) {
      toast(e.message || 'Re-embed failed', 'error')
    } finally {
      setReindexingId(null)
    }
  }

  const onUploadFiles = async (files) => {
    if (!files?.length) return
    setUploading(true)
    try {
      for (const f of files) {
        const r = await uploadLibraryDocument(f)
        if (r.deduplicated && r.message) {
          toast(`«${r.original_filename}» — ${r.message}`, 'success')
        } else {
          toast(`Saved «${r.original_filename}» (${Number(r.char_count).toLocaleString()} chars)`, 'success')
        }
      }
      await runQuery()
    } catch (e) {
      toast(e.message || 'Upload failed', 'error')
    } finally {
      setUploading(false)
    }
  }

  const openPreview = async (id) => {
    setPreviewLoading(true)
    setPreview(null)
    try {
      const d = await getLibraryDocument(id)
      setPreview(d)
    } catch (e) {
      toast(e.message || 'Could not load document', 'error')
    } finally {
      setPreviewLoading(false)
    }
  }

  const remove = async (id, name) => {
    if (!window.confirm(`Delete «${name}» from docs? Chats will no longer resolve this id.`)) return
    setDeletingId(id)
    try {
      await deleteLibraryDocument(id)
      toast('Document deleted', 'success')
      if (preview?.id === id) setPreview(null)
      await runQuery()
    } catch (e) {
      toast(e.message || 'Delete failed', 'error')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden text-slate-800 dark:text-slate-200">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-200/90 bg-white/60 px-4 py-2.5 backdrop-blur dark:border-slate-800/80 dark:bg-slate-950/30">
        <FileText className="h-5 w-5 text-emerald-500" />
        <h1 className="text-base font-semibold tracking-tight">Docs</h1>
        <span className="text-xs text-slate-500">MinerU → Markdown · PostgreSQL</span>
        <button
          type="button"
          onClick={() => runQuery()}
          className="ml-auto inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Refresh
        </button>
      </header>

      <main className="mx-auto min-h-0 w-full max-w-6xl flex-1 space-y-6 overflow-y-auto p-4 pb-8">
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-emerald-400/60 bg-emerald-50/80 px-4 py-8 text-sm text-emerald-900/90 hover:border-emerald-500/50 dark:border-emerald-800/50 dark:bg-emerald-950/15 dark:text-emerald-100/90 dark:hover:border-emerald-500/40">
          <input
            type="file"
            multiple
            className="hidden"
            disabled={uploading}
            accept=".pdf,.doc,.docx,.ppt,.pptx,.xlsx,.xls,.html,.htm,.txt,.text,.md,.markdown,.png,.jpg,.jpeg,.webp,.tif,.tiff,.csv,.json"
            onChange={(e) => {
              const files = [...(e.target.files || [])]
              e.target.value = ''
              void onUploadFiles(files)
            }}
          />
          {uploading ? (
            <Loader2 className="h-8 w-8 animate-spin text-emerald-400" />
          ) : (
            <FileUp className="h-8 w-8 text-emerald-400/80" />
          )}
          {uploading ? 'Parsing with MinerU…' : 'Drop files here or click to upload (saved to docs)'}
        </label>

        <div className="relative flex max-w-md gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 py-2 pl-9 pr-3 text-sm outline-none ring-cyan-500/20 focus:ring-2"
              placeholder="Filter by filename…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setApplied(draft.trim())
              }}
            />
          </div>
          <button
            type="button"
            className="shrink-0 rounded-xl border border-slate-300 dark:border-slate-700 px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            onClick={() => setApplied(draft.trim())}
          >
            Search
          </button>
        </div>

        <div className="grid gap-6 lg:grid-cols-5">
          <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-900/40 lg:col-span-2">
            <div className="border-b border-slate-200/90 dark:border-slate-800/80 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {total} documents
            </div>
            {loading && !items.length ? (
              <div className="flex justify-center py-16">
                <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
              </div>
            ) : (
              <ul className="max-h-[70vh] divide-y divide-slate-200 dark:divide-slate-800/80 overflow-y-auto">
                {items.map((row) => (
                  <li
                    key={row.id}
                    className={`flex items-start gap-2 px-3 py-2 ${
                      preview?.id === row.id
                        ? 'bg-cyan-500/10 ring-1 ring-cyan-500/25 dark:ring-cyan-500/30'
                        : ''
                    }`}
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => openPreview(row.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          openPreview(row.id)
                        }
                      }}
                      className={`min-w-0 flex-1 cursor-pointer rounded-lg px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/40 ${
                        preview?.id === row.id
                          ? 'text-cyan-950 dark:text-cyan-100'
                          : 'text-slate-800 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800/50'
                      }`}
                    >
                      <span className="block truncate font-medium">{row.original_filename}</span>
                      <span className="text-xs text-slate-500">
                        {formatBytes(row.source_bytes)} · {Number(row.char_count).toLocaleString()} chars
                      </span>
                      <DocumentStats row={row} compact />
                      <EmbeddingStatus
                        row={row}
                        onReindex={onReindex}
                        busy={reindexingId === row.id}
                      />
                    </div>
                    <button
                      type="button"
                      className="shrink-0 rounded-lg p-2 text-slate-500 hover:bg-rose-500/15 hover:text-rose-400 disabled:opacity-40"
                      title="Delete"
                      disabled={deletingId === row.id}
                      onClick={() => remove(row.id, row.original_filename)}
                    >
                      {deletingId === row.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-900/30 lg:col-span-3">
            <div className="border-b border-slate-200/90 dark:border-slate-800/80 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Preview
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-4">
              {previewLoading ? (
                <div className="flex justify-center py-16">
                  <Loader2 className="h-8 w-8 animate-spin text-slate-500" />
                </div>
              ) : preview ? (
                <div>
                  <h2 className="mb-2 text-base font-semibold text-slate-900 dark:text-slate-100">{preview.original_filename}</h2>
                  <p className="mb-2 text-xs text-slate-500">
                    id <code className="text-cyan-700/90">{preview.id}</code> · backend{' '}
                    {preview.mineru_backend}
                  </p>
                  <div className="mb-4">
                    <DocumentStats row={preview} />
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-inner dark:border-slate-800/90 dark:bg-gradient-to-b dark:from-slate-950/80 dark:to-slate-900/40">
                    <MarkdownMessage content={preview.markdown || ''} variant="document" />
                  </div>
                </div>
              ) : (
                <p className="py-12 text-center text-sm text-slate-500">Select a document to preview Markdown.</p>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  )
}
