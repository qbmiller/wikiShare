<script setup lang="ts">
import type { SharedFile } from '@/types'

defineProps<{
  contentUrl: string
  file: SharedFile
}>()
</script>

<template>
  <div class="image-stage">
    <img :src="contentUrl" :alt="file.name" />
    <div class="watermark">CFShare · 当前账号 · {{ new Date().toLocaleString('zh-CN') }}</div>
  </div>
</template>
