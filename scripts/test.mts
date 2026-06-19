import assert from 'node:assert/strict'
import { dateInputToEpoch, epochToDateInput } from '../src/date.js'
import { parseRange } from '../src/worker/range.js'

assert.deepEqual(parseRange('bytes=0-99', 1000), { offset: 0, end: 99, length: 100 })
assert.deepEqual(parseRange('bytes=900-', 1000), { offset: 900, end: 999, length: 100 })
assert.deepEqual(parseRange('bytes=-200', 1000), { offset: 800, end: 999, length: 200 })
assert.deepEqual(parseRange('bytes=900-1200', 1000), { offset: 900, end: 999, length: 100 })
assert.equal(parseRange('items=0-1', 1000), null)
assert.equal(parseRange('bytes=1000-1001', 1000), null)
assert.equal(parseRange('bytes=50-40', 1000), null)

const epoch = dateInputToEpoch('2026-06-19')
assert.equal(typeof epoch, 'number')
assert.equal(epochToDateInput(epoch), '2026-06-19')
assert.equal(dateInputToEpoch(''), null)
assert.equal(epochToDateInput(null), '')

console.log('基础逻辑测试通过')
