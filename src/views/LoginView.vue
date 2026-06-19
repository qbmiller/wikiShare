<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()
const mode = ref<'login' | 'setup'>('login')
const username = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

const title = computed(() => (mode.value === 'login' ? '登录阅读系统' : '初始化管理员账号'))

async function submit() {
  error.value = ''
  loading.value = true
  try {
    if (mode.value === 'setup') {
      await fetch('/api/setup/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username: username.value, password: password.value }),
      }).then(async (response) => {
        if (!response.ok) {
          const data = await response.json().catch(() => null)
          throw new Error(data?.error?.message ?? '初始化失败')
        }
      })
      mode.value = 'login'
      error.value = '管理员已创建，请登录。'
      return
    }
    await auth.login(username.value, password.value)
    await router.push('/')
  } catch (err) {
    error.value = err instanceof Error ? err.message : '操作失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <section class="login-page">
    <form class="login-panel" @submit.prevent="submit">
      <div>
        <p class="eyebrow">Cloudflare R2 + D1</p>
        <h1>{{ title }}</h1>
      </div>

      <label>
        账号
        <input v-model="username" autocomplete="username" required />
      </label>

      <label>
        密码
        <input v-model="password" autocomplete="current-password" type="password" required minlength="8" />
      </label>

      <p v-if="error" class="form-message">{{ error }}</p>

      <button class="primary-button" type="submit" :disabled="loading">
        {{ loading ? '处理中...' : mode === 'login' ? '登录' : '创建管理员' }}
      </button>

      <button class="text-button" type="button" @click="mode = mode === 'login' ? 'setup' : 'login'">
        {{ mode === 'login' ? '首次部署，初始化管理员' : '返回登录' }}
      </button>
    </form>
  </section>
</template>

