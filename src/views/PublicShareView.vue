<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api'
import DocumentReader from '@/components/readers/DocumentReader.vue'
import ImageReader from '@/components/readers/ImageReader.vue'
import MarkdownReader from '@/components/readers/MarkdownReader.vue'
import PdfReader from '@/components/readers/PdfReader.vue'
import PresentationReader from '@/components/readers/PresentationReader.vue'
import SpreadsheetReader from '@/components/readers/SpreadsheetReader.vue'
import UnsupportedReader from '@/components/readers/UnsupportedReader.vue'
import { formatDate } from '@/date'
import type { PublicShareFile, PublicShareFolder, PublicShareMetadata, SharedFile } from '@/types'

const route = useRoute()
const router = useRouter()
const shareKey = computed(() => String(route.params.shareKey))
const routeFileName = computed(() => {
  const value = route.params.fileName
  return typeof value === 'string' && value ? value : ''
})
const routeFileId = computed(() => {
  const value = route.params.fileId
  return typeof value === 'string' && value ? value : ''
})
const share = ref<PublicShareMetadata | null>(null)
const files = ref<SharedFile[]>([])
const selectedFile = ref<SharedFile | null>(null)
const loading = ref(true)
const error = ref('')

const contentUrl = computed(() => {
  if (!selectedFile.value) {
    return ''
  }
  return `/api/public/shares/${shareKey.value}/files/${selectedFile.value.id}/content`
})
const readerComponent = computed(() => {
  if (!selectedFile.value) {
    return UnsupportedReader
  }
  if (selectedFile.value.mime_type === 'application/pdf') {
    return PdfReader
  }
  if (selectedFile.value.mime_type.startsWith('text/markdown')) {
    return MarkdownReader
  }
  if (selectedFile.value.mime_type.startsWith('image/')) {
    return ImageReader
  }
  if (isPresentationFile(selectedFile.value)) {
    return PresentationReader
  }
  if (isDocumentFile(selectedFile.value)) {
    return DocumentReader
  }
  if (isSpreadsheetFile(selectedFile.value)) {
    return SpreadsheetReader
  }
  return UnsupportedReader
})
const fileMeta = computed(() => {
  if (!selectedFile.value) {
    return ''
  }
  return `${formatSize(selectedFile.value.size)} · ${selectedFile.value.mime_type}`
})

onMounted(loadShare)

watch([routeFileId, routeFileName], () => {
  if (loading.value || share.value?.target_type !== 'folder' || files.value.length === 0) {
    return
  }
  selectedFile.value = resolveRouteFile() ?? selectedFile.value
})

async function loadShare() {
  loading.value = true
  error.value = ''
  try {
    const result = await api<PublicShareFile | { share: PublicShareMetadata; folder: unknown }>(`/api/public/shares/${shareKey.value}`)
    share.value = result.share
    if (result.share.target_type === 'file' && 'file' in result) {
      selectedFile.value = result.file
      files.value = [result.file]
      return
    }

    const folderResult = await api<PublicShareFolder>(`/api/public/shares/${shareKey.value}/folder`)
    share.value = folderResult.share
    files.value = folderResult.files
    const routeFile = resolveRouteFile()
    if (routeFile) {
      selectedFile.value = routeFile
    } else if (routeFileName.value) {
      try {
        selectedFile.value = await api<SharedFile>(`/api/public/shares/${shareKey.value}/files/by-name/${encodeURIComponent(routeFileName.value)}`)
      } catch {
        selectedFile.value = folderResult.files[0] ?? null
      }
    } else {
      selectedFile.value = folderResult.files[0] ?? null
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : '分享加载失败'
  } finally {
    loading.value = false
  }
}

async function selectFile(file: SharedFile) {
  selectedFile.value = file
  await router.push(`/share/${share.value?.url_id ?? shareKey.value}/file/${file.id}`)
}

function resolveRouteFile(): SharedFile | null {
  if (routeFileId.value) {
    return files.value.find((file) => file.id === routeFileId.value) ?? null
  }
  if (routeFileName.value) {
    return files.value.find((file) => file.name === decodeRoutePathPart(routeFileName.value)) ?? null
  }
  return files.value[0] ?? null
}

function isPresentationFile(file: SharedFile): boolean {
  return file.mime_type === 'application/vnd.ms-powerpoint' || file.mime_type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

function isDocumentFile(file: SharedFile): boolean {
  return file.mime_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

function isSpreadsheetFile(file: SharedFile): boolean {
  return file.mime_type === 'application/vnd.ms-excel' || file.mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
}

function formatSize(size: number): string {
  if (size < 1024 * 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function decodeRoutePathPart(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
</script>

<template>
  <section class="reader-view public-share-view">
    <header class="reader-toolbar">
      <div>
        <p class="eyebrow">公开分享</p>
        <h1>{{ selectedFile?.name ?? share?.target_name ?? '分享内容' }}</h1>
        <p v-if="share" class="reader-meta">有效期至 {{ formatDate(share.expires_at) }}<template v-if="fileMeta"> · {{ fileMeta }}</template></p>
      </div>
    </header>

    <p v-if="loading" class="empty-state">正在加载分享...</p>
    <p v-if="error" class="form-message">{{ error }}</p>

    <div v-if="!loading && !error && share?.target_type === 'folder'" class="public-folder-layout">
      <aside class="public-folder-sidebar">
        <h2>{{ share.target_name }}</h2>
        <button
          v-for="file in files"
          :key="file.id"
          class="public-file-list-item"
          :class="{ active: selectedFile?.id === file.id }"
          type="button"
          @click="selectFile(file)"
        >
          <strong>{{ file.name }}</strong>
          <span>{{ formatSize(file.size) }} · {{ formatDate(file.expires_at) }}</span>
        </button>
      </aside>

      <main class="public-folder-reader">
        <component :is="readerComponent" v-if="selectedFile" :key="selectedFile.id" :file="selectedFile" :content-url="contentUrl" readonly />
        <p v-else class="empty-state">分享中没有可查看文件。</p>
      </main>
    </div>

    <component :is="readerComponent" v-else-if="selectedFile && !error" :key="selectedFile.id" :file="selectedFile" :content-url="contentUrl" readonly />
    <p v-else-if="!loading && !error" class="empty-state">分享中没有可查看文件。</p>
  </section>
</template>
