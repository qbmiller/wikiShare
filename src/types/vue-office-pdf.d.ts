declare module '@vue-office/pdf/lib/v3/index.js' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<{
    src: string | ArrayBuffer | Blob
    requestOptions?: Record<string, unknown>
    staticFileUrl?: string
    options?: Record<string, unknown>
    defaultScale?: number
  }>

  export default component
}
