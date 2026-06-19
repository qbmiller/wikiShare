<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ChevronLeft, ChevronRight, RotateCw, ZoomIn, ZoomOut } from 'lucide-vue-next'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { api } from '@/api'
import type { PdfFile } from '@/types'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const route = useRoute()
const fileId = computed(() => String(route.params.id))
const canvas = ref<HTMLCanvasElement | null>(null)
const file = ref<PdfFile | null>(null)
const pdf = ref<pdfjsLib.PDFDocumentProxy | null>(null)
const pageNumber = ref(1)
const pageCount = ref(0)
const scale = ref(1.1)
const rotation = ref(0)
const loading = ref(true)
const error = ref('')

onMounted(async () => {
  try {
    file.value = await api<PdfFile>(`/api/files/${fileId.value}/metadata`)
    pdf.value = await pdfjsLib.getDocument({
      url: `/api/files/${fileId.value}/content`,
      withCredentials: true,
      rangeChunkSize: 65536,
    }).promise
    pageCount.value = pdf.value.numPages
    await renderPage()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'PDF 加载失败'
  } finally {
    loading.value = false
  }
})

async function renderPage() {
  if (!pdf.value || !canvas.value) {
    await nextTick()
  }
  if (!pdf.value || !canvas.value) {
    return
  }

  const page = await pdf.value.getPage(pageNumber.value)
  const viewport = page.getViewport({ scale: scale.value, rotation: rotation.value })
  const context = canvas.value.getContext('2d')
  if (!context) {
    return
  }

  canvas.value.width = viewport.width
  canvas.value.height = viewport.height
  await page.render({ canvas: canvas.value, canvasContext: context, viewport }).promise
}

async function go(delta: number) {
  pageNumber.value = Math.min(Math.max(pageNumber.value + delta, 1), pageCount.value)
  await renderPage()
}

async function zoom(delta: number) {
  scale.value = Math.min(Math.max(scale.value + delta, 0.6), 2.2)
  await renderPage()
}

async function rotate() {
  rotation.value = (rotation.value + 90) % 360
  await renderPage()
}
</script>

<template>
  <section class="reader-view">
    <header class="reader-toolbar">
      <div>
        <p class="eyebrow">在线阅读</p>
        <h1>{{ file?.name ?? 'PDF' }}</h1>
      </div>

      <div class="reader-controls">
        <button class="icon-button" title="上一页" :disabled="pageNumber <= 1" @click="go(-1)">
          <ChevronLeft :size="18" />
        </button>
        <span>{{ pageNumber }} / {{ pageCount || '-' }}</span>
        <button class="icon-button" title="下一页" :disabled="pageNumber >= pageCount" @click="go(1)">
          <ChevronRight :size="18" />
        </button>
        <button class="icon-button" title="缩小" @click="zoom(-0.1)">
          <ZoomOut :size="18" />
        </button>
        <button class="icon-button" title="放大" @click="zoom(0.1)">
          <ZoomIn :size="18" />
        </button>
        <button class="icon-button" title="旋转" @click="rotate">
          <RotateCw :size="18" />
        </button>
      </div>
    </header>

    <p v-if="loading" class="empty-state">正在加载 PDF...</p>
    <p v-if="error" class="form-message">{{ error }}</p>

    <div class="canvas-stage">
      <canvas ref="canvas" />
      <div class="watermark">CFShare · 当前账号 · {{ new Date().toLocaleString('zh-CN') }}</div>
    </div>
  </section>
</template>
