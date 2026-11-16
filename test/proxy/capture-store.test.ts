import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CaptureStore } from '../../src/proxy/capture-store.js'
import type { CaptureEntry } from '../../src/proxy/capture.js'

function makeEntry(pairId: number, overrides: Partial<CaptureEntry> = {}): CaptureEntry {
  return {
    id: pairId,
    timestamp: 1_700_000_000_000 + pairId,
    durationMs: null,
    source: 'proxy',
    protocol: 'openai',
    model: 'gpt-x',
    pairId,
    requestIn: JSON.stringify({ messages: [{ role: 'user', content: 'q' }] }),
    requestOut: null,
    responseIn: null,
    responseOut: null,
    ...overrides,
  }
}

describe('proxy/capture-store', () => {
  let dir: string
  let dbPath: string
  let store: CaptureStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'capture-store-'))
    dbPath = join(dir, 'capture.db')
    store = new CaptureStore(dbPath)
  })

  afterEach(() => {
    store.close()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  it('upsert + latest 往返（含 loop 字段与 meta）', () => {
    store.upsert(makeEntry(1, {
      loop: { loopId: 1, turn: 1, turnTimes: [111], messageTimes: [111, 111] },
      adapterName: 'my-adapter',
      upstreamProvider: 'deepseek',
      upstreamProtocol: 'openai',
      upstreamModel: 'deepseek-chat',
      responseOut: '{"ok":true}',
      durationMs: 321,
    }))
    const got = store.latest(10)
    assert.strictEqual(got.length, 1)
    const e = got[0]
    assert.strictEqual(e.pairId, 1)
    assert.strictEqual(e.timestamp, 1_700_000_000_001)
    assert.strictEqual(e.durationMs, 321)
    assert.strictEqual(e.adapterName, 'my-adapter')
    assert.strictEqual(e.upstreamModel, 'deepseek-chat')
    assert.ok(e.loop)
    assert.strictEqual(e.loop.turn, 1)
    assert.deepStrictEqual(e.loop.messageTimes, [111, 111])
    assert.strictEqual(e.requestIn, '{"messages":[{"role":"user","content":"q"}]}')
  })

  it('同 pairId upsert 覆盖（loop 接管语义）', () => {
    store.upsert(makeEntry(5, { loop: { loopId: 5, turn: 1, turnTimes: [1], messageTimes: [1] } }))
    store.upsert(makeEntry(5, { loop: { loopId: 5, turn: 2, turnTimes: [1, 2], messageTimes: [1, 2, 2] }, responseOut: 'v2' }))
    const got = store.latest(10)
    assert.strictEqual(got.length, 1, '同 pairId 只保留一行')
    assert.strictEqual(got[0].loop!.turn, 2)
    assert.strictEqual(got[0].responseOut, 'v2')
  })

  it('prune：超出保留上限删最旧；setMax 热更新', () => {
    for (let i = 1; i <= 5; i++) store.upsert(makeEntry(i))
    store.setMax(3)
    assert.strictEqual(store.count(), 3)
    const ids = store.latest(10).map((e) => e.pairId)
    assert.deepStrictEqual(ids, [3, 4, 5], '保留最新的 3 条')
  })

  it('latest 按 n 限制并返回时间升序', () => {
    for (let i = 1; i <= 4; i++) store.upsert(makeEntry(i))
    const got = store.latest(2)
    assert.deepStrictEqual(got.map((e) => e.pairId), [3, 4])
  })

  it('clear 清空全部', () => {
    store.upsert(makeEntry(1))
    store.upsert(makeEntry(2))
    store.clear()
    assert.strictEqual(store.count(), 0)
    assert.strictEqual(store.latest(10).length, 0)
  })

  it('重启后数据仍在（重新打开同一 db）', () => {
    store.upsert(makeEntry(9, { loop: { loopId: 9, turn: 3, turnTimes: [1, 2, 3], messageTimes: [1, 1, 3] } }))
    store.close()
    const store2 = new CaptureStore(dbPath)
    const got = store2.latest(10)
    assert.strictEqual(got.length, 1)
    assert.strictEqual(got[0].pairId, 9)
    assert.strictEqual(got[0].loop!.turn, 3)
    store2.close()
  })
})
