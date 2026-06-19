import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from './stores/auth'
import DashboardView from './views/DashboardView.vue'
import LoginView from './views/LoginView.vue'
import ReaderView from './views/ReaderView.vue'
import TrashView from './views/TrashView.vue'
import UsersView from './views/UsersView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: LoginView },
    { path: '/', component: DashboardView, meta: { requiresAuth: true } },
    { path: '/reader/file/:id', component: ReaderView, meta: { requiresAuth: true } },
    { path: '/trash', component: TrashView, meta: { requiresAuth: true } },
    { path: '/users', component: UsersView, meta: { requiresAuth: true, requiresAdmin: true } },
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

