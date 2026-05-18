import { useCallback, useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { apiGet } from './lib/api'
import { chatModelsOnly } from './lib/models'
import { useToastStore } from './store/useToastStore'
import { useChatStore } from './store/useChatStore'
import { ChatPage } from './components/ChatPage'
import { DashboardPage } from './components/DashboardPage'
import { DocumentsPage } from './components/DocumentsPage'
import { AppNavbar } from './components/AppNavbar'
import { ToastHost } from './components/ToastHost'

function AppShell() {
  const toast = useToastStore((s) => s.push)
  const init = useChatStore((s) => s.init)
  const setDefaultModel = useChatStore((s) => s.setDefaultModel)
  const defaultModel = useChatStore((s) => s.defaultModel)
  const [models, setModels] = useState([])
  const [ps, setPs] = useState(null)
  const [modelsLoading, setModelsLoading] = useState(true)

  const refreshModels = useCallback(async () => {
    setModelsLoading(true)
    try {
      const [t, p] = await Promise.all([apiGet('/api/tags'), apiGet('/api/ps')])
      setModels(t.models ?? [])
      setPs(p)
      // Only auto-select a chat-capable model as the default — never a local
      // embedding model like qwen3-embedding / nomic-embed / bge-* etc.
      const firstChat = chatModelsOnly(t.models ?? [])[0]?.model
      if (firstChat && !defaultModel) setDefaultModel(firstChat)
    } catch (e) {
      toast(e.message || 'Cannot reach API. Is the backend running?', 'error')
    } finally {
      setModelsLoading(false)
    }
  }, [defaultModel, setDefaultModel, toast])

  useEffect(() => {
    init()
  }, [init])

  useEffect(() => {
    refreshModels()
  }, [refreshModels])

  const runningNames = useMemo(() => {
    const s = new Set()
    for (const m of ps?.models ?? []) {
      if (m.name) s.add(m.name)
      if (m.model) s.add(m.model)
    }
    return s
  }, [ps])

  return (
    <div className="flex h-dvh flex-col">
      <AppNavbar />
      <div className="flex min-h-0 flex-1 flex-col pt-12">
        <Routes>
          <Route
            path="/"
            element={
              <ChatPage
                models={models}
                runningNames={runningNames}
                modelsLoading={modelsLoading}
                refreshModels={refreshModels}
              />
            }
          />
          <Route path="/models" element={<DashboardPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
        </Routes>
      </div>
      <ToastHost />
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  )
}
