<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/api'
import type { Folder, PdfFile } from '@/types'

const folders = ref<Folder[]>([])
const files = ref<PdfFile[]>([])
const message = ref('')

onMounted(loadTrash)

async function loadTrash() {
  const data = await api<{ folders: Folder[]; files: PdfFile[] }>('/api/trash')
  folders.value = data.folders
  files.value = data.files
}

async function restoreFile(id: string) {
  await api(`/api/files/${id}/restore`, { method: 'POST' })
  await loadTrash()
}

async function restoreFolder(id: string) {
  await api(`/api/folders/${id}/restore`, { method: 'POST' })
  await loadTrash()
}

async function cleanup() {
  const result = await api<{ deleted: number; freedBytes: number }>('/api/trash/cleanup', { method: 'POST' })
  message.value = `已清理 ${result.deleted} 个文件，释放 ${result.freedBytes} 字节。`
  await loadTrash()
}
</script>

<template>
  <section class="workspace">
    <header class="page-header">
      <div>
        <p class="eyebrow">回收站</p>
        <h1>过期和回收内容</h1>
      </div>
      <button class="primary-button" type="button" @click="cleanup">按策略清理</button>
    </header>

    <p v-if="message" class="form-message">{{ message }}</p>

    <div class="panel">
      <div class="panel-title">
        <h2>文件夹</h2>
        <span>{{ folders.length }} 个</span>
      </div>
      <div v-for="folder in folders" :key="folder.id" class="trash-row">
        <span class="trash-item-main">
          <strong>{{ folder.name }}</strong>
          <small>{{ folder.path || folder.name }}</small>
        </span>
        <span>{{ folder.depth }} 级</span>
        <button class="text-button" type="button" @click="restoreFolder(folder.id)">恢复</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">
        <h2>文件</h2>
        <span>{{ files.length }} 个</span>
      </div>
      <div v-for="file in files" :key="file.id" class="trash-row">
        <span class="trash-item-main">
          <strong>{{ file.name }}</strong>
          <small>{{ file.path || file.name }}</small>
        </span>
        <span>{{ file.size }} 字节</span>
        <button class="text-button" type="button" @click="restoreFile(file.id)">恢复</button>
      </div>
    </div>
  </section>
</template>
