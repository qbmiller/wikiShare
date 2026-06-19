import assert from 'node:assert/strict'
import { dateInputToEpoch, epochToDateInput } from '../src/date.js'
import { getEffectiveFolderExpiration, isFileReadable, isFolderAvailable } from '../src/worker/db.js'
import { parseRange } from '../src/worker/range.js'
import type { Env, FileRecord, FolderRecord } from '../src/worker/types.js'

assert.deepEqual(parseRange('bytes=0-99', 1000), { offset: 0, end: 99, length: 100 })
assert.deepEqual(parseRange('bytes=900-', 1000), { offset: 900, end: 999, length: 100 })
assert.deepEqual(parseRange('bytes=-200', 1000), { offset: 800, end: 999, length: 200 })
assert.deepEqual(parseRange('bytes=900-1200', 1000), { offset: 900, end: 999, length: 100 })
assert.equal(parseRange('items=0-1', 1000), null)
assert.equal(parseRange('bytes=1000-1001', 1000), null)
assert.equal(parseRange('bytes=50-40', 1000), null)
assert.equal(parseRange('bytes=0-1', 0), null)

const epoch = dateInputToEpoch('2026-06-19')
assert.equal(typeof epoch, 'number')
assert.equal(epochToDateInput(epoch), '2026-06-19')
assert.equal(dateInputToEpoch(''), null)
assert.equal(epochToDateInput(null), '')

const now = 1_800_000_000
const folders = new Map<string, FolderRecord>([
  ['root', folder({ id: 'root', parent_id: null, depth: 1, expires_at: null })],
  ['dated', folder({ id: 'dated', parent_id: 'root', depth: 2, expires_at: now + 100 })],
  ['child', folder({ id: 'child', parent_id: 'dated', depth: 3, expires_at: null })],
  ['expired', folder({ id: 'expired', parent_id: 'root', depth: 2, expires_at: now - 1 })],
  ['trashed', folder({ id: 'trashed', parent_id: 'root', depth: 2, expires_at: null, trashed_at: now - 5 })],
])
const env = mockEnv(folders)

assert.equal(await isFolderAvailable(env, 'root', now), true)
assert.equal(await isFolderAvailable(env, 'child', now), true)
assert.equal(await isFolderAvailable(env, 'expired', now), false)
assert.equal(await isFolderAvailable(env, 'trashed', now), false)
assert.equal(await getEffectiveFolderExpiration(env, 'child'), now + 100)

const readableFile = file({ folder_id: 'child' })
const expiredFile = file({ folder_id: 'child', expires_at: now - 1 })
const trashedFile = file({ folder_id: 'child', trashed_at: now - 1 })
const deletedFile = file({ folder_id: 'child', deleted_at: now - 1 })
const folderExpiredFile = file({ folder_id: 'expired' })

assert.equal(await isFileReadable(env, readableFile, now), true)
assert.equal(await isFileReadable(env, expiredFile, now), false)
assert.equal(await isFileReadable(env, trashedFile, now), false)
assert.equal(await isFileReadable(env, deletedFile, now), false)
assert.equal(await isFileReadable(env, folderExpiredFile, now), false)

console.log('基础逻辑测试通过')

function folder(input: Partial<FolderRecord> & Pick<FolderRecord, 'id' | 'parent_id' | 'depth'>): FolderRecord {
  return {
    name: input.id,
    expires_at: null,
    trashed_at: null,
    created_by: 'tester',
    created_at: now,
    ...input,
  }
}

function file(input: Partial<FileRecord> & Pick<FileRecord, 'folder_id'>): FileRecord {
  return {
    id: input.id ?? `file-${input.folder_id}`,
    name: 'sample.pdf',
    r2_key: 'active/default/sample.pdf',
    size: 128,
    mime_type: 'application/pdf',
    sha256: null,
    expires_at: null,
    trashed_at: null,
    deleted_at: null,
    uploaded_by: 'tester',
    created_at: now,
    ...input,
  }
}

function mockEnv(folders: Map<string, FolderRecord>): Env {
  return {
    DB: {
      prepare(query: string) {
        return {
          bind(id: string) {
            return {
              async first<T>() {
                if (query.includes('from folders')) {
                  return (folders.get(id) ?? null) as T | null
                }
                throw new Error(`未模拟的 first 查询：${query}`)
              },
              async run() {
                throw new Error(`未模拟的 run 查询：${query}`)
              },
              async all() {
                throw new Error(`未模拟的 all 查询：${query}`)
              },
              bind() {
                throw new Error('不支持链式 bind')
              },
            }
          },
          async first() {
            throw new Error(`未模拟的 first 查询：${query}`)
          },
          async run() {
            throw new Error(`未模拟的 run 查询：${query}`)
          },
          async all() {
            throw new Error(`未模拟的 all 查询：${query}`)
          },
        }
      },
      async batch() {
        throw new Error('未模拟 batch')
      },
    },
    PDF_BUCKET: {} as Env['PDF_BUCKET'],
    ASSETS: {} as Env['ASSETS'],
  }
}
