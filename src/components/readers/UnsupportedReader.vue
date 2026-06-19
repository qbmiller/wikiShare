<script setup lang="ts">
import type { SharedFile } from '@/types'

defineProps<{
  file: SharedFile
  contentUrl: string
}>()
</script>

<template>
  <p class="empty-state">当前文件格式暂不支持在线阅读：{{ file.mime_type }}</p>
</template>
