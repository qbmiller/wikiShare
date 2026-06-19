<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/api'
import type { User } from '@/types'

const users = ref<User[]>([])
const username = ref('')
const password = ref('')
const role = ref<'admin' | 'user'>('user')
const message = ref('')

onMounted(loadUsers)

async function loadUsers() {
  users.value = await api<User[]>('/api/users')
}

async function createUser() {
  message.value = ''
  await api('/api/users', {
    method: 'POST',
    body: JSON.stringify({ username: username.value, password: password.value, role: role.value }),
  })
  username.value = ''
  password.value = ''
  role.value = 'user'
  message.value = '用户已创建。'
  await loadUsers()
}

async function disableUser(user: User) {
  await api(`/api/users/${user.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ role: user.role, expiresAt: user.expires_at, disabled: true }),
  })
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

    <form class="panel user-form" @submit.prevent="createUser">
      <input v-model="username" placeholder="账号" required />
      <input v-model="password" type="password" placeholder="初始密码，至少 8 位" required minlength="8" />
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
        <span>状态</span>
        <span>操作</span>
      </div>
      <div v-for="user in users" :key="user.id" class="file-row user-row">
        <span>{{ user.username }}</span>
        <span>{{ user.role === 'admin' ? '管理员' : '用户' }}</span>
        <span>{{ user.disabled_at ? '已禁用' : '可用' }}</span>
        <button class="text-button danger-text" type="button" :disabled="!!user.disabled_at" @click="disableUser(user)">禁用</button>
      </div>
    </div>
  </section>
</template>

