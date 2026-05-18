import { create } from 'zustand'
import { applyTheme, getStoredTheme, THEME_STORAGE_KEY } from '../lib/theme'

export const useThemeStore = create((set, get) => ({
  theme: getStoredTheme(),

  setTheme(theme) {
    applyTheme(theme)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme)
    } catch {
      /* ignore */
    }
    set({ theme })
  },

  toggle() {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    get().setTheme(next)
  },
}))

applyTheme(getStoredTheme())
