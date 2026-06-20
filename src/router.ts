import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'
import BrowseView from './views/BrowseView.vue'
import DashboardView from './views/DashboardView.vue'
import AuditLogsView from './views/AuditLogsView.vue'
import LoginView from './views/LoginView.vue'
import PublicShareView from './views/PublicShareView.vue'
import ReaderView from './views/ReaderView.vue'
import SettingsView from './views/SettingsView.vue'
import SharesView from './views/SharesView.vue'
import TrashView from './views/TrashView.vue'
import UsersView from './views/UsersView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView },
    { path: '/share/:shareKey/file/:fileId', component: PublicShareView },
    { path: '/share/:shareKey/:fileName?', component: PublicShareView },
    { path: '/', component: BrowseView, meta: { requiresAuth: true } },
    { path: '/manage', component: DashboardView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/reader/file/:id', component: ReaderView, meta: { requiresAuth: true } },
    { path: '/shares', component: SharesView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/trash', component: TrashView, meta: { requiresAuth: true } },
    { path: '/users', component: UsersView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/audit-logs', component: AuditLogsView, meta: { requiresAuth: true, requiresAdmin: true } },
    { path: '/settings', component: SettingsView, meta: { requiresAuth: true } },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.loaded) {
    await auth.loadMe()
  }
  if (to.meta.requiresAuth && !auth.user) {
    return '/login'
  }
  if (to.meta.requiresAdmin && auth.user?.role !== 'admin') {
    return '/'
  }
  if (to.path === '/login' && auth.user) {
    return '/'
  }
  return true
})
