<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api } from '@/api'
import { dateInputToEpoch, epochToDateInput, formatDateTime } from '@/date'
import type { PaginatedUsers, User } from '@/types'

const users = ref<User[]>([])
const totalUsers = ref(0)
const page = ref(1)
const pageSize = 20
const username = ref('')
const password = ref('')
const role = ref<'admin' | 'user'>('user')
const expiresAt = ref('')
const message = ref('')
const userQuery = ref('')
let userQueryTimer: number | null = null

onMounted(loadUsers)

watch(userQuery, () => {
  if (userQueryTimer) {
    window.clearTimeout(userQueryTimer)
  }
  userQueryTimer = window.setTimeout(() => {
    page.value = 1
    void loadUsers()
  }, 300)
})

async function loadUsers() {
  const params = new URLSearchParams({
    page: String(page.value),
    pageSize: String(pageSize),
  })
  const query = userQuery.value.trim()
  if (query) {
    params.set('q', query)
  }
  const result = await api<PaginatedUsers>(`/api/users?${params.toString()}`)
  users.value = result.items
  totalUsers.value = result.total
  page.value = result.page
}

async function createUser() {
  message.value = ''
  await api('/api/users', {
    method: 'POST',
    body: JSON.stringify({ username: username.value, password: password.value, role: role.value, expiresAt: dateInputToEpoch(expiresAt.value) }),
  })
  username.value = ''
  password.value = ''
  role.value = 'user'
  expiresAt.value = ''
  message.value = '用户已创建。'
  page.value = 1
  await loadUsers()
}

async function saveUser(user: User, event: Event) {
  const form = event.currentTarget as HTMLFormElement
  const formData = new FormData(form)
  await api(`/api/users/${user.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      role: formData.get('role'),
      expiresAt: dateInputToEpoch(String(formData.get('expiresAt') ?? '')),
      disabled: !!user.disabled_at,
    }),
  })
  message.value = '用户已更新。'
  await loadUsers()
}

async function setDisabled(user: User, disabled: boolean) {
  await api(`/api/users/${user.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ role: user.role, expiresAt: user.expires_at, disabled }),
  })
  message.value = disabled ? '用户已禁用。' : '用户已启用。'
  await loadUsers()
}

async function resetPassword(user: User) {
  const value = window.prompt(`为 ${user.username} 设置新密码，至少 8 位`)
  if (!value) {
    return
  }
  await api(`/api/users/${user.id}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ password: value }),
  })
  message.value = '密码已重置。'
}

function openDatePicker(event: MouseEvent) {
  const input = event.currentTarget as HTMLInputElement
  input.showPicker?.()
}

async function changePage(delta: number) {
  const nextPage = page.value + delta
  const lastPage = Math.max(Math.ceil(totalUsers.value / pageSize), 1)
  if (nextPage < 1 || nextPage > lastPage) {
    return
  }
  page.value = nextPage
  await loadUsers()
}
</script>

<template>
  <section class="workspace">
    <header class="page-header">
      <div>
        <p class="eyebrow">用户管理</p>
        <h1>账号和有效期</h1>
      </div>
    </header>

    <p v-if="message" class="form-message">{{ message }}</p>

    <div class="panel user-toolbar">
      <input v-model="userQuery" type="search" placeholder="查询用户账号" aria-label="查询用户账号" />
      <span>共 {{ totalUsers }} 个用户</span>
    </div>

    <form class="panel user-form" @submit.prevent="createUser">
      <input v-model="username" placeholder="账号" required />
      <input v-model="password" type="password" placeholder="初始密码，至少 8 位" required minlength="8" />
      <input
        v-model="expiresAt"
        type="date"
        placeholder="账号有效期"
        title="账号有效期"
        @click="openDatePicker"
      />
      <select v-model="role">
        <option value="user">用户</option>
        <option value="admin">管理员</option>
      </select>
      <button class="primary-button" type="submit">创建用户</button>
    </form>

    <div class="panel">
      <div class="file-table-head">
        <span>账号</span>
        <span>角色</span>
        <span>有效期</span>
        <span>状态</span>
        <span>最近登录</span>
        <span>操作</span>
      </div>
      <form v-for="user in users" :key="user.id" class="file-row user-row" @submit.prevent="saveUser(user, $event)">
        <span>{{ user.username }}</span>
        <select name="role" :value="user.role">
          <option value="user">用户</option>
          <option value="admin">管理员</option>
        </select>
        <input
          name="expiresAt"
          type="date"
          :value="epochToDateInput(user.expires_at)"
          placeholder="账号有效期"
          title="账号有效期"
          @click="openDatePicker"
        />
        <span>{{ user.disabled_at ? '已禁用' : '可用' }}</span>
        <span>{{ formatDateTime(user.last_login_at) }}</span>
        <div class="row-actions">
          <button class="text-button" type="submit">保存</button>
          <button class="text-button" type="button" @click="resetPassword(user)">重置密码</button>
          <button v-if="user.disabled_at" class="text-button" type="button" @click="setDisabled(user, false)">启用</button>
          <button v-else class="text-button danger-text" type="button" @click="setDisabled(user, true)">禁用</button>
        </div>
      </form>
      <div class="table-pagination">
        <button class="text-button" type="button" :disabled="page <= 1" @click="changePage(-1)">上一页</button>
        <span>第 {{ page }} 页 · {{ (page - 1) * pageSize + users.length }} / {{ totalUsers }}</span>
        <button
          class="text-button"
          type="button"
          :disabled="(page - 1) * pageSize + users.length >= totalUsers"
          @click="changePage(1)"
        >
          下一页
        </button>
      </div>
      <p v-if="users.length === 0" class="empty-state">没有找到匹配的用户。</p>
    </div>
  </section>
</template>
