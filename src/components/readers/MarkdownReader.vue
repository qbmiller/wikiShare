<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { SharedFile } from '@/types'

const props = defineProps<{
  file: SharedFile
  contentUrl: string
}>()

const markdownHtml = ref('')
const loading = ref(true)
const error = ref('')

onMounted(async () => {
  try {
    const response = await fetch(props.contentUrl, { credentials: 'include' })
    if (!response.ok) {
      throw new Error(`Markdown 加载失败：${response.status}`)
    }
    markdownHtml.value = renderMarkdown(await response.text())
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Markdown 加载失败'
  } finally {
    loading.value = false
  }
})

function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  let inList = false

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return
    }
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const closeList = () => {
    if (!inList) {
      return
    }
    html.push('</ul>')
    inList = false
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      flushParagraph()
      closeList()
      continue
    }

    const heading = /^(#{1,6})\s+(.+)$/.exec(trimmed)
    if (heading) {
      flushParagraph()
      closeList()
      const level = heading[1].length
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      continue
    }

    const listItem = /^[-*]\s+(.+)$/.exec(trimmed)
    if (listItem) {
      flushParagraph()
      if (!inList) {
        html.push('<ul>')
        inList = true
      }
      html.push(`<li>${renderInline(listItem[1])}</li>`)
      continue
    }

    paragraph.push(trimmed)
  }

  flushParagraph()
  closeList()
  return html.join('')
}

function renderInline(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
</script>

<template>
  <section class="reader-format">
    <p v-if="loading" class="empty-state">正在加载 Markdown...</p>
    <p v-if="error" class="form-message">{{ error }}</p>

    <article class="markdown-stage">
      <div class="markdown-body" v-html="markdownHtml"></div>
      <div class="watermark">CFShare · 当前账号 · {{ new Date().toLocaleString('zh-CN') }}</div>
    </article>
  </section>
</template>
