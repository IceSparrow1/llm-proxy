import { describe, it, mock } from 'node:test'
import assert from 'node:assert'
import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { CaptureBuffer } from '../../src/proxy/capture.js'
import { forwardRequest } from '../../src/proxy/provider.js'

function fakeRes(overrides: Partial<{ destroyed: boolean; writableEnded: boolean; writable: boolean }> = {}): ServerResponse {
  const ee = new EventEmitter() as any
  ee.writeHead = () => ee
  ee.write = () => true
  ee.end = () => ee
  ee.destroyed = overrides.destroyed ?? false
  ee.writableEnded = overrides.writableEnded ?? false
  ee.writable = overrides.writable ?? true
  // 代理到 EventEmitter 原型方法，避免递归
  const origOn = EventEmitter.prototype.on.bind(ee)
  ee.on = (event: string, cb: (...args: any[]) => void) => { origOn(event, cb); return ee }
  return ee as ServerResponse
}

describe('proxy/capture', () => {
  it('startRequest 创建一条记录，返回 pairId', () => {
    const cap = new CaptureBuffer(100)
    const pairId = cap.startRequest('proxy', 'anthropic', 'claude-3')
    assert.strictEqual(typeof pairId, 'number')
    assert.strictEqual(pairId, 1)

    const all = cap.getAll()
    assert.strictEqual(all.length, 1)
    assert.strictEqual(all[0].source, 'proxy')
    assert.strictEqual(all[0].protocol, 'anthropic')
    assert.strictEqual(all[0].model, 'claude-3')
    assert.strictEqual(all[0].pairId, 1)
    assert.strictEqual(all[0].durationMs, null)
    assert.strictEqual(all[0].requestIn, null)
  })

  it('updateRequest 更新指定阶段的数据', () => {
    const cap = new CaptureBuffer(100)
    const pairId = cap.startRequest('proxy', 'openai', 'gpt-4')
    cap.updateRequest(pairId, 'requestIn', '{"model":"gpt-4"}')
    cap.updateRequest(pairId, 'responseOut', '{"choices":[]}')

    const entry = cap.getAll()[0]
    assert.strictEqual(entry.requestIn, '{"model":"gpt-4"}')
    assert.strictEqual(entry.responseOut, '{"choices":[]}')
    assert.ok(entry.durationMs !== null && entry.durationMs >= 0)
    // 未更新的字段仍为 null
    assert.strictEqual(entry.requestOut, null)
    assert.strictEqual(entry.responseIn, null)
  })

  it('updateRequest 不存在的 pairId 静默忽略', () => {
    const cap = new CaptureBuffer(100)
    // 不应抛异常
    cap.updateRequest(999, 'requestIn', 'data')
  })

  it('非流式同协议响应同时记录双向正文和耗时', async () => {
    const responseText = JSON.stringify({
      id: 'chatcmpl-capture',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
    })
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(responseText, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const cap = new CaptureBuffer(100)

    try {
      const pairId = cap.startRequest('proxy', 'openai', 'gpt-4')
      const res = fakeRes()
      let clientBody = ''
      res.end = ((chunk?: unknown) => {
        clientBody = chunk == null ? '' : String(chunk)
        return res
      }) as ServerResponse['end']

      await forwardRequest({
        url: 'https://api.openai.com/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { model: 'gpt-4', messages: [{ role: 'user', content: 'hello' }] },
        crossProtocol: false,
        inboundType: 'openai',
        upstreamType: 'openai',
        capture: cap,
        pairId,
      }, res)

      const entry = cap.getAll()[0]
      assert.strictEqual(entry.responseIn, responseText)
      assert.strictEqual(entry.responseOut, responseText)
      assert.strictEqual(clientBody, responseText)
      assert.ok(entry.durationMs !== null && entry.durationMs >= 0)
    } finally {
      fetchMock.mock.restore()
      cap.destroy()
    }
  })

  it('startRequest 携带 meta 信息', () => {
    const cap = new CaptureBuffer(100)
    cap.startRequest('adapter', 'anthropic', 'claude-3', {
      adapterName: 'my-tool',
      upstreamProvider: 'anthropic',
      upstreamProtocol: 'anthropic',
      upstreamModel: 'claude-sonnet-4-20250514',
    })

    const entry = cap.getAll()[0]
    assert.strictEqual(entry.adapterName, 'my-tool')
    assert.strictEqual(entry.upstreamProvider, 'anthropic')
    assert.strictEqual(entry.upstreamModel, 'claude-sonnet-4-20250514')
  })

  it('getAll 返回副本，不受后续修改影响', () => {
    const cap = new CaptureBuffer(100)
    cap.startRequest('proxy', 'anthropic', 'claude-3')
    const snapshot = cap.getAll()
    assert.strictEqual(snapshot.length, 1)

    cap.startRequest('proxy', 'openai', 'gpt-4')
    // 旧 snapshot 不受影响
    assert.strictEqual(snapshot.length, 1)
    assert.strictEqual(cap.getAll().length, 2)
  })

  describe('enabled 开关', () => {
    it('默认 enabled = false', () => {
      const cap = new CaptureBuffer(100)
      assert.strictEqual(cap.isEnabled(), false)
    })

    it('disable 后 isEnabled 返回 false', () => {
      const cap = new CaptureBuffer(100)
      cap.disable()
      assert.strictEqual(cap.isEnabled(), false)
    })

    it('enable 后恢复 true', () => {
      const cap = new CaptureBuffer(100)
      cap.disable()
      cap.enable()
      assert.strictEqual(cap.isEnabled(), true)
    })

    it('enable/disable 不影响正常记录功能', () => {
      const cap = new CaptureBuffer(100)
      cap.disable()
      // 开关不影响 buffer 操作——调用方负责判断 isEnabled()
      const pairId = cap.startRequest('proxy', 'anthropic', 'claude-3')
      cap.updateRequest(pairId, 'requestIn', '{}')
      assert.strictEqual(cap.getAll().length, 1)

      cap.enable()
      cap.startRequest('proxy', 'openai', 'gpt-4')
      assert.strictEqual(cap.getAll().length, 2)
    })
  })

  describe('clear', () => {
    it('清空所有记录', () => {
      const cap = new CaptureBuffer(100)
      cap.startRequest('proxy', 'anthropic', 'claude-3')
      cap.startRequest('proxy', 'openai', 'gpt-4')
      assert.strictEqual(cap.getAll().length, 2)

      cap.clear()
      assert.strictEqual(cap.getAll().length, 0)
    })

    it('clear 后 updateRequest 无效（pairId 已不存在）', () => {
      const cap = new CaptureBuffer(100)
      const pairId = cap.startRequest('proxy', 'anthropic', 'claude-3')
      cap.clear()
      // 静默忽略
      cap.updateRequest(pairId, 'requestIn', 'data')
      assert.strictEqual(cap.getAll().length, 0)
    })
  })

  describe('maxSize', () => {
    it('setMaxSize 热更新上限并立即淘汰旧记录', () => {
      const cap = new CaptureBuffer(4)
      cap.startRequest('proxy', 'a', 'm1')
      cap.startRequest('proxy', 'b', 'm2')
      cap.startRequest('proxy', 'c', 'm3')

      cap.setMaxSize(2)

      assert.deepStrictEqual(cap.getAll().map((entry) => entry.model), ['m2', 'm3'])
    })

    it('超过 maxSize 时淘汰旧记录', () => {
      const cap = new CaptureBuffer(3)
      cap.startRequest('proxy', 'a', 'm1')
      cap.startRequest('proxy', 'b', 'm2')
      cap.startRequest('proxy', 'c', 'm3')
      assert.strictEqual(cap.getAll().length, 3)

      // 第4条挤掉第1条
      cap.startRequest('proxy', 'd', 'm4')
      assert.strictEqual(cap.getAll().length, 3)
      assert.strictEqual(cap.getAll()[0].model, 'm2')
      assert.strictEqual(cap.getAll()[2].model, 'm4')
    })

    it('淘汰后旧 pairId 无法再 updateRequest', () => {
      const cap = new CaptureBuffer(2)
      const p1 = cap.startRequest('proxy', 'a', 'm1')
      cap.startRequest('proxy', 'b', 'm2')
      cap.startRequest('proxy', 'c', 'm3') // 挤掉 m1

      // p1 已不在 entryMap 中
      cap.updateRequest(p1, 'requestIn', 'data')
      const entry = cap.getAll().find(e => e.pairId === p1)
      assert.strictEqual(entry, undefined)
    })
  })

  describe('subscribe / 通知', () => {
    it('subscribe 后新记录会推送给订阅者', () => {
      const cap = new CaptureBuffer(100)
      const res = fakeRes()
      let written = ''
      res.write = (chunk: any) => { written += chunk.toString(); return true }

      cap.subscribe(res)

      const pairId = cap.startRequest('proxy', 'anthropic', 'claude-3')
      assert.ok(written.includes('"source":"proxy"'))
      assert.ok(written.includes(`"pairId":${pairId}`))

      // 更新也会推送
      cap.updateRequest(pairId, 'requestIn', '{}')
      assert.ok(written.includes('"requestIn":"{}"'))
    })

    it('订阅者 close 后自动移除', () => {
      const cap = new CaptureBuffer(100)
      const res = fakeRes()
      let writeCount = 0
      res.write = () => { writeCount++; return true }

      cap.subscribe(res)
      // 触发 close
      res.emit('close')

      cap.startRequest('proxy', 'anthropic', 'claude-3')
      // close 后应不再有写入
      assert.strictEqual(writeCount, 0)
    })

    it('多个订阅者同时接收通知', () => {
      const cap = new CaptureBuffer(100)
      const res1 = fakeRes()
      const res2 = fakeRes()
      let w1 = ''
      let w2 = ''
      res1.write = (chunk: any) => { w1 += chunk.toString(); return true }
      res2.write = (chunk: any) => { w2 += chunk.toString(); return true }

      cap.subscribe(res1)
      cap.subscribe(res2)
      cap.startRequest('proxy', 'anthropic', 'claude-3')

      assert.ok(w1.includes('"pairId":1'))
      assert.ok(w2.includes('"pairId":1'))
    })
  })

  describe('内存泄漏防护（死 subscriber 清理）', () => {
    it('destroyed=true 的 subscriber 在下次 notify 时被清理', () => {
      const cap = new CaptureBuffer(100)
      const dead = fakeRes({ destroyed: true })
      let writeCount = 0
      dead.write = () => { writeCount++; return true }

      cap.subscribe(dead)
      assert.strictEqual((cap as any).subscribers.size, 1)

      cap.startRequest('proxy', 'anthropic', 'claude-3')

      // 已死的 subscriber 必须被清理，且不接收任何写入
      assert.strictEqual((cap as any).subscribers.size, 0)
      assert.strictEqual(writeCount, 0)
    })

    it('writableEnded=true 的 subscriber 在下次 notify 时被清理', () => {
      const cap = new CaptureBuffer(100)
      const ended = fakeRes({ writableEnded: true })
      let writeCount = 0
      ended.write = () => { writeCount++; return true }

      cap.subscribe(ended)
      cap.startRequest('proxy', 'openai', 'gpt-4')

      assert.strictEqual((cap as any).subscribers.size, 0)
      assert.strictEqual(writeCount, 0)
    })

    it('writable=false 的 subscriber 在下次 notify 时被清理', () => {
      const cap = new CaptureBuffer(100)
      const notWritable = fakeRes({ writable: false })
      let writeCount = 0
      notWritable.write = () => { writeCount++; return true }

      cap.subscribe(notWritable)
      cap.startRequest('proxy', 'openai', 'gpt-4')

      assert.strictEqual((cap as any).subscribers.size, 0)
      assert.strictEqual(writeCount, 0)
    })

    it('混合健康/死亡 subscriber：只推送给健康的', () => {
      const cap = new CaptureBuffer(100)
      const alive = fakeRes()
      const dead1 = fakeRes({ destroyed: true })
      const dead2 = fakeRes({ writableEnded: true })

      let aliveWrites = 0
      alive.write = () => { aliveWrites++; return true }
      dead1.write = () => { throw new Error('dead1 should not be written') }
      dead2.write = () => { throw new Error('dead2 should not be written') }

      cap.subscribe(alive)
      cap.subscribe(dead1)
      cap.subscribe(dead2)
      assert.strictEqual((cap as any).subscribers.size, 3)

      cap.startRequest('proxy', 'openai', 'gpt-4')

      // 两个 dead 被清理，healthy 保留
      assert.strictEqual((cap as any).subscribers.size, 1)
      assert.strictEqual(aliveWrites, 1)
    })

    it('write 抛错的 subscriber 在下次 notify 时被清理', () => {
      const cap = new CaptureBuffer(100)
      const throwing = fakeRes()
      throwing.write = () => { throw new Error('socket closed') }

      cap.subscribe(throwing)
      cap.startRequest('proxy', 'openai', 'gpt-4')

      // 抛错后被清理
      assert.strictEqual((cap as any).subscribers.size, 0)
    })

    it('反压时（write 返回 false）跳过本次写入但不清理 subscriber', () => {
      const cap = new CaptureBuffer(100)
      const slow = fakeRes()
      let writes = 0
      slow.write = () => { writes++; return false }  // 一直反压

      cap.subscribe(slow)
      cap.startRequest('proxy', 'openai', 'gpt-4')

      // 反压不应当作死亡，仅跳过本次写入
      assert.strictEqual((cap as any).subscribers.size, 1)
      assert.strictEqual(writes, 1)
    })
  })

  describe('长时间空闲 subscriber 防护', () => {
    it('超过空闲阈值的 subscriber 在 pruneStaleSubscribers 时被清理', () => {
      const cap = new CaptureBuffer(100)
      const idle = fakeRes()
      cap.subscribe(idle)
      assert.strictEqual((cap as any).subscribers.size, 1)

      // 模拟订阅者长时间未活动
      const meta = (cap as any).subscribers.get(idle)
      meta.lastSeen = Date.now() - (60 * 1000 + 1000) // 超过 60s

      // 主动调用私有 prune 方法
      ;(cap as any).pruneStaleSubscribers()

      assert.strictEqual((cap as any).subscribers.size, 0)
    })

    it('活跃的 subscriber（lastSeen 在阈值内）不被清理', () => {
      const cap = new CaptureBuffer(100)
      const active = fakeRes()
      cap.subscribe(active)
      const initialSize = (cap as any).subscribers.size
      assert.strictEqual(initialSize, 1)

      // lastSeen 是刚设置的（Date.now()），不超时
      ;(cap as any).pruneStaleSubscribers()

      assert.strictEqual((cap as any).subscribers.size, 1)
    })

    it('同时清除死亡 + 空闲 subscriber', () => {
      const cap = new CaptureBuffer(100)
      const dead = fakeRes({ destroyed: true })
      const stale = fakeRes()
      const healthy = fakeRes()

      cap.subscribe(dead)
      cap.subscribe(stale)
      cap.subscribe(healthy)
      assert.strictEqual((cap as any).subscribers.size, 3)

      // stale 模拟空闲超时
      const meta = (cap as any).subscribers.get(stale)
      meta.lastSeen = Date.now() - 120_000

      ;(cap as any).pruneStaleSubscribers()

      assert.strictEqual((cap as any).subscribers.size, 1)
    })

    it('notifySubscribers 后更新 lastSeen 防止误清理', () => {
      const cap = new CaptureBuffer(100)
      const sub = fakeRes()
      cap.subscribe(sub)

      // 把 lastSeen 拉远到超时区间
      const meta = (cap as any).subscribers.get(sub)
      meta.lastSeen = Date.now() - 120_000

      // 触发一次 notify（lastSeen 会被刷新到 now）
      cap.startRequest('proxy', 'openai', 'gpt-4')

      // 此时 prune 不应清理该 subscriber
      ;(cap as any).pruneStaleSubscribers()
      assert.strictEqual((cap as any).subscribers.size, 1)
    })

    it('构造函数启动 pruneTimer（unref 不阻止进程退出）', () => {
      const cap = new CaptureBuffer(100)
      assert.ok((cap as any).pruneTimer, 'pruneTimer 应已创建')
      cap.destroy()
      assert.strictEqual((cap as any).pruneTimer, null, 'destroy 后应清空')
    })
  })
})

// ---------------------------------------------------------------------------
// agent-loop 归属（startRequest 带 rawBody 的接管语义）
// ---------------------------------------------------------------------------

describe('proxy/capture loop attribution', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  function chatBody(userTexts: string[], assistantTexts: string[] = []): string {
    const messages: unknown[] = [{ role: 'system', content: 'sys' }]
    userTexts.forEach((t, i) => {
      messages.push({ role: 'user', content: t })
      if (assistantTexts[i] != null) messages.push({ role: 'assistant', content: assistantTexts[i] })
    })
    return JSON.stringify({ model: 'gpt-x', messages })
  }

  it('连续轮接管：复用 pairId/id，缓冲只保留一行，loop 字段正确', async () => {
    const cap = new CaptureBuffer(100)
    const p1 = cap.startRequest('proxy', 'openai', 'gpt-x', undefined, chatBody(['hi']))
    assert.strictEqual(cap.getAll().length, 1)

    // loop 锚点：uid（uuid v4）与 startedAt 在第 1 轮生成
    const first = cap.getAll()[0]
    const uid1 = first.loop!.uid
    const startedAt1 = first.loop!.startedAt
    assert.match(uid1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    assert.strictEqual(startedAt1, first.timestamp)

    await sleep(5)
    // 真正的第 2 轮：第 1 轮历史 + 回答 + 新问题的超集消息
    const turn2 = JSON.stringify({
      model: 'gpt-x',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '回答' },
        { role: 'user', content: '下一问' },
      ],
    })
    const p2 = cap.startRequest('proxy', 'openai', 'gpt-x', undefined, turn2)
    assert.strictEqual(p2, p1, '第 2 轮应接管第 1 轮的 pairId')
    assert.strictEqual(cap.getAll().length, 1, '接管后缓冲仍只有 1 条')

    const entry = cap.getAll()[0]
    assert.ok(entry.loop)
    assert.strictEqual(entry.loop.loopId, p1)
    assert.strictEqual(entry.loop.uid, uid1, '接管后 uid 不变（消息定位锚点）')
    assert.strictEqual(entry.loop.startedAt, startedAt1, 'startedAt 保持首轮时间')
    assert.strictEqual(entry.loop.turn, 2)
    assert.strictEqual(entry.loop.turnTimes.length, 2)
    assert.strictEqual(entry.loop.messageTimes.length, 4)
    // 前缀段继承旧时间，新消息盖新时间
    const times = entry.loop.messageTimes
    assert.strictEqual(times[0], times[1])
    assert.notStrictEqual(times[2], times[0])

    // 回复完成 → 时间跨度终点
    cap.updateRequest(p1, 'responseOut', '{"ok":true}')
    assert.strictEqual(entry.loop!.lastReplyAt, entry.timestamp + entry.durationMs!)
  })

  it('同轮重试：turn 不递增，turnTimes 刷新最后一项', async () => {
    const cap = new CaptureBuffer(100)
    const body = chatBody(['hi'])
    const p1 = cap.startRequest('proxy', 'openai', 'gpt-x', undefined, body)
    const t1 = cap.getAll()[0].loop!.turnTimes[0]

    await sleep(5)
    const p2 = cap.startRequest('proxy', 'openai', 'gpt-x', undefined, body)
    assert.strictEqual(p2, p1)
    const entry = cap.getAll()[0]
    assert.strictEqual(entry.loop!.turn, 1, '重试不递增轮数')
    assert.strictEqual(entry.loop!.turnTimes.length, 1)
    assert.notStrictEqual(entry.loop!.turnTimes[0], t1, 'turnTimes 最后一项刷新为新请求时间')
    assert.strictEqual(entry.loop!.messageTimes.length, 2)
  })

  it('无关请求开新 loop；无消息请求不参与归属', () => {
    const cap = new CaptureBuffer(100)
    const p1 = cap.startRequest('proxy', 'openai', 'gpt-x', undefined, chatBody(['任务 A']))
    const p2 = cap.startRequest('proxy', 'openai', 'gpt-x', undefined, chatBody(['任务 B']))
    assert.notStrictEqual(p1, p2)
    assert.ok(cap.getAll().every((e) => e.loop!.turn === 1))

    const p3 = cap.startRequest('proxy', 'openai', 'embed', undefined, JSON.stringify({ input: 'text' }))
    void p3
    const p4 = cap.startRequest('proxy', 'openai', 'raw', undefined, 'not-json')
    void p4
    // 非 JSON / 无消息条目照常入缓冲但无 loop
    assert.ok(cap.getAll().length >= 3)
    assert.ok(cap.getAll().filter((e) => !e.loop).length >= 1)
  })

  it('环形淘汰先落盘（persistFirst）', () => {
    // 用假 store 验证淘汰路径会立即 upsert
    const upserts: number[] = []
    const fakeStore = { upsert: (e: { pairId: number }) => upserts.push(e.pairId) } as any
    const cap = new CaptureBuffer(2, fakeStore)
    cap.startRequest('proxy', 'openai', 'm', undefined, chatBody(['a']))
    cap.startRequest('proxy', 'openai', 'm', undefined, chatBody(['b']))
    cap.startRequest('proxy', 'openai', 'm', undefined, chatBody(['c']))
    assert.strictEqual(cap.getAll().length, 2)
    assert.strictEqual(upserts.length, 1, '被淘汰的第 1 条应立即落盘')
  })

  it('disable 不再清空缓冲', () => {
    const cap = new CaptureBuffer(100)
    cap.startRequest('proxy', 'openai', 'm', undefined, chatBody(['hi']))
    cap.disable()
    assert.strictEqual(cap.getAll().length, 1)
  })

  it('restore 预载并重建归属索引，新轮次可接上来', () => {
    const cap1 = new CaptureBuffer(100)
    const body1 = chatBody(['历史任务'])
    cap1.startRequest('proxy', 'openai', 'gpt-x', undefined, body1)
    const entries = cap1.getAll()
    // 模拟持久化：给条目补上 requestIn
    for (const e of entries) e.requestIn = body1

    const cap2 = new CaptureBuffer(100)
    // 模拟旧版本持久化行：loop 无 uid/startedAt，restore 时应回填
    const legacy = structuredClone(entries).map((e) => {
      delete (e.loop as Record<string, unknown> | undefined)?.uid
      delete (e.loop as Record<string, unknown> | undefined)?.startedAt
      return e
    })
    cap2.restore(legacy)
    assert.strictEqual(cap2.getAll().length, 1)
    const restored = cap2.getAll()[0]
    assert.ok(restored.loop)
    assert.match(restored.loop.uid, /^[0-9a-f]{8}-/, '旧数据 restore 时回填 uid')
    assert.ok(restored.loop.startedAt != null, '旧数据 restore 时回填 startedAt')

    const turn2 = JSON.stringify({
      model: 'gpt-x',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '历史任务' },
        { role: 'assistant', content: '答' },
        { role: 'user', content: '重启后继续' },
      ],
    })
    const p2 = cap2.startRequest('proxy', 'openai', 'gpt-x', undefined, turn2)
    assert.strictEqual(p2, restored.pairId, '重启后第 2 轮应接上恢复的 loop')
    assert.strictEqual(cap2.getAll().length, 1)
    assert.strictEqual(cap2.getAll()[0].loop!.turn, 2)
  })

  it('接管时 SSE 只推同 pairId 的更新事件（无删除协议）', () => {
    const cap = new CaptureBuffer(100)
    const frames: string[] = []
    const sub = fakeRes()
    ;(sub as any).write = (s: string) => {
      frames.push(s)
      return true
    }
    cap.subscribe(sub)

    const p1 = cap.startRequest('proxy', 'openai', 'gpt-x', undefined, chatBody(['hi']))
    assert.strictEqual(frames.length, 1)
    cap.startRequest('proxy', 'openai', 'gpt-x', undefined, chatBody(['完全不同的任务']))
    assert.strictEqual(frames.length, 2)
    const p2 = cap.startRequest('proxy', 'openai', 'gpt-x', undefined, chatBody(['hi'], ['答']))
    void p2
    // 第 3 个请求与第 1 个不同序列 → 新 loop，又一条新条目事件
    assert.strictEqual(frames.length, 3)
    const parsed = JSON.parse(frames[2].replace(/^data: /, '').trim())
    assert.ok(parsed.pairId >= 1)
  })
})

describe('proxy/capture 数据维护', () => {
  const chatBody2 = (t: string): string => JSON.stringify({ model: 'm', messages: [{ role: 'user', content: t }] })

  it('cleanupOld：缓冲内旧条目被移除；无 store 时 collectOld 回退缓冲', async () => {
    const cap = new CaptureBuffer(100)
    const p1 = cap.startRequest('proxy', 'openai', 'm', undefined, chatBody2('旧任务'))
    const entry1 = cap.getAll()[0]
    // 人为把第 1 条拨回 10 天前
    ;(entry1 as { timestamp: number }).timestamp = Date.now() - 10 * 86_400_000
    entry1.loop!.startedAt = entry1.timestamp
    entry1.loop!.turnTimes = [entry1.timestamp]

    const p2 = cap.startRequest('proxy', 'openai', 'm', undefined, chatBody2('新任务'))
    assert.strictEqual(cap.getAll().length, 2)

    const collected = cap.collectOld(5)
    assert.deepStrictEqual(collected.map((e) => e.pairId), [p1])

    cap.cleanupOld(5)
    assert.strictEqual(cap.getAll().length, 1)
    assert.strictEqual(cap.getAll()[0].pairId, p2)
    void p1
  })

  it('cleanupOld 挂 store 时同步删除持久层', () => {
    const deleted: number[] = []
    const fakeStore = { cleanup: (d: number) => { deleted.push(d); return 3 } } as any
    const cap = new CaptureBuffer(100, fakeStore)
    cap.startRequest('proxy', 'openai', 'm', undefined, chatBody2('x'))
    const removed = cap.cleanupOld(30)
    assert.strictEqual(removed, 3)
    assert.strictEqual(cap.getAll().length, 1, '新条目不受影响')
  })
})
