import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const databaseName = 'cfshare-db'
const bucketName = 'cfshare-pdfs'
const templatePath = resolve('wrangler.toml')
const localPath = resolve('wrangler.local.toml')

function runWrangler(args) {
  const bin = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  return execFileSync(bin, ['wrangler', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function ensureD1() {
  const list = JSON.parse(runWrangler(['d1', 'list', '--json']))
  const existing = list.find((database) => database.name === databaseName)
  if (existing) {
    return existing.uuid
  }

  const createdText = runWrangler(['d1', 'create', databaseName])
  const match = /database_id\s*=\s*"([^"]+)"/.exec(createdText)
  if (!match) {
    throw new Error(`D1 已创建但无法解析 database_id，请检查输出：\n${createdText}`)
  }
  return match[1]
}

function ensureR2() {
  const list = JSON.parse(runWrangler(['r2', 'bucket', 'list', '--json']))
  const exists = list.some((bucket) => bucket.name === bucketName)
  if (!exists) {
    runWrangler(['r2', 'bucket', 'create', bucketName])
  }
}

function writeLocalConfig(databaseId) {
  if (!existsSync(templatePath)) {
    throw new Error('未找到 wrangler.toml')
  }

  const content = readFileSync(templatePath, 'utf8').replace('replace-with-cloudflare-d1-database-id', databaseId)
  writeFileSync(localPath, content)
}

const databaseId = ensureD1()
ensureR2()
writeLocalConfig(databaseId)

console.log(`Cloudflare 资源已准备：`)
console.log(`- D1: ${databaseName} (${databaseId})`)
console.log(`- R2: ${bucketName}`)
console.log(`- 本地部署配置: ${localPath}`)
console.log('')
console.log('下一步：')
console.log('1. npx wrangler secret put SESSION_SECRET --config wrangler.local.toml')
console.log('2. npx wrangler d1 migrations apply cfshare-db --remote --config wrangler.local.toml')
console.log('3. npm run build')
console.log('4. npx wrangler deploy --config wrangler.local.toml')

