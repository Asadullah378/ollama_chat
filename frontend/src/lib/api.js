const jsonHeaders = { 'Content-Type': 'application/json' }

export async function apiGet(path) {
  const res = await fetch(path)
  if (!res.ok) {
    const t = await res.text()
    throw new Error(t || res.statusText)
  }
  return res.json()
}

export async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(t || res.statusText)
  }
  return res.json()
}

export async function apiPut(path, body) {
  const res = await fetch(path, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(t || res.statusText)
  }
  return res.json()
}

export async function apiDelete(path) {
  const res = await fetch(path, { method: 'DELETE' })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(t || res.statusText)
  }
  return res.json()
}

/**
 * @param {{ q?: string, limit?: number, offset?: number }} [opts]
 */
export async function listLibraryDocuments(opts = {}) {
  const p = new URLSearchParams()
  if (opts.q) p.set('q', opts.q)
  if (opts.limit != null) p.set('limit', String(opts.limit))
  if (opts.offset != null) p.set('offset', String(opts.offset))
  const q = p.toString()
  return apiGet(`/api/documents${q ? `?${q}` : ''}`)
}

/**
 * Upload, parse with MinerU, persist in PostgreSQL.
 * @param {File} file
 * @returns {Promise<{ id: string, original_filename: string, char_count: number, deduplicated?: boolean, message?: string }>}
 */
export async function uploadLibraryDocument(file) {
  const fd = new FormData()
  fd.append('file', file)
  const res = await fetch('/api/documents', {
    method: 'POST',
    body: fd,
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(t || res.statusText)
  }
  return res.json()
}

export async function getLibraryDocument(id) {
  return apiGet(`/api/documents/${encodeURIComponent(id)}`)
}

export async function deleteLibraryDocument(id) {
  return apiDelete(`/api/documents/${encodeURIComponent(id)}`)
}

export async function reindexLibraryDocument(id) {
  return apiPost(`/api/documents/${encodeURIComponent(id)}/reindex`, {})
}

/**
 * POST with NDJSON / SSE-style `data: {...}` lines.
 * @param {string} path
 * @param {object} body
 * @param {(evt: object) => void} onEvent
 * @param {AbortSignal} [signal]
 */
export async function streamPostSse(path, body, onEvent, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(t || res.statusText)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      for (const rawLine of block.split('\n')) {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        try {
          onEvent(JSON.parse(payload))
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const payload = tail.slice(5).trim()
    if (payload) {
      try {
        onEvent(JSON.parse(payload))
      } catch {
        /* ignore */
      }
    }
  }
}
