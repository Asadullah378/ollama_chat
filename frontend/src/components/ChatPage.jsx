import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Brain,
  Database,
  FileText,
  FileUp,
  ImagePlus,
  Loader2,
  Menu,
  MessageSquarePlus,
  PanelLeft,
  PanelLeftClose,
  Send,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import { streamPostSse } from '../lib/api'
import { chatModelsOnly } from '../lib/models'
import { SESSION_TITLE_MAX, useChatStore } from '../store/useChatStore'
import { useToastStore } from '../store/useToastStore'
import { DocumentLibraryModal } from './DocumentLibraryModal'
import { MarkdownMessage } from './MarkdownMessage'
import { ReasoningBlock } from './ReasoningBlock'
import { RetrievedSources } from './RetrievedSources'

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const res = String(r.result || '')
      const i = res.indexOf('base64,')
      resolve(i >= 0 ? res.slice(i + 7) : res)
    }
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

function toApiMessages(msgs) {
  return msgs.map((m) => {
    const o = { role: m.role, content: m.content ?? '' }
    if (m.role === 'user' && m.images?.length) o.images = m.images
    return o
  })
}

/**
 * Convert noisy server / library errors into something readable. Strips
 * JSON noise like `{"detail":"..."}` and `status_code=...` wrappers.
 */
function friendlyErrorMessage(raw) {
  if (raw == null) return ''
  const text = String(raw).trim()
  if (!text) return ''
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed === 'string') return parsed
      if (parsed && typeof parsed === 'object') {
        const pick = parsed.detail || parsed.message || parsed.error
        if (typeof pick === 'string' && pick.trim()) return pick.trim()
        if (pick && typeof pick === 'object' && typeof pick.message === 'string') {
          return pick.message
        }
      }
    } catch {
      /* fall through */
    }
  }
  return text.replace(/^Error:\s*/i, '').slice(0, 500)
}

export function ChatPage({
  models,
  runningNames,
  modelsLoading,
  refreshModels,
}) {
  const fileRef = useRef(null)
  const bottomRef = useRef(null)
  const abortRef = useRef(null)
  const titleInputRef = useRef(null)

  const sessions = useChatStore((s) => s.sessions)
  const activeId = useChatStore((s) => s.activeId)
  const sidebarOpen = useChatStore((s) => s.sidebarOpen)
  const hydrated = useChatStore((s) => s.hydrated)
  const hydrating = useChatStore((s) => s.hydrating)
  const syncError = useChatStore((s) => s.syncError)
  const init = useChatStore((s) => s.init)
  const clearSyncError = useChatStore((s) => s.clearSyncError)
  const loadFromServer = useChatStore((s) => s.loadFromServer)
  const toggleSidebar = useChatStore((s) => s.toggleSidebar)
  const setSidebarOpen = useChatStore((s) => s.setSidebarOpen)
  const createSession = useChatStore((s) => s.createSession)
  const deleteSession = useChatStore((s) => s.deleteSession)
  const setActive = useChatStore((s) => s.setActive)
  const renameSession = useChatStore((s) => s.renameSession)
  const setSessionModel = useChatStore((s) => s.setSessionModel)
  const setDefaultModel = useChatStore((s) => s.setDefaultModel)
  const defaultModel = useChatStore((s) => s.defaultModel)
  const appendUserMessage = useChatStore((s) => s.appendUserMessage)
  const appendAssistantShell = useChatStore((s) => s.appendAssistantShell)
  const patchMessage = useChatStore((s) => s.patchMessage)
  const appendToolEvent = useChatStore((s) => s.appendToolEvent)
  const updateToolEvent = useChatStore((s) => s.updateToolEvent)
  const finalizeStreaming = useChatStore((s) => s.finalizeStreaming)
  const setOllamaHistory = useChatStore((s) => s.setOllamaHistory)
  const addLibraryDoc = useChatStore((s) => s.addLibraryDoc)
  const removeLibraryDoc = useChatStore((s) => s.removeLibraryDoc)
  const clearLibraryDocs = useChatStore((s) => s.clearLibraryDocs)
  const ragEnabled = useChatStore((s) => s.ragEnabled)
  const toggleRag = useChatStore((s) => s.toggleRag)
  const removeMessage = useChatStore((s) => s.removeMessage)
  const setMessageSources = useChatStore((s) => s.setMessageSources)

  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState([])
  const [sending, setSending] = useState(false)
  const [docLibOpen, setDocLibOpen] = useState(false)
  /** When true, Ollama `think` is enabled; reasoning still streams into the closed-by-default accordion. Off by default. */
  const [reasoningEnabled, setReasoningEnabled] = useState(false)
  const [editingTitleId, setEditingTitleId] = useState(null)
  /** @type {'header' | 'sidebar' | null} */
  const [titleEditSource, setTitleEditSource] = useState(null)
  const [titleDraft, setTitleDraft] = useState('')
  /** Inline friendly error banner for the active session (last failed send). */
  const [chatError, setChatError] = useState(null)

  const session = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? sessions[0],
    [sessions, activeId],
  )

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => {
    if (editingTitleId) {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }
  }, [editingTitleId])

  const startTitleEdit = useCallback((id, title, source) => {
    setEditingTitleId(id)
    setTitleEditSource(source)
    setTitleDraft(title)
  }, [])

  const commitTitleEdit = useCallback(() => {
    if (!editingTitleId) return
    renameSession(editingTitleId, titleDraft)
    setEditingTitleId(null)
    setTitleEditSource(null)
  }, [editingTitleId, titleDraft, renameSession])

  const cancelTitleEdit = useCallback(() => {
    setEditingTitleId(null)
    setTitleEditSource(null)
  }, [])

  const titleEditKeyDown = useCallback(
    (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitTitleEdit()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        cancelTitleEdit()
      }
    },
    [commitTitleEdit, cancelTitleEdit],
  )

  useEffect(() => {
    if (!session) return
    if (!session.model && defaultModel) {
      setSessionModel(session.id, defaultModel)
    }
  }, [session, defaultModel, setSessionModel])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [session?.messages, session?.libraryDocs, sending])

  const modelOptions = useMemo(
    () => chatModelsOnly(models).map((m) => m.model).filter(Boolean),
    [models],
  )

  const pickModel = useCallback(
    (v) => {
      if (!session) return
      setSessionModel(session.id, v)
      setDefaultModel(v)
    },
    [session, setSessionModel, setDefaultModel],
  )

  const stop = () => {
    abortRef.current?.abort()
    abortRef.current = null
    setSending(false)
    if (session) finalizeStreaming(session.id)
  }

  const send = async () => {
    if (!session || !input.trim() || sending) return
    const text = input.trim()
    const model = session.model || defaultModel || modelOptions[0]
    if (!model) {
      useToastStore.getState().push('Select a model first.', 'error')
      return
    }

    let imgs = []
    if (attachments.length) {
      imgs = await Promise.all(attachments.map((f) => fileToBase64(f)))
    }

    appendUserMessage(session.id, { content: text, images: imgs.length ? imgs : undefined })
    setInput('')
    setAttachments([])

    const stSession = useChatStore.getState().sessions.find((s) => s.id === session.id)
    const prevHist = stSession?.ollamaHistory
    const userPayload = {
      role: 'user',
      content: text,
      ...(imgs.length ? { images: imgs } : {}),
    }
    const apiMessages =
      prevHist?.length > 0
        ? [...prevHist, userPayload]
        : toApiMessages(stSession?.messages ?? [])

    setSending(true)
    setChatError(null)
    const ac = new AbortController()
    abortRef.current = ac

    let assistantMsgId = null
    let currentRound = 0
    let receivedError = null
    // Retrieval events arrive before `round_start`. Stash the sources here and
    // attach them to the assistant message the moment the shell is created —
    // creating an early shell on `retrieval` would orphan an empty bubble (the
    // duplicate "Thinking…" loader users were seeing in RAG chats).
    let pendingRagSources = null

    const ensureAssistant = () => {
      assistantMsgId = appendAssistantShell(session.id)
      if (pendingRagSources && assistantMsgId) {
        setMessageSources(session.id, assistantMsgId, pendingRagSources)
        pendingRagSources = null
      }
    }

    const libIds = (stSession?.libraryDocs || []).map((d) => d.id).filter(Boolean)

    const chatPayload = {
      model,
      messages: apiMessages,
    }
    if (libIds.length) {
      chatPayload.saved_document_ids = libIds
      chatPayload.rag_enabled = !!ragEnabled
    }
    chatPayload.think = reasoningEnabled

    try {
      await streamPostSse(
        '/api/chat',
        chatPayload,
        (ev) => {
          if (ev.type === 'round_start') {
            const r = ev.round ?? 1
            if (r !== currentRound) {
              currentRound = r
              if (r > 1 && assistantMsgId) {
                patchMessage(session.id, assistantMsgId, { streaming: false })
              }
              ensureAssistant()
            } else if (!assistantMsgId) {
              ensureAssistant()
            }
          }
          if (ev.type === 'retrieval' && Array.isArray(ev.sources)) {
            if (assistantMsgId) {
              setMessageSources(session.id, assistantMsgId, ev.sources)
            } else {
              pendingRagSources = ev.sources
            }
          }
          if (ev.type === 'ollama_chunk' && !assistantMsgId) {
            ensureAssistant()
          }
          if (ev.type === 'ollama_chunk' && assistantMsgId) {
            const thinkPiece = ev.chunk?.message?.thinking
            if (reasoningEnabled && thinkPiece) {
              const s = useChatStore.getState().sessions.find((x) => x.id === session.id)
              const m = s?.messages.find((x) => x.id === assistantMsgId)
              patchMessage(session.id, assistantMsgId, {
                thinking: (m?.thinking ?? '') + thinkPiece,
              })
            }
            const piece = ev.chunk?.message?.content
            if (piece) {
              const s = useChatStore.getState().sessions.find((x) => x.id === session.id)
              const m = s?.messages.find((x) => x.id === assistantMsgId)
              const next = (m?.content ?? '') + piece
              patchMessage(session.id, assistantMsgId, { content: next })
            }
          }
          if (ev.type === 'tool_executing' && assistantMsgId) {
            appendToolEvent(session.id, assistantMsgId, {
              name: ev.name,
              args: ev.arguments,
              phase: 'running',
            })
          }
          if (ev.type === 'tool_done' && assistantMsgId) {
            updateToolEvent(session.id, assistantMsgId, ev.name, {
              phase: 'done',
              result: ev.result,
            })
          }
          if (ev.type === 'finished' && Array.isArray(ev.messages)) {
            setOllamaHistory(session.id, ev.messages)
          }
          if (ev.type === 'error') {
            receivedError = friendlyErrorMessage(ev.message) || 'Chat failed.'
          }
        },
        ac.signal,
      )
    } catch (e) {
      if (e.name !== 'AbortError') {
        receivedError = friendlyErrorMessage(e?.message) || 'Request failed.'
      }
    } finally {
      if (receivedError) {
        if (assistantMsgId) {
          const s = useChatStore.getState().sessions.find((x) => x.id === session.id)
          const m = s?.messages.find((x) => x.id === assistantMsgId)
          if (!m?.content?.trim() && !(m?.toolEvents || []).length) {
            removeMessage(session.id, assistantMsgId)
          }
        }
        setChatError(receivedError)
      }
      finalizeStreaming(session.id)
      setSending(false)
      abortRef.current = null
      refreshModels?.()
    }
  }

  const attachedLibraryIds = useMemo(
    () => (session?.libraryDocs || []).map((d) => d.id),
    [session?.libraryDocs],
  )

  if (hydrating || !hydrated) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-slate-500 dark:text-slate-600 dark:text-slate-500">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="text-sm">Loading chats from server…</p>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-slate-600 dark:text-slate-400">
        {syncError ? (
          <>
            <p className="text-sm text-rose-300/90">{syncError}</p>
            <button
              type="button"
              className="rounded-lg border border-slate-300 dark:border-slate-600 px-4 py-2 text-sm hover:border-cyan-500/40"
              onClick={() => {
                clearSyncError()
                void loadFromServer()
              }}
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">Preparing chat…</p>
          </>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="relative flex h-full min-w-0 flex-1 overflow-hidden">
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-0 z-10 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}
      <aside
        className={`z-20 flex h-full flex-col border-r border-slate-200/90 dark:border-slate-800/80 bg-white/95 dark:bg-slate-950/95 shadow-xl transition-all duration-200 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:w-72 md:static ${
          sidebarOpen
            ? 'w-72 translate-x-0 md:w-72'
            : '-translate-x-full max-md:-translate-x-full md:w-0 md:translate-x-0 md:overflow-hidden md:border-0 md:opacity-0'
        } `}
      >
        <div className="flex items-center justify-between border-b border-slate-200/90 dark:border-slate-800/80 p-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Sessions
          </span>
          <button
            type="button"
            className="rounded-lg p-1.5 text-cyan-400 hover:bg-cyan-500/10"
            onClick={() => createSession()}
            title="New chat"
          >
            <MessageSquarePlus className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {sessions.map((s) => (
            <div
              key={s.id}
              className={`group mb-1 flex items-center gap-1 rounded-lg px-2 py-2 ${
                s.id === session.id
                  ? 'bg-cyan-500/10 ring-1 ring-cyan-500/30'
                  : 'hover:bg-slate-100 dark:hover:bg-slate-800/50'
              }`}
            >
              {editingTitleId === s.id && titleEditSource === 'sidebar' ? (
                <input
                  ref={titleInputRef}
                  className="min-w-0 flex-1 rounded border border-cyan-500/40 bg-white px-1.5 py-0.5 text-sm text-slate-800 outline-none ring-1 ring-cyan-500/30 dark:bg-slate-900 dark:text-slate-200"
                  value={titleDraft}
                  maxLength={SESSION_TITLE_MAX}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitTitleEdit}
                  onKeyDown={titleEditKeyDown}
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                />
              ) : (
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left text-sm text-slate-800 dark:text-slate-200"
                  title="Double-click to rename"
                  onClick={() => setActive(s.id)}
                  onDoubleClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    startTitleEdit(s.id, s.title, 'sidebar')
                  }}
                >
                  {s.title}
                </button>
              )}
              <button
                type="button"
                className="rounded p-1 text-slate-500 dark:text-slate-600 opacity-0 hover:bg-rose-500/20 hover:text-rose-400 group-hover:opacity-100"
                onClick={() => deleteSession(s.id)}
                title="Delete"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {syncError ? (
          <div className="border-b border-rose-300/60 bg-rose-50 px-3 py-1.5 text-center text-xs text-rose-800 dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-200/90">
            {syncError}
          </div>
        ) : null}
        <header className="flex items-center gap-2 border-b border-slate-200/90 dark:border-slate-800/80 bg-white/60 dark:bg-slate-950/30 px-3 py-2 backdrop-blur">
          <button
            type="button"
            className="rounded-lg p-2 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white md:hidden"
            onClick={() => setSidebarOpen(!sidebarOpen)}
          >
            <Menu className="h-5 w-5" />
          </button>
          <button
            type="button"
            className="hidden rounded-lg p-2 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-white md:inline-flex"
            onClick={() => toggleSidebar()}
            title="Toggle sidebar"
          >
            {sidebarOpen ? (
              <PanelLeftClose className="h-5 w-5" />
            ) : (
              <PanelLeft className="h-5 w-5" />
            )}
          </button>
          <div className="mx-1 h-6 w-px bg-slate-200 dark:bg-slate-800" />
          <Sparkles className="h-5 w-5 shrink-0 text-cyan-400" />
          {session && editingTitleId === session.id && titleEditSource === 'header' ? (
            <input
              ref={titleInputRef}
              className="min-w-0 flex-1 rounded-md border border-cyan-500/40 bg-white/80 px-2 py-0.5 text-sm font-medium text-slate-800 outline-none ring-2 ring-cyan-500/25 dark:bg-slate-900/80 dark:text-slate-200"
              value={titleDraft}
              maxLength={SESSION_TITLE_MAX}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitleEdit}
              onKeyDown={titleEditKeyDown}
            />
          ) : (
            <button
              type="button"
              className="min-w-0 flex-1 truncate rounded-md px-1 py-0.5 text-left text-sm font-medium text-slate-800 hover:bg-slate-100/80 dark:text-slate-200 dark:hover:bg-slate-800/50"
              title="Double-click to rename"
              onDoubleClick={() => session && startTitleEdit(session.id, session.title, 'header')}
            >
              {session?.title}
            </button>
          )}
        </header>

        <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/80 dark:border-slate-800/60 px-3 py-2">
          <label className="sr-only" htmlFor="model-select">
            Model
          </label>
          <select
            id="model-select"
            className="max-w-[min(100%,280px)] rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2 py-1.5 text-sm outline-none ring-cyan-500/30 focus:ring-2"
            value={session.model || defaultModel || ''}
            onChange={(e) => pickModel(e.target.value)}
            disabled={modelsLoading}
          >
            <option value="">{modelsLoading ? 'Loading models…' : 'Select model'}</option>
            {modelOptions.map((name) => (
              <option key={name} value={name}>
                {name}
                {runningNames.has(name) ? '  ● loaded' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-4">
          {session.messages.length === 0 && (
            <div className="mx-auto mt-16 max-w-md text-center text-slate-500">
              <p className="text-lg text-slate-700 dark:text-slate-300">Start a conversation</p>
              <p className="mt-2 text-sm">
                Choose a model, attach saved documents for grounded questions, or attach images for vision
                models.
              </p>
            </div>
          )}
          <div className="mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-4">
            {session.messages.map((m) => (
              <div
                key={m.id}
                className={`flex min-w-0 w-full ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                {m.role === 'user' ? (
                  <div
                    className="min-w-0 w-fit max-w-[min(100%,42rem)] rounded-2xl border border-violet-300/60 bg-violet-50 px-4 py-3 text-slate-900 shadow-xl ring-1 ring-violet-400/20 dark:border-violet-500/30 dark:bg-violet-950/50 dark:text-slate-100 dark:ring-violet-500/15"
                  >
                    <div className="min-w-0 max-w-full overflow-x-auto">
                      {m.images?.length ? (
                        <div className="mb-2 flex flex-wrap gap-2">
                          {m.images.map((b64, i) => (
                            <img
                              key={i}
                              src={`data:image/jpeg;base64,${b64}`}
                              alt=""
                              className="max-h-40 rounded-lg border border-slate-300 dark:border-slate-600"
                            />
                          ))}
                        </div>
                      ) : null}
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex min-w-0 max-w-[min(100%,42rem)] flex-col gap-2">
                    {m.sources?.length ? (
                      <div className="min-w-0 w-full">
                        <RetrievedSources msgId={m.id} sources={m.sources} />
                      </div>
                    ) : null}
                    {reasoningEnabled && m.thinking?.trim() ? (
                      <div className="min-w-0 w-full">
                        <ReasoningBlock text={m.thinking} streaming={Boolean(m.streaming)} />
                      </div>
                    ) : null}
                    {(m.toolEvents || []).map((ev, i) => (
                      <div
                        key={i}
                        className="min-w-0 w-full overflow-x-auto rounded-lg border border-amber-300/50 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-500/25 dark:bg-amber-950/30 dark:text-amber-100"
                      >
                        <div className="font-semibold text-amber-800 dark:text-amber-200">
                          {ev.phase === 'running' ? 'Running tool' : 'Tool result'}: {ev.name}
                        </div>
                        {ev.args && (
                          <pre className="mt-1 overflow-x-auto text-[0.7rem] text-amber-100/80">
                            {JSON.stringify(ev.args, null, 2)}
                          </pre>
                        )}
                        {ev.result && (
                          <pre className="mt-1 overflow-x-auto text-[0.7rem] text-emerald-200/90">
                            {typeof ev.result === 'string'
                              ? ev.result
                              : JSON.stringify(ev.result, null, 2)}
                          </pre>
                        )}
                      </div>
                    ))}
                    <div
                      className="min-w-0 w-fit max-w-full rounded-2xl border border-slate-300 dark:border-slate-600/50 bg-white dark:bg-slate-900/90 px-4 py-3 text-slate-800 dark:text-slate-200 shadow-xl shadow-slate-300/30 dark:shadow-slate-950/40 ring-1 ring-slate-200/80 dark:ring-slate-700/30 backdrop-blur-sm"
                    >
                      {m.streaming &&
                      !m.content?.trim() &&
                      !(m.toolEvents || []).length &&
                      !(m.thinking && m.thinking.trim()) ? (
                        <span className="inline-flex items-center gap-2 text-slate-500">
                          <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
                        </span>
                      ) : (
                        <div className="min-w-0 max-w-full space-y-2">
                          {m.streaming && !m.content?.trim() && m.thinking?.trim() ? (
                            <p className="text-xs text-slate-500">Composing answer…</p>
                          ) : null}
                          {m.content?.trim() ? (
                            <div className="min-w-0 max-w-full">
                              <MarkdownMessage
                                content={m.content}
                                variant="chat"
                                msgId={m.id}
                                sources={m.sources}
                              />
                            </div>
                          ) : m.streaming ? (
                            <span className="inline-flex items-center gap-2 text-slate-500">
                              <Loader2 className="h-4 w-4 animate-spin" /> Generating…
                            </span>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-slate-200/90 dark:border-slate-800/80 bg-white/70 dark:bg-slate-950/40 p-3 backdrop-blur">
          {chatError ? (
            <div className="mx-auto mb-2 flex max-w-3xl items-start gap-2 rounded-xl border border-rose-300/70 bg-rose-50 px-3 py-2 text-sm text-rose-900 shadow-sm dark:border-rose-500/30 dark:bg-rose-950/40 dark:text-rose-100">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500 dark:text-rose-300" />
              <div className="flex-1 break-words">
                <p className="font-medium">Couldn't generate a response</p>
                <p className="mt-0.5 text-rose-800/90 dark:text-rose-200/90">{chatError}</p>
              </div>
              <button
                type="button"
                className="shrink-0 rounded p-1 text-rose-500 hover:bg-rose-100 hover:text-rose-700 dark:hover:bg-rose-900/40 dark:hover:text-rose-200"
                onClick={() => setChatError(null)}
                aria-label="Dismiss error"
                title="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : null}
          {(session.libraryDocs?.length ?? 0) > 0 ? (
            <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-2">
              {(session.libraryDocs || []).map((d) => (
                <span
                  key={d.id}
                  className="inline-flex max-w-full items-center gap-1 rounded-full border border-emerald-300/70 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-900 dark:border-emerald-800/50 dark:bg-emerald-950/30 dark:text-emerald-100"
                  title="Stored on server; Markdown loaded when you send a message"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 opacity-70" />
                  <span className="truncate">{d.fileName}</span>
                  <button
                    type="button"
                    className="shrink-0 text-emerald-300/70 hover:text-rose-400"
                    onClick={() => removeLibraryDoc(session.id, d.id)}
                    aria-label={`Remove ${d.fileName}`}
                  >
                    ×
                  </button>
                </span>
              ))}
              <button
                type="button"
                className="text-xs text-slate-500 underline-offset-2 hover:text-rose-400 hover:underline"
                onClick={() => clearLibraryDocs(session.id)}
              >
                Clear all
              </button>
            </div>
          ) : null}
          {attachments.length > 0 && (
            <div className="mx-auto mb-2 flex max-w-3xl flex-wrap gap-2">
              {attachments.map((f) => (
                <span
                  key={f.name + f.size}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 px-2 py-0.5 text-xs text-slate-700 dark:text-slate-300"
                >
                  {f.name}
                  <button
                    type="button"
                    className="text-slate-500 hover:text-rose-400"
                    onClick={() =>
                      setAttachments((prev) => prev.filter((x) => x !== f))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="mx-auto flex max-w-3xl gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files || [])]
                setAttachments((p) => [...p, ...files])
                e.target.value = ''
              }}
            />
            <button
              type="button"
              className="shrink-0 rounded-xl border border-emerald-800/50 p-3 text-emerald-400/90 hover:border-emerald-500/50 hover:text-emerald-300 disabled:opacity-40"
              onClick={() => setDocLibOpen(true)}
              disabled={sending}
              title="Attach documents from docs or upload new"
            >
              <FileUp className="h-5 w-5" />
            </button>
            <button
              type="button"
              className="shrink-0 rounded-xl border border-slate-300 dark:border-slate-700 p-3 text-slate-600 dark:text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300"
              onClick={() => fileRef.current?.click()}
              title="Attach images"
            >
              <ImagePlus className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-pressed={reasoningEnabled}
              className={`shrink-0 rounded-xl border p-3 transition disabled:opacity-40 ${
                reasoningEnabled
                  ? 'border-violet-500/50 bg-violet-500/15 text-violet-700 ring-1 ring-violet-500/30 dark:text-violet-300'
                  : 'border-slate-300 text-slate-600 hover:border-violet-500/40 hover:text-violet-500 dark:border-slate-700 dark:text-slate-400 dark:hover:text-violet-400'
              }`}
              onClick={() => setReasoningEnabled((on) => !on)}
              disabled={sending}
              title={reasoningEnabled ? 'Model reasoning on (click to turn off)' : 'Model reasoning off (click to turn on)'}
            >
              <Brain className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-pressed={ragEnabled}
              className={`shrink-0 rounded-xl border p-3 transition disabled:opacity-40 ${
                ragEnabled
                  ? 'border-cyan-500/50 bg-cyan-500/15 text-cyan-700 ring-1 ring-cyan-500/30 dark:text-cyan-300'
                  : 'border-slate-300 text-slate-600 hover:border-cyan-500/40 hover:text-cyan-500 dark:border-slate-700 dark:text-slate-400 dark:hover:text-cyan-400'
              }`}
              onClick={() => toggleRag()}
              disabled={sending}
              title={
                ragEnabled
                  ? 'RAG on — retrieve relevant chunks from attached documents (click to use the full document instead)'
                  : 'RAG off — full attached documents are sent (click to enable retrieval)'
              }
            >
              <Database className="h-5 w-5" />
            </button>
            <textarea
              rows={1}
              className="max-h-40 min-h-[48px] flex-1 resize-y rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/80 px-3 py-3 text-sm outline-none ring-cyan-500/20 focus:ring-2"
              placeholder="Message… (Shift+Enter for newline)"
              value={input}
              disabled={sending}
              onChange={(e) => {
                setInput(e.target.value)
                if (chatError) setChatError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
            />
            {sending ? (
              <button
                type="button"
                className="shrink-0 rounded-xl bg-rose-600/90 px-4 py-3 text-white hover:bg-rose-500"
                onClick={stop}
              >
                <Square className="h-5 w-5" />
              </button>
            ) : (
              <button
                type="button"
                className="shrink-0 rounded-xl bg-gradient-to-br from-cyan-500 to-violet-600 px-4 py-3 text-white shadow-lg shadow-cyan-500/20 hover:opacity-95"
                onClick={() => send()}
              >
                <Send className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
      <DocumentLibraryModal
        open={docLibOpen}
        onClose={() => setDocLibOpen(false)}
        attachedIds={attachedLibraryIds}
        onAttachMany={(docs) => {
          for (const d of docs) {
            addLibraryDoc(session.id, d)
          }
        }}
      />
    </>
  )
}
