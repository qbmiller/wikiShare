<script setup lang="ts">
import { ref } from 'vue'
import VueOfficeExcel from '@vue-office/excel/lib/v3/index.js'
import '@vue-office/excel/lib/v3/index.css'
import type { SharedFile } from '@/types'

const props = defineProps<{
  file: SharedFile
  contentUrl: string
}>()

const loading = ref(true)
const error = ref('')
const requestOptions = {
  credentials: 'include',
}
const options = {
  showContextmenu: false,
}

function renderedHandler() {
  loading.value = false
}

function errorHandler() {
  loading.value = false
  error.value = `${props.file.name} 渲染失败`
}
</script>

<template>
  <section class="reader-format office-reader spreadsheet-reader">
    <p v-if="loading" class="empty-state">正在加载 Excel...</p>
    <p v-if="error" class="form-message">{{ error }}</p>
    <vue-office-excel
      v-if="!error"
      class="office-document"
      :src="contentUrl"
      :request-options="requestOptions"
      :options="options"
      @rendered="renderedHandler"
      @error="errorHandler"
    />
    <div class="watermark">CFShare · 当前账号 · {{ new Date().toLocaleString('zh-CN') }}</div>
  </section>
</template>
