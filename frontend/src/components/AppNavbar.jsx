import { NavLink } from 'react-router-dom'
import { Sparkles } from 'lucide-react'
import { ThemeToggle } from './ThemeToggle'

const NAV = [
  { to: '/', label: 'Chat', end: true },
  { to: '/documents', label: 'Docs', end: false },
  { to: '/models', label: 'Models', end: false },
]

function navClass({ isActive }) {
  return [
    'rounded-lg px-3 py-1.5 text-sm font-medium transition',
    isActive
      ? 'bg-cyan-500/15 text-cyan-800 ring-1 ring-cyan-500/30 dark:text-cyan-100 dark:ring-cyan-500/40'
      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white',
  ].join(' ')
}

export function AppNavbar() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 flex h-12 shrink-0 items-center justify-between border-b border-slate-200/90 bg-white/90 px-3 backdrop-blur dark:border-slate-800/80 dark:bg-slate-950/90">
      <NavLink
        to="/"
        className="flex min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 text-slate-800 hover:opacity-90 dark:text-slate-100"
        title="Ollama Studio"
      >
        <Sparkles className="h-5 w-5 shrink-0 text-cyan-500" />
        <span className="hidden truncate text-sm font-semibold tracking-tight sm:inline">
          Ollama Studio
        </span>
      </NavLink>

      <nav className="flex items-center gap-1" aria-label="Main">
        {NAV.map(({ to, label, end }) => (
          <NavLink key={to} to={to} end={end} className={navClass}>
            {label}
          </NavLink>
        ))}
        <ThemeToggle className="ml-1" />
      </nav>
    </header>
  )
}
