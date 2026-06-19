<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { Folder, FolderPlus, Upload } from 'lucide-vue-next'
import { api } from '@/api'
import { dateInputToEpoch, epochToDateInput, formatDate } from '@/date'
import type { Folder as FolderItem, SharedFile } from '@/types'

const router = useRouter()
const folders = ref<FolderItem[]>([])
const files = ref<SharedFile[]>([])
const selectedFolderId = ref<string>('')
const newFolderName = ref('')
const newFolderParentId = ref<string>('')
const newFolderExpiresAt = ref('')
const selectedFolderExpiresAt = ref('')
const uploadFile = ref<File | null>(null)
const isUploadDragging = ref(false)
const newMarkdownName = ref('')
const loading = ref(false)
const error = ref('')
const draggedFolderId = ref<string | null>(null)
const dropTarget = ref<{ folderId: string; position: DropPosition } | null>(null)
const dragOverRoot = ref(false)
const maxUploadBytes = 100 * 1024 * 1024
const acceptedFileTypes = [
  'application/pdf',
  'text/markdown',
  'text/x-markdown',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.pdf',
  '.md',
  '.markdown',
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.ppt',
  '.pptx',
].join(',')

type FolderTreeNode = FolderItem & {
  children: FolderTreeNode[]
}

type DropPosition = 'before' | 'inside' | 'after'

const selectedFolder = computed(() => folders.value.find((folder) => folder.id === selectedFolderId.value) ?? null)
const parentOptions = computed(() => folders.value.filter((folder) => folder.depth < 3))
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

const folderById = computed(() => new Map(folders.value.map((folder) => [folder.id, folder])))

onMounted(loadFolders)

async function loadFolders() {
  error.value = ''
  folders.value = await api<FolderItem[]>('/api/folders/tree')
  if (!selectedFolderId.value && folders.value.length > 0) {
    selectedFolderId.value = folders.value[0].id
    selectedFolderExpiresAt.value = epochToDateInput(folders.value[0].expires_at)
    await loadFiles()
  }
}

async function loadFiles() {
  if (!selectedFolderId.value) {
    files.value = []
    return
  }
  files.value = await api<SharedFile[]>(`/api/folders/${selectedFolderId.value}/files`)
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
        expiresAt: dateInputToEpoch(newFolderExpiresAt.value),
      }),
    })
    newFolderName.value = ''
    newFolderExpiresAt.value = ''
    await loadFolders()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '创建失败'
  } finally {
    loading.value = false
  }
}

async function updateSelectedFolderExpiration() {
  if (!selectedFolder.value) {
    return
  }
  await api(`/api/folders/${selectedFolder.value.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: selectedFolder.value.name,
      expiresAt: dateInputToEpoch(selectedFolderExpiresAt.value),
    }),
  })
  await loadFolders()
}

async function moveFolder(folderId: string, parentId: string | null) {
  loading.value = true
  error.value = ''
  try {
    await api(`/api/folders/${folderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ parentId }),
    })
    await loadFolders()
  } catch (err) {
    error.value = err instanceof Error ? err.message : '移动失败'
  } finally {
    loading.value = false
    clearFolderDrag()
  }
}

async function updateFileExpiration(file: SharedFile, event: Event) {
  const input = event.target as HTMLInputElement
  await api(`/api/files/${file.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: file.name,
      expiresAt: dateInputToEpoch(input.value),
    }),
  })
  await loadFiles()
}

async function upload() {
  if (!selectedFolderId.value || !uploadFile.value) {
    return
  }
  if (uploadFile.value.size > maxUploadBytes) {
    error.value = `单个文件不能超过 ${formatSize(maxUploadBytes)}。`
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

async function createMarkdownFile() {
  if (!selectedFolderId.value || !newMarkdownName.value.trim()) {
    return
  }
  loading.value = true
  error.value = ''
  try {
    const created = await api<{ id: string }>('/api/files/markdown', {
      method: 'POST',
      body: JSON.stringify({
        folderId: selectedFolderId.value,
        name: newMarkdownName.value,
        content: `# ${newMarkdownName.value.replace(/\.(md|markdown)$/i, '')}\n\n`,
      }),
    })
    newMarkdownName.value = ''
    await loadFiles()
    router.push(`/reader/file/${created.id}?edit=1`)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '新建 Markdown 失败'
  } finally {
    loading.value = false
  }
}

async function trashFile(file: SharedFile) {
  await api(`/api/files/${file.id}/trash`, { method: 'POST' })
  await loadFiles()
}

async function trashFolder(folder: FolderItem) {
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
  setUploadFile(input.files?.[0] ?? null)
}

function setUploadFile(file: File | null) {
  uploadFile.value = file
  if (uploadFile.value && uploadFile.value.size > maxUploadBytes) {
    error.value = `单个文件不能超过 ${formatSize(maxUploadBytes)}。`
  }
}

function dragOverUpload(event: DragEvent) {
  event.preventDefault()
  isUploadDragging.value = true
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = selectedFolderId.value ? 'copy' : 'none'
  }
}

async function dropUpload(event: DragEvent) {
  event.preventDefault()
  isUploadDragging.value = false
  const file = event.dataTransfer?.files?.[0] ?? null
  if (!file) {
    return
  }
  if (!selectedFolderId.value) {
    error.value = '请先选择目标文件夹。'
    return
  }
  setUploadFile(file)
  await upload()
}

function formatFileKind(file: SharedFile): string {
  if (file.mime_type.startsWith('text/markdown')) {
    return 'Markdown'
  }
  if (file.mime_type === 'application/pdf') {
    return 'PDF'
  }
  if (file.mime_type.startsWith('image/')) {
    return '图片'
  }
  if (isPresentationFile(file)) {
    return 'PPT'
  }
  return '文件'
}

function isPresentationFile(file: SharedFile): boolean {
  return file.mime_type === 'application/vnd.ms-powerpoint' || file.mime_type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

function openDatePicker(event: MouseEvent) {
  const input = event.currentTarget as HTMLInputElement
  input.showPicker?.()
}

async function selectFolder(folder: FolderItem) {
  selectedFolderId.value = folder.id
  selectedFolderExpiresAt.value = epochToDateInput(folder.expires_at)
  await loadFiles()
}

function startFolderDrag(folder: FolderItem, event: DragEvent) {
  draggedFolderId.value = folder.id
  event.dataTransfer?.setData('text/plain', folder.id)
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
  }
}

function clearFolderDrag() {
  draggedFolderId.value = null
  dropTarget.value = null
  dragOverRoot.value = false
}

function canDropFolder(targetParentId: string | null, targetFolderId: string | null = null): boolean {
  const movingId = draggedFolderId.value
  if (!movingId) {
    return false
  }
  if (movingId === targetParentId || movingId === targetFolderId) {
    return false
  }

  const moving = folderById.value.get(movingId)
  if (!moving || moving.parent_id === targetParentId) {
    return false
  }

  let current = targetParentId ? folderById.value.get(targetParentId) : null
  while (current) {
    if (current.id === movingId) {
      return false
    }
    current = current.parent_id ? folderById.value.get(current.parent_id) ?? null : null
  }

  return targetDepth(targetParentId) + maxDescendantDepthOffset(movingId) <= 3
}

function maxDescendantDepthOffset(folderId: string): number {
  const base = folderById.value.get(folderId)
  if (!base) {
    return 0
  }

  let maxDepth = base.depth
  const stack = [folderId]
  while (stack.length > 0) {
    const parentId = stack.pop()
    for (const folder of folders.value) {
      if (folder.parent_id === parentId) {
        maxDepth = Math.max(maxDepth, folder.depth)
        stack.push(folder.id)
      }
    }
  }
  return maxDepth - base.depth
}

function targetDepth(parentId: string | null): number {
  if (!parentId) {
    return 1
  }
  const parent = folderById.value.get(parentId)
  return parent ? parent.depth + 1 : 4
}

function dragOverFolder(folder: FolderItem, event: DragEvent) {
  const position = getDropPosition(event)
  const parentId = position === 'inside' ? folder.id : folder.parent_id
  if (!canDropFolder(parentId, folder.id)) {
    dropTarget.value = null
    return
  }
  event.preventDefault()
  dropTarget.value = { folderId: folder.id, position }
  dragOverRoot.value = false
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
}

async function dropOnFolder(folder: FolderItem) {
  const position = dropTarget.value?.folderId === folder.id ? dropTarget.value.position : 'inside'
  const parentId = position === 'inside' ? folder.id : folder.parent_id
  if (!draggedFolderId.value || !canDropFolder(parentId, folder.id)) {
    clearFolderDrag()
    return
  }
  await moveFolder(draggedFolderId.value, parentId)
}

function getDropPosition(event: DragEvent): DropPosition {
  const row = event.currentTarget as HTMLElement
  const rect = row.getBoundingClientRect()
  const offsetY = event.clientY - rect.top
  if (offsetY < rect.height * 0.28) {
    return 'before'
  }
  if (offsetY > rect.height * 0.72) {
    return 'after'
  }
  return 'inside'
}

function isDropTarget(folder: FolderItem, position: DropPosition): boolean {
  return dropTarget.value?.folderId === folder.id && dropTarget.value.position === position
}

function dragOverRootDropZone(event: DragEvent) {
  if (!canDropFolder(null)) {
    dragOverRoot.value = false
    return
  }
  event.preventDefault()
  dropTarget.value = null
  dragOverRoot.value = true
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
}

async function dropOnRoot() {
  if (!draggedFolderId.value || !canDropFolder(null)) {
    clearFolderDrag()
    return
  }
  await moveFolder(draggedFolderId.value, null)
}
</script>

<template>
  <section class="workspace">
    <header class="page-header">
      <div>
        <p class="eyebrow">文件库</p>
        <h1>文档在线阅读</h1>
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
          <input
            v-model="newFolderExpiresAt"
            type="date"
            placeholder="文件夹有效期"
            title="文件夹有效期"
            @click="openDatePicker"
          />
          <button class="primary-button" type="submit" :disabled="loading">
            <FolderPlus :size="16" />
            新建
          </button>
        </form>

        <div
          class="folder-list"
          :class="{ 'drop-root-active': dragOverRoot }"
          @dragover.self="dragOverRootDropZone"
          @dragleave.self="dragOverRoot = false"
          @drop.self="dropOnRoot"
        >
          <ul class="tree-list">
            <li v-for="folder in folderTree" :key="folder.id" class="tree-item">
              <button
                class="folder-row"
                :class="{ active: folder.id === selectedFolderId, dragging: folder.id === draggedFolderId, 'drop-target': isDropTarget(folder, 'inside'), 'drop-before': isDropTarget(folder, 'before'), 'drop-after': isDropTarget(folder, 'after') }"
                draggable="true"
                @dragstart="startFolderDrag(folder, $event)"
                @dragover="dragOverFolder(folder, $event)"
                @dragleave="dropTarget = null"
                @dragend="clearFolderDrag"
                @drop.stop="dropOnFolder(folder)"
                @click="selectFolder(folder)"
              >
                <span class="folder-name">
                  <Folder :size="16" />
                  {{ folder.name }}
                </span>
                <small>{{ formatDate(folder.expires_at) }}</small>
              </button>

              <ul v-if="folder.children.length" class="tree-list tree-children">
                <li v-for="child in folder.children" :key="child.id" class="tree-item">
                  <button
                    class="folder-row"
                    :class="{ active: child.id === selectedFolderId, dragging: child.id === draggedFolderId, 'drop-target': isDropTarget(child, 'inside'), 'drop-before': isDropTarget(child, 'before'), 'drop-after': isDropTarget(child, 'after') }"
                    draggable="true"
                    @dragstart="startFolderDrag(child, $event)"
                    @dragover="dragOverFolder(child, $event)"
                    @dragleave="dropTarget = null"
                    @dragend="clearFolderDrag"
                    @drop.stop="dropOnFolder(child)"
                    @click="selectFolder(child)"
                  >
                    <span class="folder-name">
                      <Folder :size="16" />
                      {{ child.name }}
                    </span>
                    <small>{{ formatDate(child.expires_at) }}</small>
                  </button>

                  <ul v-if="child.children.length" class="tree-list tree-children">
                    <li v-for="grandchild in child.children" :key="grandchild.id" class="tree-item">
                      <button
                        class="folder-row"
                        :class="{ active: grandchild.id === selectedFolderId, dragging: grandchild.id === draggedFolderId, 'drop-target': isDropTarget(grandchild, 'inside'), 'drop-before': isDropTarget(grandchild, 'before'), 'drop-after': isDropTarget(grandchild, 'after') }"
                        draggable="true"
                        @dragstart="startFolderDrag(grandchild, $event)"
                        @dragover="dragOverFolder(grandchild, $event)"
                        @dragleave="dropTarget = null"
                        @dragend="clearFolderDrag"
                        @drop.stop="dropOnFolder(grandchild)"
                        @click="selectFolder(grandchild)"
                      >
                        <span class="folder-name">
                          <Folder :size="16" />
                          {{ grandchild.name }}
                        </span>
                        <small>{{ formatDate(grandchild.expires_at) }}</small>
                      </button>
                    </li>
                  </ul>
                </li>
              </ul>
            </li>
          </ul>
        </div>
      </section>

      <section class="panel file-panel">
        <div class="panel-title">
          <div>
            <h2>{{ selectedFolder?.name ?? '请选择文件夹' }}</h2>
            <span>{{ selectedFolder ? `有效期：${formatDate(selectedFolder.expires_at)}` : '选择文件夹后上传文档' }}</span>
          </div>
          <button v-if="selectedFolder" class="danger-button" type="button" @click="trashFolder(selectedFolder)">移入回收站</button>
        </div>

        <form v-if="selectedFolder" class="inline-form" @submit.prevent="updateSelectedFolderExpiration">
          <input
            v-model="selectedFolderExpiresAt"
            type="date"
            placeholder="文件夹有效期"
            title="文件夹有效期"
            @click="openDatePicker"
          />
          <button class="primary-button" type="submit">保存有效期</button>
        </form>

        <form v-if="selectedFolder" class="markdown-create-form" @submit.prevent="createMarkdownFile">
          <input v-model="newMarkdownName" placeholder="新建 Markdown，例如 会议纪要.md" />
          <button class="primary-button" type="submit" :disabled="loading || !newMarkdownName.trim()">新建 MD</button>
        </form>

        <form
          class="upload-bar"
          :class="{ 'upload-bar-dragging': isUploadDragging }"
          @submit.prevent="upload"
          @dragover="dragOverUpload"
          @dragleave="isUploadDragging = false"
          @drop="dropUpload"
        >
          <input type="file" :accept="acceptedFileTypes" @change="setUpload" />
          <button class="primary-button" type="submit" :disabled="!selectedFolderId || !uploadFile || loading">
            <Upload :size="16" />
            上传文档
          </button>
          <span class="upload-hint">支持 PDF、Markdown、图片、PPT，单个最大 {{ formatSize(maxUploadBytes) }}</span>
        </form>

        <div class="file-table">
          <div class="file-table-head">
            <span>文件名</span>
            <span>大小</span>
            <span>有效期</span>
            <span>操作</span>
          </div>
          <div v-for="file in files" :key="file.id" class="file-row">
            <span>{{ file.name }}</span>
            <span>{{ formatFileKind(file) }} · {{ formatSize(file.size) }}</span>
            <input
              class="table-input"
              type="date"
              :value="epochToDateInput(file.expires_at)"
              placeholder="文件夹有效期"
              title="文件夹有效期"
              @click="openDatePicker"
              @change="updateFileExpiration(file, $event)"
            />
            <div class="row-actions">
              <button class="text-button" type="button" @click="router.push(`/reader/file/${file.id}`)">阅读</button>
              <button class="text-button danger-text" type="button" @click="trashFile(file)">回收</button>
            </div>
          </div>
          <p v-if="selectedFolderId && files.length === 0" class="empty-state">当前文件夹还没有可阅读文档。</p>
        </div>
      </section>
    </div>
  </section>
</template>
