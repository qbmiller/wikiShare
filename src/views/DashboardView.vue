<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { FolderPlus, Upload } from 'lucide-vue-next'
import { api } from '@/api'
import type { Folder, PdfFile } from '@/types'

const router = useRouter()
const folders = ref<Folder[]>([])
const files = ref<PdfFile[]>([])
const selectedFolderId = ref<string>('')
const newFolderName = ref('')
const newFolderParentId = ref<string>('')
const uploadFile = ref<File | null>(null)
const loading = ref(false)
const error = ref('')

const selectedFolder = computed(() => folders.value.find((folder) => folder.id === selectedFolderId.value) ?? null)
const parentOptions = computed(() => folders.value.filter((folder) => folder.depth < 3))

onMounted(loadFolders)

async function loadFolders() {
  error.value = ''
  folders.value = await api<Folder[]>('/api/folders/tree')
  if (!selectedFolderId.value && folders.value.length > 0) {
    selectedFolderId.value = folders.value[0].id
    await loadFiles()
  }
}

async function loadFiles() {
  if (!selectedFolderId.value) {
    files.value = []
    return
  }
  files.value = await api<PdfFile[]>(`/api/folders/${selectedFolderId.value}/files`)
}

async function createFolder() {
  if (!newFolderName.value.trim()) {
    return
  }
  loading.value = true
  error.value = ''
  try {
    await api('/api/folders', {
      method: 'POST',
      body: JSON.stringify({
        name: newFolderName.value,
        parentId: newFolderParentId.value || null,
      }),
    })
    newFolderName.value = ''
    await loadFolders()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '创建失败'
  } finally {
    loading.value = false
  }
}

async function upload() {
  if (!selectedFolderId.value || !uploadFile.value) {
    return
  }

  const form = new FormData()
  form.set('folderId', selectedFolderId.value)
  form.set('file', uploadFile.value)
  loading.value = true
  error.value = ''
  try {
    await api('/api/files/upload', {
      method: 'POST',
      body: form,
      headers: {},
    })
    uploadFile.value = null
    await loadFiles()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '上传失败'
  } finally {
    loading.value = false
  }
}

async function trashFile(file: PdfFile) {
  await api(`/api/files/${file.id}/trash`, { method: 'POST' })
  await loadFiles()
}

async function trashFolder(folder: Folder) {
  await api(`/api/folders/${folder.id}/trash`, { method: 'POST' })
  if (selectedFolderId.value === folder.id) {
    selectedFolderId.value = ''
    files.value = []
  }
  await loadFolders()
}

function formatSize(size: number): string {
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function setUpload(event: Event) {
  const input = event.target as HTMLInputElement
  uploadFile.value = input.files?.[0] ?? null
}
</script>

<template>
  <section class="workspace">
    <header class="page-header">
      <div>
        <p class="eyebrow">文件库</p>
        <h1>PDF 在线阅读</h1>
      </div>
    </header>

    <p v-if="error" class="form-message">{{ error }}</p>

    <div class="split-layout">
      <section class="panel folder-panel">
        <div class="panel-title">
          <h2>文件夹</h2>
          <span>最多 3 级</span>
        </div>

        <form class="compact-form" @submit.prevent="createFolder">
          <input v-model="newFolderName" placeholder="新文件夹名称，例如 2026-06-19" />
          <select v-model="newFolderParentId">
            <option value="">根目录</option>
            <option v-for="folder in parentOptions" :key="folder.id" :value="folder.id">
              {{ '　'.repeat(folder.depth - 1) }}{{ folder.name }}
            </option>
          </select>
          <button class="primary-button" type="submit" :disabled="loading">
            <FolderPlus :size="16" />
            新建
          </button>
        </form>

        <div class="folder-list">
          <button
            v-for="folder in folders"
            :key="folder.id"
            class="folder-row"
            :class="{ active: folder.id === selectedFolderId }"
            @click="selectedFolderId = folder.id; loadFiles()"
          >
            <span>{{ '　'.repeat(folder.depth - 1) }}{{ folder.name }}</span>
            <small>{{ folder.depth }} 级</small>
          </button>
        </div>
      </section>

      <section class="panel file-panel">
        <div class="panel-title">
          <h2>{{ selectedFolder?.name ?? '请选择文件夹' }}</h2>
          <button v-if="selectedFolder" class="danger-button" type="button" @click="trashFolder(selectedFolder)">移入回收站</button>
        </div>

        <form class="upload-bar" @submit.prevent="upload">
          <input type="file" accept="application/pdf" @change="setUpload" />
          <button class="primary-button" type="submit" :disabled="!selectedFolderId || !uploadFile || loading">
            <Upload :size="16" />
            上传 PDF
          </button>
        </form>

        <div class="file-table">
          <div class="file-table-head">
            <span>文件名</span>
            <span>大小</span>
            <span>操作</span>
          </div>
          <div v-for="file in files" :key="file.id" class="file-row">
            <span>{{ file.name }}</span>
            <span>{{ formatSize(file.size) }}</span>
            <div class="row-actions">
              <button class="text-button" type="button" @click="router.push(`/reader/file/${file.id}`)">阅读</button>
              <button class="text-button danger-text" type="button" @click="trashFile(file)">回收</button>
            </div>
          </div>
          <p v-if="selectedFolderId && files.length === 0" class="empty-state">当前文件夹还没有 PDF。</p>
        </div>
      </section>
    </div>
  </section>
</template>

