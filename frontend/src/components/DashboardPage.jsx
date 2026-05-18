import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, Cpu, Download, Loader2, Search, Trash2, X } from 'lucide-react'
import { apiDelete, apiGet, apiPost, streamPostSse } from '../lib/api'
import { useToastStore } from '../store/useToastStore'

function formatBytes(n) {
  if (n == null) return '—'
  const v = Number(n)
  if (Number.isNaN(v)) return String(n)
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} GB`
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} MB`
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} KB`
  return `${v} B`
}

function SkeletonTable() {
  return (
    <div className="animate-pulse space-y-2 p-4">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="h-10 rounded bg-slate-200 dark:bg-slate-800/80" />
      ))}
    </div>
  )
}

export function DashboardPage() {
  const toast = useToastStore((s) => s.push)
  const [tags, setTags] = useState(null)
  const [ps, setPs] = useState(null)
  const [loading, setLoading] = useState(true)
  const [pullName, setPullName] = useState('')
  const [pulling, setPulling] = useState(false)
  const [pullLog, setPullLog] = useState(null)
  const [inspector, setInspector] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [t, p] = await Promise.all([apiGet('/api/tags'), apiGet('/api/ps')])
      setTags(t)
      setPs(p)
    } catch (e) {
      toast(e.message || 'Failed to load models', 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    load()
  }, [load])

  const runningSet = useMemo(() => {
    const names = new Set()
    for (const m of ps?.models ?? []) {
      if (m.name) names.add(m.name)
      if (m.model) names.add(m.model)
    }
    return names
  }, [ps])

  const models = tags?.models ?? []

  const pull = async () => {
    const name = pullName.trim()
    if (!name || pulling) return
    setPulling(true)
    setPullLog({ status: 'starting', completed: 0, total: 1 })
    try {
      await streamPostSse(
        '/api/pull',
        { model: name, insecure: false },
        (ev) => {
          if (ev.type === 'progress') setPullLog(ev.data)
          if (ev.type === 'error') toast(ev.message, 'error')
        },
      )
      toast(`Pulled ${name}`, 'success')
      setPullName('')
      load()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setPulling(false)
      setPullLog(null)
    }
  }

  const del = async (name) => {
    if (!confirm(`Delete model "${name}"?`)) return
    try {
      await apiDelete(`/api/delete?model=${encodeURIComponent(name)}`)
      toast(`Deleted ${name}`, 'success')
      load()
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  const dup = async (name) => {
    const dest = window.prompt('New model name (destination)', `${name}-copy`)
    if (!dest) return
    try {
      await apiPost('/api/copy', { source: name, destination: dest.trim() })
      toast(`Copied to ${dest}`, 'success')
      load()
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  const openInspector = async (name) => {
    try {
      const data = await apiPost('/api/show', { model: name })
      setInspector({ name, data })
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  const progressPct =
    pullLog?.total > 0 ? Math.min(100, Math.round((pullLog.completed / pullLog.total) * 100)) : 0

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden text-slate-800 dark:text-slate-200">
      <header className="flex shrink-0 items-center gap-3 border-b border-slate-200/90 bg-white/60 px-4 py-2.5 backdrop-blur dark:border-slate-800/80 dark:bg-slate-950/30">
        <Cpu className="h-5 w-5 text-violet-500" />
        <h1 className="text-base font-semibold tracking-tight">Models</h1>
        <button
          type="button"
          onClick={() => load()}
          className="ml-auto inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Refresh
        </button>
      </header>

      <main className="mx-auto min-h-0 w-full max-w-6xl flex-1 space-y-8 overflow-y-auto p-4 pb-8">
        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-900/40 p-4 shadow-lg shadow-cyan-950/20">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
            <Search className="h-4 w-4" /> Pull model
          </h2>
          <div className="flex flex-wrap gap-2">
            <input
              className="min-w-[200px] flex-1 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm outline-none ring-cyan-500/20 focus:ring-2"
              placeholder="e.g. llama3.2:latest"
              value={pullName}
              onChange={(e) => setPullName(e.target.value)}
              disabled={pulling}
            />
            <button
              type="button"
              disabled={pulling}
              onClick={() => pull()}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-cyan-600 to-violet-600 px-4 py-2 text-sm font-medium text-white shadow-lg shadow-cyan-900/30 disabled:opacity-50"
            >
              {pulling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Pull
            </button>
          </div>
          {pullLog ? (
            <div className="mt-3">
              <div className="mb-1 flex justify-between text-xs text-slate-500">
                <span>{pullLog.status || 'downloading'}</span>
                <span>
                  {pullLog.completed ?? 0} / {pullLog.total ?? '?'} bytes
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-violet-500 transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          ) : null}
        </section>

        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-900/40 p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
            Running in memory
          </h2>
          {!ps ? (
            <SkeletonTable />
          ) : (ps.models ?? []).length === 0 ? (
            <p className="text-sm text-slate-500">No models loaded. Send a chat message to load one.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-slate-500">
                  <tr>
                    <th className="pb-2 pr-4">Model</th>
                    <th className="pb-2 pr-4">VRAM</th>
                    <th className="pb-2 pr-4">RAM</th>
                    <th className="pb-2">Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {(ps.models ?? []).map((m) => (
                    <tr key={m.name || m.model} className="border-t border-slate-200/90 dark:border-slate-800/80">
                      <td className="py-2 pr-4 font-mono text-cyan-200">{m.name || m.model}</td>
                      <td className="py-2 pr-4">{formatBytes(m.size_vram)}</td>
                      <td className="py-2 pr-4">{formatBytes(m.size)}</td>
                      <td className="py-2 text-slate-600 dark:text-slate-400">
                        {m.expires_at ? new Date(m.expires_at).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200/90 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-900/40 p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
            Installed models
          </h2>
          {loading && !tags ? (
            <SkeletonTable />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase text-slate-500">
                  <tr>
                    <th className="pb-2 pr-4">Model</th>
                    <th className="pb-2 pr-4">Size</th>
                    <th className="pb-2 pr-4">Params</th>
                    <th className="pb-2 pr-4">Quant</th>
                    <th className="pb-2 pr-4">Loaded</th>
                    <th className="pb-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => {
                    const name = m.model
                    const d = m.details || {}
                    return (
                      <tr key={name} className="border-t border-slate-200/90 dark:border-slate-800/80">
                        <td className="py-2 pr-4">
                          <button
                            type="button"
                            className="font-mono text-left text-cyan-300 hover:underline"
                            onClick={() => openInspector(name)}
                          >
                            {name}
                          </button>
                        </td>
                        <td className="py-2 pr-4">{formatBytes(m.size)}</td>
                        <td className="py-2 pr-4 text-slate-600 dark:text-slate-400">{d.parameter_size || '—'}</td>
                        <td className="py-2 pr-4 text-slate-600 dark:text-slate-400">{d.quantization_level || '—'}</td>
                        <td className="py-2 pr-4">
                          {runningSet.has(name) ? (
                            <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs text-emerald-300">
                              yes
                            </span>
                          ) : (
                            <span className="text-slate-500 dark:text-slate-600">no</span>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          <button
                            type="button"
                            className="mr-2 inline-flex rounded p-1.5 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white"
                            title="Duplicate"
                            onClick={() => dup(name)}
                          >
                            <Copy className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            className="inline-flex rounded p-1.5 text-slate-600 dark:text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                            title="Delete"
                            onClick={() => del(name)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

      </main>

      {inspector ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 md:items-center">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-4 py-3">
              <h3 className="font-mono text-sm text-cyan-200">{inspector.name}</h3>
              <button
                type="button"
                className="rounded p-1 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white"
                onClick={() => setInspector(null)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[calc(90vh-52px)] overflow-y-auto p-4 text-sm">
              <InspectorBody data={inspector.data} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function InspectorBody({ data }) {
  const info = data.model_info || data.modelinfo || {}
  return (
    <div className="space-y-6">
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase text-slate-500">Parameters</h4>
        <pre className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 p-3 text-xs text-slate-700 dark:text-slate-300">
          {data.parameters || '—'}
        </pre>
      </div>
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase text-slate-500">Template</h4>
        <pre className="max-h-48 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 p-3 text-xs text-slate-700 dark:text-slate-300">
          {data.template || '—'}
        </pre>
      </div>
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase text-slate-500">Modelfile</h4>
        <pre className="max-h-64 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 p-3 text-xs text-slate-700 dark:text-slate-300">
          {data.modelfile || '—'}
        </pre>
      </div>
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase text-slate-500">Model info (metadata)</h4>
        <pre className="max-h-48 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 p-3 text-xs text-slate-700 dark:text-slate-300">
          {JSON.stringify(info, null, 2)}
        </pre>
      </div>
      {data.license ? (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase text-slate-500">License</h4>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 p-3 text-xs text-slate-700 dark:text-slate-300">
            {data.license}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
