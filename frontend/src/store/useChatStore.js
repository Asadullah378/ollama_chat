import { create } from 'zustand'
import {
  createSessionOnServer,
  deleteSessionOnServer,
  fetchChatBootstrap,
  flushSessionSave,
  schedulePreferencesSave,
  scheduleSessionSave,
  savePreferencesToServer,
} from '../lib/chatSync'

export const SESSION_TITLE_MAX = 80

export function clampSessionTitle(title) {
  const t = String(title ?? '').trim()
  if (!t) return 'New chat'
  return t.length > SESSION_TITLE_MAX ? t.slice(0, SESSION_TITLE_MAX) : t
}

export function titleFromFirstMessage(content) {
  const oneLine = String(content ?? '').replace(/\s+/g, ' ').trim()
  if (!oneLine) return 'New chat'
  if (oneLine.length <= SESSION_TITLE_MAX) return oneLine
  return `${oneLine.slice(0, SESSION_TITLE_MAX - 1)}…`
}

const emptySession = (model = '') => ({
  id: crypto.randomUUID(),
  title: 'New chat',
  model,
  messages: [],
  ollamaHistory: [],
  libraryDocs: [],
  updatedAt: Date.now(),
})

function onSyncError(err) {
  useChatStore.setState({ syncError: err?.message || 'Could not save chat to server' })
}

function persistSession(session) {
  const st = useChatStore.getState()
  if (!st.hydrated) return
  scheduleSessionSave(session, onSyncError)
}

function persistPreferences() {
  const st = useChatStore.getState()
  if (!st.hydrated) return
  schedulePreferencesSave(
    {
      activeId: st.activeId,
      defaultModel: st.defaultModel,
      sidebarOpen: st.sidebarOpen,
      ragEnabled: st.ragEnabled,
    },
    onSyncError,
  )
}

export const useChatStore = create((set, get) => ({
  sessions: [],
  activeId: null,
  sidebarOpen: true,
  defaultModel: '',
  ragEnabled: true,
  hydrated: false,
  hydrating: false,
  syncError: null,

  async loadFromServer() {
    if (get().hydrating) return
    set({ hydrating: true, syncError: null })
    try {
      const data = await fetchChatBootstrap()
      let sessions = (data.sessions || []).map(normalizeSession)
      const prefs = data.preferences || {}

      if (!sessions.length) {
        const s = emptySession(prefs.defaultModel || '')
        const created = await createSessionOnServer(s)
        sessions = [normalizeSession(created)]
      }

      let activeId = prefs.activeId
      if (!activeId || !sessions.some((x) => x.id === activeId)) {
        activeId = sessions[0].id
      }

      set({
        sessions,
        activeId,
        defaultModel: prefs.defaultModel || '',
        sidebarOpen: prefs.sidebarOpen ?? true,
        ragEnabled: prefs.ragEnabled ?? true,
        hydrated: true,
        hydrating: false,
        syncError: null,
      })
    } catch (e) {
      set({
        hydrating: false,
        hydrated: false,
        syncError: e?.message || 'Could not load chats (is PostgreSQL configured?)',
      })
      throw e
    }
  },

  init() {
    void get().loadFromServer()
  },

  clearSyncError() {
    set({ syncError: null })
  },

  toggleSidebar() {
    set((s) => {
      const sidebarOpen = !s.sidebarOpen
      persistPreferences()
      return { sidebarOpen }
    })
  },

  setSidebarOpen(v) {
    set({ sidebarOpen: v })
    persistPreferences()
  },

  createSession() {
    const s = emptySession(get().defaultModel || '')
    set((st) => ({
      sessions: [s, ...st.sessions],
      activeId: s.id,
    }))
    void createSessionOnServer(s).catch(onSyncError)
    persistPreferences()
    return s.id
  },

  deleteSession(id) {
    set((st) => {
      const sessions = st.sessions.filter((x) => x.id !== id)
      if (!sessions.length) {
        const s = emptySession(st.defaultModel || '')
        void createSessionOnServer(s).catch(onSyncError)
        persistPreferences()
        return { sessions: [s], activeId: s.id }
      }
      const activeId = st.activeId === id ? sessions[0].id : st.activeId
      persistPreferences()
      return { sessions, activeId }
    })
    void deleteSessionOnServer(id).catch(onSyncError)
  },

  setActive(id) {
    set({ activeId: id })
    persistPreferences()
  },

  renameSession(id, title) {
    const clamped = clampSessionTitle(title)
    set((st) => {
      const sessions = st.sessions.map((s) =>
        s.id === id ? { ...s, title: clamped, updatedAt: Date.now() } : s,
      )
      const session = sessions.find((x) => x.id === id)
      if (session) persistSession(session)
      return { sessions }
    })
  },

  setSessionModel(id, model) {
    set((st) => {
      const sessions = st.sessions.map((s) =>
        s.id === id ? { ...s, model, updatedAt: Date.now() } : s,
      )
      const session = sessions.find((x) => x.id === id)
      if (session) persistSession(session)
      return { sessions }
    })
  },

  setDefaultModel(m) {
    set({ defaultModel: m })
    persistPreferences()
  },

  setRagEnabled(v) {
    set({ ragEnabled: !!v })
    persistPreferences()
  },

  toggleRag() {
    set((s) => ({ ragEnabled: !s.ragEnabled }))
    persistPreferences()
  },

  removeMessage(sessionId, messageId) {
    set((st) => {
      const sessions = st.sessions.map((s) => {
        if (s.id !== sessionId) return s
        const next = {
          ...s,
          messages: s.messages.filter((m) => m.id !== messageId),
          updatedAt: Date.now(),
        }
        persistSession(next)
        return next
      })
      return { sessions }
    })
  },

  appendUserMessage(sessionId, { content, images }) {
    set((st) => {
      const sessions = st.sessions.map((s) => {
        if (s.id !== sessionId) return s
        const msg = {
          id: crypto.randomUUID(),
          role: 'user',
          content,
          images: images?.length ? images : undefined,
        }
        const title =
          s.title === 'New chat' && content ? titleFromFirstMessage(content) : s.title
        const next = {
          ...s,
          title,
          messages: [...s.messages, msg],
          updatedAt: Date.now(),
        }
        persistSession(next)
        return next
      })
      return { sessions }
    })
  },

  appendAssistantShell(sessionId) {
    const aid = crypto.randomUUID()
    set((st) => {
      const sessions = st.sessions.map((s) => {
        if (s.id !== sessionId) return s
        const next = {
          ...s,
          messages: [
            ...s.messages,
            {
              id: aid,
              role: 'assistant',
              content: '',
              thinking: '',
              streaming: true,
              toolEvents: [],
            },
          ],
          updatedAt: Date.now(),
        }
        persistSession(next)
        return next
      })
      return { sessions }
    })
    return aid
  },

  patchMessage(sessionId, messageId, partial) {
    set((st) => {
      const sessions = st.sessions.map((s) => {
        if (s.id !== sessionId) return s
        const next = {
          ...s,
          messages: s.messages.map((m) =>
            m.id === messageId ? { ...m, ...partial } : m,
          ),
          updatedAt: Date.now(),
        }
        persistSession(next)
        return next
      })
      return { sessions }
    })
  },

  setMessageSources(sessionId, messageId, sources) {
    set((st) => {
      const sessions = st.sessions.map((s) => {
        if (s.id !== sessionId) return s
        const next = {
          ...s,
          messages: s.messages.map((m) =>
            m.id === messageId
              ? { ...m, sources: Array.isArray(sources) ? sources : [] }
              : m,
          ),
          updatedAt: Date.now(),
        }
        persistSession(next)
        return next
      })
      return { sessions }
    })
  },

  appendToolEvent(sessionId, messageId, event) {
    set((st) => {
      const sessions = st.sessions.map((s) => {
        if (s.id !== sessionId) return s
        const next = {
          ...s,
          messages: s.messages.map((m) => {
            if (m.id !== messageId) return m
            return { ...m, toolEvents: [...(m.toolEvents || []), event] }
          }),
          updatedAt: Date.now(),
        }
        persistSession(next)
        return next
      })
      return { sessions }
    })
  },

  updateToolEvent(sessionId, messageId, toolName, partial) {
    set((st) => {
      const sessions = st.sessions.map((s) => {
        if (s.id !== sessionId) return s
        const next = {
          ...s,
          messages: s.messages.map((m) => {
            if (m.id !== messageId) return m
            const te = [...(m.toolEvents || [])]
            for (let i = te.length - 1; i >= 0; i--) {
              if (te[i].name === toolName && te[i].phase === 'running') {
                te[i] = { ...te[i], ...partial }
                break
              }
            }
            return { ...m, toolEvents: te }
          }),
          updatedAt: Date.now(),
        }
        persistSession(next)
        return next
      })
      return { sessions }
    })
  },

  setOllamaHistory(sessionId, messages) {
    set((st) => {
      const sessions = st.sessions.map((s) => {
        if (s.id !== sessionId) return s
        const next = { ...s, ollamaHistory: messages, updatedAt: Date.now() }
        void flushSessionSave(next).catch(onSyncError)
        return next
      })
      return { sessions }
    })
  },

  addLibraryDoc(sessionId, doc) {
    const id = doc.id
    if (!id) return
    set((st) => {
      const sessions = st.sessions.map((s) => {
        if (s.id !== sessionId) return s
        const cur = s.libraryDocs || []
        if (cur.some((d) => d.id === id)) {
          const next = { ...s, updatedAt: Date.now() }
          persistSession(next)
          return next
        }
        const next = {
          ...s,
          libraryDocs: [...cur, { id, fileName: doc.fileName || 'document' }],
          updatedAt: Date.now(),
        }
        persistSession(next)
        return next
      })
      return { sessions }
    })
  },

  removeLibraryDoc(sessionId, docId) {
    set((st) => {
      const sessions = st.sessions.map((s) => {
        if (s.id !== sessionId) return s
        const next = {
          ...s,
          libraryDocs: (s.libraryDocs || []).filter((d) => d.id !== docId),
          updatedAt: Date.now(),
        }
        persistSession(next)
        return next
      })
      return { sessions }
    })
  },

  clearLibraryDocs(sessionId) {
    set((st) => {
      const sessions = st.sessions.map((s) =>
        s.id === sessionId
          ? (() => {
              const next = { ...s, libraryDocs: [], updatedAt: Date.now() }
              persistSession(next)
              return next
            })()
          : s,
      )
      return { sessions }
    })
  },

  finalizeStreaming(sessionId) {
    set((st) => {
      const sessions = st.sessions.map((s) => {
        if (s.id !== sessionId) return s
        const next = {
          ...s,
          messages: s.messages.map((m) =>
            m.role === 'assistant' && m.streaming
              ? { ...m, streaming: false }
              : m,
          ),
          updatedAt: Date.now(),
        }
        void flushSessionSave(next).catch(onSyncError)
        return next
      })
      return { sessions }
    })
  },
}))

function normalizeMessage(m) {
  const out = { ...m }
  if (out.sources != null && !Array.isArray(out.sources)) {
    out.sources = []
  }
  if (out.toolEvents != null && !Array.isArray(out.toolEvents)) {
    out.toolEvents = []
  }
  return out
}

function normalizeSession(s) {
  return {
    id: s.id,
    title: s.title || 'New chat',
    model: s.model || '',
    messages: Array.isArray(s.messages) ? s.messages.map(normalizeMessage) : [],
    ollamaHistory: Array.isArray(s.ollamaHistory) ? s.ollamaHistory : [],
    libraryDocs: Array.isArray(s.libraryDocs) ? s.libraryDocs : [],
    updatedAt: s.updatedAt || Date.now(),
  }
}
