<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { BookOpen, FileText, Folder } from 'lucide-vue-next'
import { api } from '@/api'
import { formatDate } from '@/date'
import type { Folder as FolderItem, PaginatedFiles, SharedFile } from '@/types'

type FolderTreeNode = FolderItem & {
  children: FolderTreeNode[]
}

const router = useRouter()
const folders = ref<FolderItem[]>([])
const files = ref<SharedFile[]>([])
const totalFiles = ref(0)
const filePage = ref(1)
const filePageSize = 30
const fileQuery = ref('')
const selectedFolderId = ref('')
const loadingFiles = ref(false)
const error = ref('')
let fileQueryTimer: number | null = null

const selectedFolder = computed(() => folders.value.find((folder) => folder.id === selectedFolderId.value) ?? null)
const folderTree = computed(() => {
  const nodeById = new Map<string, FolderTreeNode>()
  const roots: FolderTreeNode[] = []

  for (const folder of folders.value) {
    nodeById.set(folder.id, { ...folder, children: [] })
  }

  for (const folder of folders.value) {
    const node = nodeById.get(folder.id)
    if (!node) {
      continue
    }

    const parent = folder.parent_id ? nodeById.get(folder.parent_id) : null
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  return roots
})

onMounted(loadFolders)

watch(fileQuery, () => {
  if (fileQueryTimer) {
    window.clearTimeout(fileQueryTimer)
  }
  fileQueryTimer = window.setTimeout(() => {
    filePage.value = 1
    void loadFiles()
  }, 300)
})

async function loadFolders() {
  error.value = ''
  try {
    folders.value = await api<FolderItem[]>('/api/folders/tree')
    if (folders.value.length > 0) {
      await selectFolder(folders.value[0])
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载文件夹失败'
  }
}

async function loadFiles() {
  if (!selectedFolderId.value) {
    files.value = []
    totalFiles.value = 0
    return
  }

  loadingFiles.value = true
  error.value = ''
  try {
    const params = new URLSearchParams({
      page: String(filePage.value),
      pageSize: String(filePageSize),
    })
    const query = fileQuery.value.trim()
    if (query) {
      params.set('q', query)
    }
    const result = await api<PaginatedFiles>(`/api/folders/${selectedFolderId.value}/files?${params.toString()}`)
    files.value = result.items
    totalFiles.value = result.total
    filePage.value = result.page
  } catch (err) {
    files.value = []
    totalFiles.value = 0
    error.value = err instanceof Error ? err.message : '加载文件失败'
  } finally {
    loadingFiles.value = false
  }
}

async function selectFolder(folder: FolderItem) {
  selectedFolderId.value = folder.id
  filePage.value = 1
  await loadFiles()
}

async function changeFilePage(delta: number) {
  const nextPage = filePage.value + delta
  const lastPage = Math.max(Math.ceil(totalFiles.value / filePageSize), 1)
  if (nextPage < 1 || nextPage > lastPage) {
    return
  }
  filePage.value = nextPage
  await loadFiles()
}

function formatSize(size: number): string {
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
</script>

<template>
  <section class="workspace browse-workspace">
    <header class="page-header browse-header">
      <div>
        <p class="eyebrow">资料浏览</p>
        <h1>文档在线阅读</h1>
      </div>
      <div class="browse-summary">
        <strong>{{ folders.length }}</strong>
        <span>个文件夹</span>
      </div>
    </header>

    <p v-if="error" class="form-message">{{ error }}</p>

    <div class="browse-layout">
      <section class="panel browse-tree-panel">
        <div class="panel-title">
          <h2>目录</h2>
          <span>选择层级查看文件</span>
        </div>

        <div v-if="folderTree.length" class="folder-list">
          <ul class="tree-list">
            <li v-for="folder in folderTree" :key="folder.id" class="tree-item">
              <button
                class="folder-row browse-folder-row"
                :class="{ active: folder.id === selectedFolderId }"
                @click="selectFolder(folder)"
              >
                <span class="folder-name">
                  <Folder :size="16" />
                  {{ folder.name }}
                </span>
                <small>{{ formatDate(folder.expires_at) }}</small>
                <span class="folder-count">{{ folder.file_count ?? 0 }}</span>
              </button>

              <ul v-if="folder.children.length" class="tree-list tree-children">
                <li v-for="child in folder.children" :key="child.id" class="tree-item">
                  <button
                    class="folder-row browse-folder-row"
                    :class="{ active: child.id === selectedFolderId }"
                    @click="selectFolder(child)"
                  >
                    <span class="folder-name">
                      <Folder :size="16" />
                      {{ child.name }}
                    </span>
                    <small>{{ formatDate(child.expires_at) }}</small>
                    <span class="folder-count">{{ child.file_count ?? 0 }}</span>
                  </button>

                  <ul v-if="child.children.length" class="tree-list tree-children">
                    <li v-for="grandchild in child.children" :key="grandchild.id" class="tree-item">
                      <button
                        class="folder-row browse-folder-row"
                        :class="{ active: grandchild.id === selectedFolderId }"
                        @click="selectFolder(grandchild)"
                      >
                        <span class="folder-name">
                          <Folder :size="16" />
                          {{ grandchild.name }}
                        </span>
                        <small>{{ formatDate(grandchild.expires_at) }}</small>
                        <span class="folder-count">{{ grandchild.file_count ?? 0 }}</span>
                      </button>
                    </li>
                  </ul>
                </li>
              </ul>
            </li>
          </ul>
        </div>

        <p v-else class="empty-state">暂无可阅读目录。</p>
      </section>

      <section class="panel browse-files-panel">
        <div class="browse-folder-heading">
          <div>
            <p class="eyebrow">当前目录</p>
            <h2>{{ selectedFolder?.name ?? '请选择目录' }}</h2>
            <span>{{ selectedFolder ? `有效期：${formatDate(selectedFolder.expires_at)}` : '左侧选择目录后查看文档' }}</span>
          </div>
          <BookOpen :size="28" />
        </div>

        <div class="file-toolbar">
          <input v-model="fileQuery" type="search" placeholder="按文件名查询" aria-label="按文件名查询" />
          <span>{{ totalFiles }} 个文件</span>
        </div>

        <div class="browse-file-grid">
          <button
            v-for="file in files"
            :key="file.id"
            class="browse-file-card"
            type="button"
            @click="router.push(`/reader/file/${file.id}`)"
          >
            <span class="file-card-icon">
              <FileText :size="22" />
            </span>
            <span class="file-card-main">
              <strong>{{ file.name }}</strong>
              <small>{{ formatSize(file.size) }} · {{ formatDate(file.expires_at) }}</small>
            </span>
            <span class="file-card-action">阅读</span>
          </button>
        </div>

        <div class="table-pagination">
          <button class="text-button" type="button" :disabled="filePage <= 1" @click="changeFilePage(-1)">上一页</button>
          <span>第 {{ filePage }} 页 · {{ (filePage - 1) * filePageSize + files.length }} / {{ totalFiles }}</span>
          <button
            class="text-button"
            type="button"
            :disabled="(filePage - 1) * filePageSize + files.length >= totalFiles"
            @click="changeFilePage(1)"
          >
            下一页
          </button>
        </div>

        <p v-if="loadingFiles" class="empty-state">正在加载文件...</p>
        <p v-else-if="selectedFolderId && files.length === 0" class="empty-state">{{ fileQuery.trim() ? '没有找到匹配的文件。' : '当前目录还没有可阅读文档。' }}</p>
      </section>
    </div>
  </section>
</template>
