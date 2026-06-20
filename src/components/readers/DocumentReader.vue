<script setup lang="ts">
import { ref, watch } from 'vue'
import VueOfficeDocx from '@vue-office/docx/lib/v3/index.js'
import '@vue-office/docx/lib/v3/index.css'
import type { SharedFile } from '@/types'

const props = defineProps<{
  file: SharedFile
  contentUrl: string
}>()

const loading = ref(true)
const error = ref('')
const renderKey = ref(0)
const requestOptions = {
  credentials: 'include',
}

watch(
  () => [props.file.id, props.contentUrl],
  () => {
    loading.value = true
    error.value = ''
    renderKey.value += 1
  },
  { immediate: true },
)

function renderedHandler() {
  loading.value = false
}

function errorHandler() {
  loading.value = false
  error.value = `${props.file.name} 渲染失败`
}
</script>

<template>
  <section class="reader-format office-reader">
    <p v-if="loading" class="empty-state">正在加载 Word...</p>
    <p v-if="error" class="form-message">{{ error }}</p>
    <vue-office-docx
      v-if="!error"
      :key="renderKey"
      class="office-document"
      :src="contentUrl"
      :request-options="requestOptions"
      @rendered="renderedHandler"
      @error="errorHandler"
    />
    <div class="watermark">CFShare · 当前账号 · {{ new Date().toLocaleString('zh-CN') }}</div>
  </section>
</template>
