import { create } from 'zustand'

let _id = 0
const nextId = () => ++_id

export const useToastStore = create((set) => ({
  toasts: [],
  push(message, variant = 'error') {
    const id = nextId()
    set((s) => ({
      toasts: [...s.toasts, { id, message, variant }],
    }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, 5200)
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },
}))
