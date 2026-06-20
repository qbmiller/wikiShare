<script setup lang="ts">
import { ClipboardList, FileText, LogOut, PanelLeftClose, PanelLeftOpen, Recycle, Settings, Share2, Users } from 'lucide-vue-next'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from './stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const sidebarCollapsed = ref(false)
const isReaderRoute = computed(() => route.path.startsWith('/reader/'))
const isRegularReader = computed(() => auth.user?.role === 'user' && isReaderRoute.value)

async function logout() {
  await auth.logout()
  await router.push('/login')
}

watch(
  () => [auth.user?.id, auth.user?.role, route.path],
  () => {
    if (!auth.user) {
      sidebarCollapsed.value = false
      return
    }
    if (auth.user.role === 'user') {
      sidebarCollapsed.value = true
      return
    }
    sidebarCollapsed.value = false
  },
  { immediate: true },
)
</script>

<template>
  <div class="app-shell" :class="{ 'sidebar-collapsed': auth.user && sidebarCollapsed, 'is-public': !auth.user }">
    <aside v-if="auth.user" class="sidebar" :class="{ 'is-collapsed': sidebarCollapsed }">
      <div class="brand">
        <div class="brand-mark">CF</div>
        <div class="sidebar-text">
          <strong>CFShare</strong>
          <span>文档在线阅读</span>
        </div>
        <button
          class="icon-button sidebar-toggle"
          type="button"
          :title="sidebarCollapsed ? '展开菜单' : '收缩菜单'"
          :aria-label="sidebarCollapsed ? '展开菜单' : '收缩菜单'"
          :aria-expanded="!sidebarCollapsed"
          @click="sidebarCollapsed = !sidebarCollapsed"
        >
          <PanelLeftOpen v-if="sidebarCollapsed" :size="18" />
          <PanelLeftClose v-else :size="18" />
        </button>
      </div>

      <nav class="nav-list">
        <RouterLink to="/" class="nav-item" title="浏览">
          <FileText :size="18" />
          <span class="sidebar-text">浏览</span>
        </RouterLink>
        <RouterLink v-if="auth.user.role === 'admin'" to="/manage" class="nav-item" title="管理">
          <FileText :size="18" />
          <span class="sidebar-text">管理</span>
        </RouterLink>
        <RouterLink v-if="auth.user.role === 'admin'" to="/trash" class="nav-item" title="回收站">
          <Recycle :size="18" />
          <span class="sidebar-text">回收站</span>
        </RouterLink>
        <RouterLink v-if="auth.user.role === 'admin'" to="/shares" class="nav-item" title="分享">
          <Share2 :size="18" />
          <span class="sidebar-text">分享</span>
        </RouterLink>
        <RouterLink v-if="auth.user.role === 'admin'" to="/users" class="nav-item" title="用户">
          <Users :size="18" />
          <span class="sidebar-text">用户</span>
        </RouterLink>
        <RouterLink v-if="auth.user.role === 'admin'" to="/audit-logs" class="nav-item" title="审计">
          <ClipboardList :size="18" />
          <span class="sidebar-text">审计</span>
        </RouterLink>
        <RouterLink to="/settings" class="nav-item" title="设置">
          <Settings :size="18" />
          <span class="sidebar-text">设置</span>
        </RouterLink>
      </nav>

      <div class="sidebar-footer">
        <div class="sidebar-text">
          <strong>{{ auth.user.username }}</strong>
          <span>{{ isRegularReader ? '阅读模式' : auth.user.role === 'admin' ? '管理员' : '用户' }}</span>
        </div>
        <button class="icon-button" title="退出登录" @click="logout">
          <LogOut :size="18" />
        </button>
      </div>
    </aside>

    <main class="main-panel">
      <RouterView />
    </main>
  </div>
</template>
