import { apiDelete, apiGet, apiPost, apiPut } from './api'

/** @typedef {import('../store/useChatStore').Session} Session */

/**
 * Load all chats and preferences from PostgreSQL.
 * @returns {Promise<{ preferences: { activeId: string|null, defaultModel: string, sidebarOpen: boolean }, sessions: Session[] }>}
 */
export async function fetchChatBootstrap() {
  return apiGet('/api/chats/bootstrap')
}

/**
 * @param {Session} session
 */
export function sessionToPayload(session) {
  return {
    id: session.id,
    title: session.title,
    model: session.model || '',
    messages: (session.messages || []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content ?? '',
      ...(m.thinking ? { thinking: m.thinking } : {}),
      ...(m.images?.length ? { images: m.images } : {}),
      ...(m.toolEvents?.length ? { toolEvents: m.toolEvents } : {}),
      ...(m.sources?.length ? { sources: m.sources } : {}),
      ...(m.streaming ? { streaming: true } : {}),
    })),
    ollamaHistory: session.ollamaHistory || [],
    libraryDocs: session.libraryDocs || [],
    updatedAt: session.updatedAt,
  }
}

/**
 * @param {Session} session
 */
export async function saveSessionToServer(session) {
  return apiPut(`/api/chats/sessions/${encodeURIComponent(session.id)}`, sessionToPayload(session))
}

/**
 * @param {{ activeId?: string|null, defaultModel?: string, sidebarOpen?: boolean, ragEnabled?: boolean }} prefs
 */
export async function savePreferencesToServer(prefs) {
  return apiPut('/api/chats/preferences', {
    activeId: prefs.activeId ?? null,
    defaultModel: prefs.defaultModel ?? '',
    sidebarOpen: prefs.sidebarOpen ?? true,
    ragEnabled: prefs.ragEnabled ?? true,
  })
}

/**
 * @param {Session} [session]
 */
export async function createSessionOnServer(session) {
  return apiPost('/api/chats/sessions', session ? sessionToPayload(session) : {})
}

export async function deleteSessionOnServer(sessionId) {
  return apiDelete(`/api/chats/sessions/${encodeURIComponent(sessionId)}`)
}

const saveTimers = new Map()

/**
 * Debounced per-session persist (500ms).
 * @param {Session} session
 * @param {(err: Error) => void} [onError]
 */
export function scheduleSessionSave(session, onError) {
  if (!session?.id) return
  const prev = saveTimers.get(session.id)
  if (prev) clearTimeout(prev)
  saveTimers.set(
    session.id,
    setTimeout(async () => {
      saveTimers.delete(session.id)
      try {
        await saveSessionToServer(session)
      } catch (e) {
        onError?.(e instanceof Error ? e : new Error(String(e)))
      }
    }, 500),
  )
}

let prefsTimer = null

/**
 * @param {{ activeId?: string|null, defaultModel?: string, sidebarOpen?: boolean, ragEnabled?: boolean }} prefs
 * @param {(err: Error) => void} [onError]
 */
export function schedulePreferencesSave(prefs, onError) {
  if (prefsTimer) clearTimeout(prefsTimer)
  prefsTimer = setTimeout(async () => {
    prefsTimer = null
    try {
      await savePreferencesToServer(prefs)
    } catch (e) {
      onError?.(e instanceof Error ? e : new Error(String(e)))
    }
  }, 400)
}

/** Flush pending save immediately (e.g. after stream completes). */
export async function flushSessionSave(session) {
  if (!session?.id) return
  const t = saveTimers.get(session.id)
  if (t) {
    clearTimeout(t)
    saveTimers.delete(session.id)
  }
  await saveSessionToServer(session)
}
