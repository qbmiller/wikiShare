<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/api'
import { formatDate } from '@/date'
import type { ShareRecord } from '@/types'

const shares = ref<ShareRecord[]>([])
const loading = ref(true)
const error = ref('')
const copyMessage = ref('')

onMounted(loadShares)

async function loadShares() {
  loading.value = true
  error.value = ''
  try {
    shares.value = await api<ShareRecord[]>('/api/shares')
  } catch (err) {
    error.value = err instanceof Error ? err.message : '分享列表加载失败'
  } finally {
    loading.value = false
  }
}

async function cancelShare(share: ShareRecord) {
  await api(`/api/shares/${share.id}/cancel`, { method: 'POST' })
  await loadShares()
}

async function copyShare(share: ShareRecord) {
  copyMessage.value = ''
  try {
    await navigator.clipboard?.writeText(share.public_url)
    copyMessage.value = '链接已复制'
  } catch {
    copyMessage.value = share.public_url
  }
}
</script>

<template>
  <section class="page-section">
    <header class="page-header">
      <div>
        <p class="eyebrow">分享</p>
        <h1>当前分享</h1>
      </div>
      <span>{{ shares.length }} 个有效分享</span>
    </header>

    <p v-if="error" class="form-message">{{ error }}</p>
    <p v-if="copyMessage" class="success-message">{{ copyMessage }}</p>
    <p v-if="loading" class="empty-state">正在加载分享...</p>

    <div v-else class="file-table">
      <div class="file-table-head shares-table-head">
        <span>对象</span>
        <span>类型</span>
        <span>过期时间</span>
        <span>操作</span>
      </div>
      <div v-for="share in shares" :key="share.id" class="file-row shares-row">
        <span :title="share.target_name">{{ share.target_name ?? share.target_id }}</span>
        <span>{{ share.target_type === 'file' ? '文件' : '文件夹' }}</span>
        <span>{{ formatDate(share.expires_at) }}</span>
        <div class="row-actions">
          <button class="text-button" type="button" @click="copyShare(share)">复制链接</button>
          <a class="text-button" :href="share.public_url" target="_blank" rel="noreferrer">打开</a>
          <button class="text-button danger-text" type="button" @click="cancelShare(share)">取消分享</button>
        </div>
      </div>
      <p v-if="shares.length === 0" class="empty-state">当前没有有效分享。</p>
    </div>
  </section>
</template>
