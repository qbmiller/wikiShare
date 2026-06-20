<script setup lang="ts">
import { markRaw, nextTick, onMounted, ref, shallowRef } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Columns2, RotateCw, ScrollText, ZoomIn, ZoomOut } from 'lucide-vue-next'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import type { SharedFile } from '@/types'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const props = defineProps<{
  file: SharedFile
  contentUrl: string
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const scrollCanvases = ref<HTMLCanvasElement[]>([])
const pdf = shallowRef<pdfjsLib.PDFDocumentProxy | null>(null)
const pageNumber = ref(1)
const pageInput = ref('1')
const pageCount = ref(0)
const scale = ref(1.1)
const rotation = ref(0)
const loading = ref(true)
const error = ref('')
const viewMode = ref<'single' | 'scroll'>('scroll')

onMounted(async () => {
  try {
    const loadedPdf = await pdfjsLib.getDocument({
      url: props.contentUrl,
      withCredentials: true,
      rangeChunkSize: 65536,
    }).promise
    pdf.value = markRaw(loadedPdf)
    pageCount.value = pdf.value.numPages
    pageInput.value = String(pageNumber.value)
    await renderCurrentMode()
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

async function renderScrollPages() {
  if (!pdf.value) {
    return
  }
  await nextTick()

  const canvases = scrollCanvases.value.slice(0, pageCount.value)
  await Promise.all(
    canvases.map(async (pageCanvas, index) => {
      const page = await pdf.value?.getPage(index + 1)
      const context = pageCanvas.getContext('2d')
      if (!page || !context) {
        return
      }
      const viewport = page.getViewport({ scale: scale.value, rotation: rotation.value })
      pageCanvas.width = viewport.width
      pageCanvas.height = viewport.height
      await page.render({ canvas: pageCanvas, canvasContext: context, viewport }).promise
    }),
  )
}

async function renderCurrentMode() {
  if (viewMode.value === 'scroll') {
    await renderScrollPages()
    return
  }
  await renderPage()
}

async function go(delta: number) {
  await goToPage(pageNumber.value + delta)
}

async function jumpToPage() {
  const target = Number.parseInt(pageInput.value, 10)
  if (!Number.isFinite(target)) {
    pageInput.value = String(pageNumber.value)
    return
  }
  await goToPage(target)
}

async function goToPage(target: number) {
  pageNumber.value = Math.min(Math.max(target, 1), pageCount.value || 1)
  pageInput.value = String(pageNumber.value)
  if (viewMode.value === 'single') {
    await renderPage()
  } else {
    await scrollToPage(pageNumber.value)
  }
}

async function zoom(delta: number) {
  scale.value = Math.min(Math.max(scale.value + delta, 0.6), 2.2)
  await renderCurrentMode()
}

async function rotate() {
  rotation.value = (rotation.value + 90) % 360
  await renderCurrentMode()
}

async function setViewMode(mode: 'single' | 'scroll') {
  if (viewMode.value === mode) {
    return
  }
  viewMode.value = mode
  await renderCurrentMode()
}

function setScrollCanvas(element: Element | ComponentPublicInstance | null, index: number) {
  if (element instanceof HTMLCanvasElement) {
    scrollCanvases.value[index] = element
  }
}

async function scrollToPage(page: number) {
  await nextTick()
  scrollCanvases.value[page - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <section class="reader-format">
    <div class="reader-controls">
      <button class="icon-button" title="首页" :disabled="pageNumber <= 1" @click="goToPage(1)">
        <ChevronsLeft :size="18" />
      </button>
      <button class="icon-button" title="上一页" :disabled="pageNumber <= 1" @click="go(-1)">
        <ChevronLeft :size="18" />
      </button>
      <span>{{ pageNumber }} / {{ pageCount || '-' }}</span>
      <form class="page-jump" @submit.prevent="jumpToPage">
        <input v-model="pageInput" type="number" min="1" :max="pageCount || 1" aria-label="跳转页数" />
        <button class="text-button" type="submit">跳转</button>
      </form>
      <button class="icon-button" title="下一页" :disabled="pageNumber >= pageCount" @click="go(1)">
        <ChevronRight :size="18" />
      </button>
      <button class="icon-button" title="最后一页" :disabled="pageNumber >= pageCount" @click="goToPage(pageCount || 1)">
        <ChevronsRight :size="18" />
      </button>
      <div class="segmented-control" aria-label="阅读模式">
        <button :class="{ active: viewMode === 'single' }" title="单页模式" @click="setViewMode('single')">
          <Columns2 :size="16" />
          单页
        </button>
        <button :class="{ active: viewMode === 'scroll' }" title="上下滚动模式" @click="setViewMode('scroll')">
          <ScrollText :size="16" />
          滚动
        </button>
      </div>
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

    <p v-if="loading" class="empty-state">正在加载 PDF...</p>
    <p v-if="error" class="form-message">{{ error }}</p>

    <div class="canvas-stage" :class="{ 'scroll-mode': viewMode === 'scroll' }">
      <canvas v-show="viewMode === 'single'" ref="canvas" />
      <div v-show="viewMode === 'scroll'" class="scroll-pages">
        <canvas
          v-for="page in pageCount"
          :key="page"
          :ref="(element) => setScrollCanvas(element, page - 1)"
        />
      </div>
      <div class="watermark">CFShare · 当前账号 · {{ new Date().toLocaleString('zh-CN') }}</div>
    </div>
  </section>
</template>
