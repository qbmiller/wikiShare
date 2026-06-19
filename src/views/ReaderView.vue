<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api'
import ImageReader from '@/components/readers/ImageReader.vue'
import MarkdownReader from '@/components/readers/MarkdownReader.vue'
import PdfReader from '@/components/readers/PdfReader.vue'
import PresentationReader from '@/components/readers/PresentationReader.vue'
import UnsupportedReader from '@/components/readers/UnsupportedReader.vue'
import type { SharedFile } from '@/types'

const route = useRoute()
const fileId = computed(() => String(route.params.id))
const file = ref<SharedFile | null>(null)
const loading = ref(true)
const error = ref('')
const fileContentUrl = computed(() => `/api/files/${fileId.value}/content`)
const readerComponent = computed(() => {
  if (!file.value) {
    return UnsupportedReader
  }
  if (file.value.mime_type === 'application/pdf') {
    return PdfReader
  }
  if (file.value.mime_type.startsWith('text/markdown')) {
    return MarkdownReader
  }
  if (file.value.mime_type.startsWith('image/')) {
    return ImageReader
  }
  if (isPresentationFile(file.value)) {
    return PresentationReader
  }
  return UnsupportedReader
})

onMounted(async () => {
  try {
    file.value = await api<SharedFile>(`/api/files/${fileId.value}/metadata`)
  } catch (err) {
    error.value = err instanceof Error ? err.message : '文件信息加载失败'
  } finally {
    loading.value = false
  }
})

function isPresentationFile(file: SharedFile): boolean {
  return file.mime_type === 'application/vnd.ms-powerpoint' || file.mime_type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}
</script>

<template>
  <section class="reader-view">
    <header class="reader-toolbar">
      <div>
        <p class="eyebrow">在线阅读</p>
        <h1>{{ file?.name ?? '文档' }}</h1>
      </div>
    </header>

    <p v-if="loading" class="empty-state">正在加载文件信息...</p>
    <p v-if="error" class="form-message">{{ error }}</p>
    <component :is="readerComponent" v-if="file && !error" :file="file" :content-url="fileContentUrl" />
  </section>
</template>
