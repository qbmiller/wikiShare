import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/api'
import type { User } from '@/types'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const loaded = ref(false)

  async function loadMe() {
    try {
      user.value = await api<User>('/api/auth/me')
    } catch {
      user.value = null
    } finally {
      loaded.value = true
    }
  }

  async function login(username: string, password: string) {
    user.value = await api<User>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    loaded.value = true
  }

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' })
    user.value = null
    loaded.value = true
  }

  return { user, loaded, loadMe, login, logout }
})

