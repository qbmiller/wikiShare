<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api'
import type { SharedFile } from '@/types'

const props = defineProps<{
  file: SharedFile
  contentUrl: string
}>()

const route = useRoute()

interface MarkdownHeading {
  id: string
  level: number
  text: string
}

const markdownHtml = ref('')
const markdownText = ref('')
const headings = ref<MarkdownHeading[]>([])
const loading = ref(true)
const saving = ref(false)
const editing = ref(route.query.edit === '1')
const error = ref('')
const savedMessage = ref('')
const renderedPreview = computed(() => renderMarkdown(markdownText.value))

onMounted(async () => {
  try {
    const response = await fetch(props.contentUrl, { credentials: 'include' })
    if (!response.ok) {
      throw new Error(`Markdown 加载失败：${response.status}`)
    }
    markdownText.value = await response.text()
    updateRenderedMarkdown()
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Markdown 加载失败'
  } finally {
    loading.value = false
  }
})

async function saveMarkdown() {
  saving.value = true
  error.value = ''
  savedMessage.value = ''
  try {
    await api(`/api/files/${props.file.id}/content`, {
      method: 'PUT',
      body: JSON.stringify({ content: markdownText.value }),
    })
    updateRenderedMarkdown()
    editing.value = false
    savedMessage.value = '已保存'
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Markdown 保存失败'
  } finally {
    saving.value = false
  }
}

function updateRenderedMarkdown() {
  const rendered = renderMarkdown(markdownText.value)
  markdownHtml.value = rendered.html
  headings.value = rendered.headings
}

function renderMarkdown(markdown: string): { html: string; headings: MarkdownHeading[] } {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  const headings: MarkdownHeading[] = []
  const headingIds = new Map<string, number>()
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
      const text = heading[2].trim()
      const id = createHeadingId(text, headingIds)
      headings.push({ id, level, text })
      html.push(`<h${level} id="${id}">${renderInline(text)}</h${level}>`)
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
  return { html: html.join(''), headings }
}

function createHeadingId(text: string, headingIds: Map<string, number>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'heading'
  const count = headingIds.get(base) ?? 0
  headingIds.set(base, count + 1)
  return count === 0 ? base : `${base}-${count + 1}`
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

function scrollToHeading(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
</script>

<template>
  <section class="reader-format">
    <p v-if="loading" class="empty-state">正在加载 Markdown...</p>
    <p v-if="error" class="form-message">{{ error }}</p>
    <p v-if="savedMessage" class="form-message">{{ savedMessage }}</p>

    <div v-if="!loading" class="reader-controls">
      <div class="segmented-control">
        <button type="button" :class="{ active: !editing }" @click="editing = false; updateRenderedMarkdown()">预览</button>
        <button type="button" :class="{ active: editing }" @click="editing = true">编辑</button>
      </div>
      <button class="primary-button" type="button" :disabled="saving" @click="saveMarkdown">保存</button>
    </div>

    <div v-if="!loading && editing" class="markdown-editor-layout">
      <textarea v-model="markdownText" class="markdown-editor" spellcheck="false"></textarea>
      <article class="markdown-stage markdown-preview-stage">
        <div class="markdown-body" v-html="renderedPreview.html"></div>
      </article>
    </div>

    <div v-if="!loading && !editing" class="markdown-reader-layout">
      <article class="markdown-stage">
        <div class="markdown-body" v-html="markdownHtml"></div>
        <div class="watermark">CFShare · 当前账号 · {{ new Date().toLocaleString('zh-CN') }}</div>
      </article>

      <aside v-if="headings.length" class="markdown-outline" aria-label="文章结构">
        <h2>文章结构</h2>
        <button
          v-for="heading in headings"
          :key="heading.id"
          :class="`level-${heading.level}`"
          type="button"
          @click="scrollToHeading(heading.id)"
        >
          {{ heading.text }}
        </button>
      </aside>
    </div>
  </section>
</template>
