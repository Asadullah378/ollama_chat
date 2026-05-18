export const THEME_STORAGE_KEY = 'ollama-chat-theme'

/** @returns {'light' | 'dark'} */
export function getStoredTheme() {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* ignore */
  }
  return 'light'
}

/** @param {'light' | 'dark'} theme */
export function applyTheme(theme) {
  const root = document.documentElement
  const isDark = theme === 'dark'
  root.classList.toggle('dark', isDark)
  root.style.colorScheme = isDark ? 'dark' : 'light'
}
