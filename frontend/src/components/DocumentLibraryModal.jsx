import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileUp, Loader2, Search, X } from 'lucide-react'
import { getLibraryDocument, listLibraryDocuments, uploadLibraryDocument } from '../lib/api'
import { useToastStore } from '../store/useToastStore'
import { MarkdownMessage } from './MarkdownMessage'

/**
 * Pick documents from the server library or upload new (parsed with MinerU, stored in Postgres).
 */
export function DocumentLibraryModal({ open, onClose, attachedIds, onAttachMany }) {
  const toast = useToastStore((s) => s.push)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState(() => new Set())
  const [uploadPreview, setUploadPreview] = useState(null)

  const attached = useMemo(() => new Set(attachedIds || []), [attachedIds])

  const loadList = useCallback(
    async (searchTerm) => {
      setLoading(true)
      try {
        const data = await listLibraryDocuments({
          q: searchTerm || undefined,
          limit: 80,
          offset: 0,
        })
        setItems(data.items || [])
        setTotal(data.total ?? 0)
      } catch (e) {
        toast(e.message || 'Could not load docs', 'error')
        setItems([])
      } finally {
        setLoading(false)
      }
    },
    [toast],
  )

  useEffect(() => {
    if (!open) return
    void loadList('')
  }, [open, loadList])

  useEffect(() => {
    if (!open) {
      setSelected(new Set())
      setQ('')
      setUploadPreview(null)
    }
  }, [open])

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const attachSelected = () => {
    const docs = []
    for (const id of selected) {
      const row = items.find((x) => x.id === id)
      if (row && !attached.has(id)) {
        docs.push({ id: row.id, fileName: row.original_filename })
      }
    }
    if (docs.length) onAttachMany(docs)
    setSelected(new Set())
    onClose()
  }

  const onFiles = async (files) => {
    if (!files?.length) return
    setUploading(true)
    try {
      const added = []
      for (const f of files) {
        const r = await uploadLibraryDocument(f)
        added.push({ id: r.id, fileName: r.original_filename })
        if (r.deduplicated && r.message) {
          toast(`«${r.original_filename}» — ${r.message}`, 'success')
        } else {
          toast(`Saved «${r.original_filename}» (${Number(r.char_count).toLocaleString()} chars)`, 'success')
        }
      }
      if (added.length) onAttachMany(added)
      await loadList(q.trim())
      const last = added[added.length - 1]
      if (last?.id) {
        try {
          const detail = await getLibraryDocument(last.id)
          setUploadPreview({
            id: detail.id,
            title: detail.original_filename,
            markdown: detail.markdown || '',
          })
        } catch {
          setUploadPreview(null)
        }
      }
    } catch (e) {
      toast(e.message || 'Upload failed', 'error')
    } finally {
      setUploading(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center">
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 shadow-2xl shadow-cyan-950/30"
        role="dialog"
        aria-modal="true"
        aria-labelledby="doc-lib-title"
      >
        <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-4 py-3">
          <h2 id="doc-lib-title" className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Docs
          </h2>
          <button
            type="button"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="border-b border-slate-200/90 dark:border-slate-800/80 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 py-2 pl-9 pr-3 text-sm outline-none ring-cyan-500/20 focus:ring-2"
              placeholder="Search by filename…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void loadList(q.trim())
              }}
            />
          </div>
          <label className="mt-3 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-emerald-400/60 bg-emerald-50/80 px-3 py-4 text-sm text-emerald-900/90 hover:border-emerald-500/50 dark:border-emerald-800/60 dark:bg-emerald-950/20 dark:text-emerald-200/90">
            <input
              type="file"
              multiple
              className="hidden"
              accept=".pdf,.doc,.docx,.ppt,.pptx,.xlsx,.xls,.html,.htm,.txt,.text,.md,.markdown,.png,.jpg,.jpeg,.webp,.tif,.tiff,.csv,.json"
              disabled={uploading}
              onChange={(e) => {
                const files = [...(e.target.files || [])]
                e.target.value = ''
                void onFiles(files)
              }}
            />
            {uploading ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              <FileUp className="h-5 w-5" />
            )}
            {uploading ? 'Processing with MinerU…' : 'Upload new files (saved to docs)'}
          </label>
          {uploadPreview ? (
            <details
              open
              className="mt-3 overflow-hidden rounded-xl border border-emerald-300/60 bg-white dark:border-emerald-800/40 dark:bg-slate-900/60"
            >
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-emerald-900 dark:text-emerald-100/90 [&::-webkit-details-marker]:hidden">
                Preview · {uploadPreview.title}
              </summary>
              <div className="max-h-64 overflow-y-auto border-t border-emerald-200/80 bg-white px-3 py-3 dark:border-emerald-900/30 dark:bg-transparent">
                <MarkdownMessage content={uploadPreview.markdown || ''} variant="document" />
              </div>
            </details>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex justify-center py-12 text-slate-500">
              <Loader2 className="h-8 w-8 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-slate-500">
              No documents yet. Upload above, or configure{' '}
              <code className="text-cyan-600/90">DATABASE_URL</code> if docs fail to load.
            </p>
          ) : (
            <ul className="space-y-1">
              {items.map((row) => {
                const isAttached = attached.has(row.id)
                const isSel = selected.has(row.id)
                return (
                  <li key={row.id}>
                    <label
                      className={`flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 text-sm ${
                        isAttached ? 'opacity-50' : 'hover:bg-slate-100 dark:hover:bg-slate-800/60'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 rounded border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 text-cyan-500"
                        checked={isSel}
                        disabled={isAttached}
                        onChange={() => toggle(row.id)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-slate-800 dark:text-slate-200">
                          {row.original_filename}
                        </span>
                        <span className="text-xs text-slate-500">
                          {Number(row.char_count).toLocaleString()} chars ·{' '}
                          {new Date(row.created_at).toLocaleString()}
                        </span>
                        {isAttached ? (
                          <span className="mt-0.5 block text-xs text-emerald-600/90">Already in this chat</span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-200 dark:border-slate-800 px-3 py-3 text-xs text-slate-500">
          <span>
            {total} in docs · {selected.size} selected
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded-lg bg-gradient-to-r from-cyan-600 to-violet-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
              disabled={!selected.size}
              onClick={attachSelected}
            >
              Attach to chat
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
