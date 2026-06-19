<script setup lang="ts">
import type { SharedFile } from '@/types'

defineProps<{
  file: SharedFile
  contentUrl: string
}>()
</script>

<template>
  <section class="presentation-stage">
    <div class="presentation-preview">
      <strong>PPT</strong>
      <h2>{{ file.name }}</h2>
      <p>文件已安全保存。PPT/PPTX 需要转换为 PDF 或图片页后才能在浏览器内逐页预览。</p>
    </div>
    <div class="watermark">CFShare · 当前账号 · {{ new Date().toLocaleString('zh-CN') }}</div>
  </section>
</template>
