import assert from 'node:assert/strict'
import { dateInputToEpoch, epochToDateInput } from '../src/date.js'
import { hashPassword, verifyPassword } from '../src/worker/crypto.js'
import { filterVisibleFolders, getEffectiveFolderExpiration, isFileReadable, isFolderAvailable } from '../src/worker/db.js'
import { getMaxUploadBytes, restoreFolderTree, trashFolderTree } from '../src/worker/index.js'
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
assert.equal(getMaxUploadBytes({}), 100 * 1024 * 1024)
assert.equal(getMaxUploadBytes({ MAX_UPLOAD_BYTES: '1024' }), 1024)
assert.equal(getMaxUploadBytes({ MAX_UPLOAD_BYTES: '-1' }), 100 * 1024 * 1024)

const passwordHash = await hashPassword('correct-password')
assert.equal(passwordHash.split('$')[1], '100000')
assert.equal(await verifyPassword('correct-password', passwordHash), true)
assert.equal(await verifyPassword('wrong-password', passwordHash), false)

const now = 1_800_000_000
const folders = new Map<string, FolderRecord>([
  ['root', folder({ id: 'root', parent_id: null, depth: 1, expires_at: null })],
  ['dated', folder({ id: 'dated', parent_id: 'root', depth: 2, expires_at: now + 100 })],
  ['child', folder({ id: 'child', parent_id: 'dated', depth: 3, expires_at: null })],
  ['expired', folder({ id: 'expired', parent_id: 'root', depth: 2, expires_at: now - 1 })],
  ['expired-child', folder({ id: 'expired-child', parent_id: 'expired', depth: 3, expires_at: null })],
  ['trashed', folder({ id: 'trashed', parent_id: 'root', depth: 2, expires_at: null, trashed_at: now - 5 })],
])
const env = mockEnv(folders)

assert.equal(await isFolderAvailable(env, 'root', now), true)
assert.equal(await isFolderAvailable(env, 'child', now), true)
assert.equal(await isFolderAvailable(env, 'expired', now), false)
assert.equal(await isFolderAvailable(env, 'expired-child', now), false)
assert.equal(await isFolderAvailable(env, 'trashed', now), false)
assert.equal(await getEffectiveFolderExpiration(env, 'child'), now + 100)
assert.deepEqual(
  filterVisibleFolders([...folders.values()], now).map((folder) => folder.id),
  ['root', 'dated', 'child'],
)

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

const trashEnv = mockEnv(folders)
await trashFolderTree(trashEnv, 'dated', now)
assert.deepEqual(trashEnv.__runs, [
  { query: 'update folders set trashed_at = ? where id = ?', values: [now, 'dated'] },
  { query: 'update folders set trashed_at = ? where parent_id = ? or parent_id in (select id from folders where parent_id = ?)', values: [now, 'dated', 'dated'] },
  {
    query: 'update files set trashed_at = ? where deleted_at is null and ( folder_id = ? or folder_id in (select id from folders where parent_id = ?) or folder_id in (select id from folders where parent_id in (select id from folders where parent_id = ?)) )',
    values: [now, 'dated', 'dated', 'dated'],
  },
])

const restoreEnv = mockEnv(folders)
await restoreFolderTree(restoreEnv, 'dated')
assert.deepEqual(restoreEnv.__runs, [
  { query: 'update folders set trashed_at = null where id = ?', values: ['dated'] },
  { query: 'update folders set trashed_at = null where parent_id = ? or parent_id in (select id from folders where parent_id = ?)', values: ['dated', 'dated'] },
  {
    query: 'update files set trashed_at = null where deleted_at is null and ( folder_id = ? or folder_id in (select id from folders where parent_id = ?) or folder_id in (select id from folders where parent_id in (select id from folders where parent_id = ?)) )',
    values: ['dated', 'dated', 'dated'],
  },
])

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

interface MockEnv extends Env {
  __runs: Array<{ query: string; values: unknown[] }>
}

function mockEnv(folders: Map<string, FolderRecord>): MockEnv {
  const runs: Array<{ query: string; values: unknown[] }> = []
  return {
    __runs: runs,
    DB: {
      prepare(query: string) {
        return statement(query, folders, runs)
      },
      async batch() {
        throw new Error('未模拟 batch')
      },
    },
    PDF_BUCKET: {} as Env['PDF_BUCKET'],
    ASSETS: {} as Env['ASSETS'],
  }
}

function statement(query: string, folders: Map<string, FolderRecord>, runs: Array<{ query: string; values: unknown[] }>, values: unknown[] = []) {
  return {
    bind(...nextValues: unknown[]) {
      return statement(query, folders, runs, nextValues)
    },
    async first<T>() {
      if (query.includes('from folders')) {
        return (folders.get(String(values[0])) ?? null) as T | null
      }
      throw new Error(`未模拟的 first 查询：${query}`)
    },
    async run() {
      runs.push({ query: normalizeSql(query), values })
      return { results: [], success: true as const, meta: {} }
    },
    async all() {
      throw new Error(`未模拟的 all 查询：${query}`)
    },
  }
}

function normalizeSql(query: string): string {
  return query.replace(/\s+/g, ' ').trim()
}
