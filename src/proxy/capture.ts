import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { CaptureStore } from './capture-store.js'
import {
  extractConversationSteps,
  hashSteps,
  matchLoop,
  mergeMessageTimes,
  TAIL_WINDOW_MS,
  type LoopMatch,
  type StepHashes,
} from './attribution.js'

export interface CaptureMeta {
  /** 适配器名称（仅适配器请求） */
  adapterName?: string
  /** 上游供应商名称，如 "deepseek" */
  upstreamProvider?: string
  /** 上游供应商协议，如 "openai" */
  upstreamProtocol?: string
  /** 上游供应商模型 ID，如 "deepseek-chat" */
  upstreamModel?: string
}

/** agent-loop 归属信息（存在即表示该条目属于某条 loop 的最新一轮） */
export interface CaptureLoopInfo {
  /** loop 首轮的 pairId（= 本条目 pairId） */
  loopId: number
  /** loop 唯一锚点（uuid v4），供消息定位与跨重启引用 */
  uid: string
  /** 当前是第几轮（1 起始；同轮重试不递增） */
  turn: number
  /** 首轮请求时间（epoch ms） */
  startedAt: number
  /** 每轮请求时间（epoch ms），长度 = 轮数 */
  turnTimes: number[]
  /** 当前 requestIn 每条消息的归属时间（首次出现的请求时间），与消息序列对齐 */
  messageTimes: number[]
  /** 最近一次模型回复完成的时间（epoch ms）；loop 进行中时为上一轮的完成时间 */
  lastReplyAt?: number
}

export interface CaptureEntry extends CaptureMeta {
  id: number
  timestamp: number
  /** 从创建抓包记录到响应完整写回客户端的耗时（毫秒） */
  durationMs: number | null
  /** 来源：proxy（代理入口）或适配器名称 */
  source: string
  /** 代理端协议 */
  protocol: string
  /** 代理端模型 */
  model: string
  pairId: number
  /** 客户端→代理（原始请求） */
  requestIn: string | null
  /** 代理→上游（转换后请求） */
  requestOut: string | null
  /** 上游→代理（原始响应） */
  responseIn: string | null
  /** 代理→客户端（转换后响应） */
  responseOut: string | null
  /** agent-loop 归属（同 loop 只保留最新一轮） */
  loop?: CaptureLoopInfo
}

/** 归属判定的中间结果 */
interface AttributionResult {
  match: LoopMatch | null
  stepCount: number
  hashes: StepHashes
}

/** 持久化防抖周期（毫秒） */
const PERSIST_DEBOUNCE_MS = 2000

export class CaptureBuffer {
  private buffer: CaptureEntry[] = []
  private nextId = 1
  private nextPairId = 1
  private maxSize: number
  /**
   * 抓包 SSE 订阅者集合。
   * 使用 Map<ServerResponse, { lastSeen }> 跟踪每个订阅者的最近活跃时间，
   * 以便后续 pruneStaleSubscribers() 主动剔除长时间无活动的死连接。
   */
  private subscribers: Map<ServerResponse, { lastSeen: number }> = new Map()
  /** 订阅者空闲超时（毫秒）——超过此时长无活动则从集合中移除 */
  private subscriberIdleTimeoutMs = 60_000
  /** 定期清理周期（毫秒） */
  private subscriberPruneIntervalMs = 30_000
  private pruneTimer: NodeJS.Timeout | null = null
  /** pairId → CaptureEntry 的快速索引 */
  private entryMap: Map<number, CaptureEntry> = new Map()
  /** pairId → loop 指纹（只有成功提取出消息序列的条目才有） */
  private loopIndex: Map<number, { terminalHash: string | null; tailHash: string | null }> = new Map()
  /** 可选持久层；挂上后条目变更会防抖落盘 */
  private store: CaptureStore | null
  /** 待落盘的 pairId 集合 */
  private dirty: Set<number> = new Set()
  private flushTimer: NodeJS.Timeout | null = null
  private _enabled = false

  constructor(maxSize = 100, store?: CaptureStore | null) {
    this.maxSize = maxSize
    this.store = store ?? null
    // 启动定期清理定时器（unref 不阻止进程退出）
    this.pruneTimer = setInterval(() => this.pruneStaleSubscribers(), this.subscriberPruneIntervalMs)
    if (typeof this.pruneTimer.unref === 'function') this.pruneTimer.unref()
  }

  isEnabled(): boolean {
    return this._enabled
  }

  enable(): void {
    this._enabled = true
  }

  /** 暂停抓包。不清空缓冲——清空只由显式 clear()（控制端点 clear:true）触发。 */
  disable(): void {
    this._enabled = false
  }

  /** 更新缓冲区上限，并立即淘汰超出的旧记录。 */
  setMaxSize(maxSize: number): void {
    this.maxSize = Math.max(1, Math.floor(maxSize))
    if (this.buffer.length <= this.maxSize) return
    const removed = this.buffer.splice(0, this.buffer.length - this.maxSize)
    for (const entry of removed) {
      this.removeEntry(entry.pairId, true)
    }
  }

  /** 设置持久层保留上限（透传给 store 并立即 prune） */
  setPersistMax(max: number): void {
    this.store?.setMax(max)
  }

  clear(): void {
    this.buffer = []
    this.entryMap.clear()
    this.loopIndex.clear()
    this.dirty.clear()
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.store?.clear()
  }

  /**
   * 创建一条新请求的抓包记录，返回 pairId。
   * 传入 rawBody（vision 替换前的客户端原始请求体）时先做 agent-loop 归属：
   * 命中已有 loop 则接管旧条目的 pairId/id（前端按 pairId 原地更新，无需删除
   * 协议），同一 loop 在缓冲与持久层都只保留最新一轮。
   */
  startRequest(
    source: string,
    protocol: string,
    model: string,
    meta?: CaptureMeta,
    rawBody?: string
  ): number {
    const now = Date.now()
    const attr = rawBody ? this.attributeRequest(source, rawBody, now) : null

    let pairId: number
    let id: number
    let loop: CaptureLoopInfo | undefined
    if (attr?.match) {
      // 接管：移除旧条目腾出槽位，复用其 pairId/id
      const old = this.entryMap.get(attr.match.pairId)
      if (old) this.removeEntry(old.pairId)
      pairId = attr.match.pairId
      id = old?.id ?? this.nextId++
      const oldLoop = old?.loop
      const retry = attr.match.retry && oldLoop != null
      loop = {
        loopId: pairId,
        uid: oldLoop?.uid ?? randomUUID(),
        turn: oldLoop ? (retry ? oldLoop.turn : oldLoop.turn + 1) : 1,
        startedAt: oldLoop?.startedAt ?? now,
        turnTimes: oldLoop
          ? (retry ? [...oldLoop.turnTimes.slice(0, -1), now] : [...oldLoop.turnTimes, now])
          : [now],
        messageTimes: mergeMessageTimes(oldLoop?.messageTimes ?? [], attr.match, now, attr.stepCount),
        lastReplyAt: oldLoop?.lastReplyAt,
      }
    } else {
      pairId = this.nextPairId++
      id = this.nextId++
      if (attr) {
        loop = {
          loopId: pairId,
          uid: randomUUID(),
          turn: 1,
          startedAt: now,
          turnTimes: [now],
          messageTimes: new Array<number>(attr.stepCount).fill(now),
        }
      }
    }

    const entry: CaptureEntry = {
      id,
      timestamp: now,
      durationMs: null,
      source,
      protocol,
      model,
      pairId,
      requestIn: null,
      requestOut: null,
      responseIn: null,
      responseOut: null,
      ...meta,
      ...(loop ? { loop } : {}),
    }
    this.buffer.push(entry)
    this.entryMap.set(pairId, entry)
    if (attr) {
      this.loopIndex.set(pairId, { terminalHash: attr.hashes.terminalHash, tailHash: attr.hashes.tailHash })
    }
    if (this.buffer.length > this.maxSize) {
      const removed = this.buffer.splice(0, this.buffer.length - this.maxSize)
      for (const r of removed) {
        this.removeEntry(r.pairId, true)
      }
    }
    this.markDirty(pairId)
    this.notifySubscribers(entry)
    return pairId
  }

  /** 更新已有记录某个阶段的数据 */
  updateRequest(
    pairId: number,
    field: 'requestIn' | 'requestOut' | 'responseIn' | 'responseOut',
    data: string
  ): void {
    const entry = this.entryMap.get(pairId)
    if (!entry) return
    entry[field] = data
    if (field === 'responseOut') {
      entry.durationMs = Math.max(0, Date.now() - entry.timestamp)
      // loop 时间跨度终点：最近一次模型回复完成时间
      if (entry.loop) entry.loop.lastReplyAt = entry.timestamp + entry.durationMs
    }
    // 流式 responseIn 按 1s 节流高频写入，不标记落盘（完成时的 responseOut 会带上最终值）
    if (field === 'requestOut' || field === 'responseOut') {
      this.markDirty(pairId)
    }
    this.notifySubscribers(entry)
  }

  getAll(): CaptureEntry[] {
    return [...this.buffer]
  }

  /**
   * 启动时从持久层预载历史记录，并重建归属索引。
   * 传入的 entries 按时间升序（旧 → 新）。
   */
  restore(entries: CaptureEntry[]): void {
    for (const entry of entries) {
      this.buffer.push(entry)
      this.entryMap.set(entry.pairId, entry)
      if (entry.id >= this.nextId) this.nextId = entry.id + 1
      if (entry.pairId >= this.nextPairId) this.nextPairId = entry.pairId + 1
      // 旧版本持久化行没有 uid/startedAt：回填并落盘
      if (entry.loop && !entry.loop.uid) {
        entry.loop.uid = randomUUID()
        entry.loop.startedAt ??= entry.loop.turnTimes[0] ?? entry.timestamp
        this.markDirty(entry.pairId)
      }
      this.reindexLoop(entry)
      if (this.buffer.length > this.maxSize) {
        const removed = this.buffer.splice(0, this.buffer.length - this.maxSize)
        for (const r of removed) this.removeEntry(r.pairId)
      }
    }
  }

  /** 对一条已有条目重建 loop 指纹索引（restore 后调用） */
  private reindexLoop(entry: CaptureEntry): void {
    if (!entry.loop || !entry.requestIn) return
    let body: unknown
    try {
      body = JSON.parse(entry.requestIn)
    } catch {
      return
    }
    const steps = extractConversationSteps(body)
    if (steps.length === 0) return
    const hashes = hashSteps(steps)
    this.loopIndex.set(entry.pairId, { terminalHash: hashes.terminalHash, tailHash: hashes.tailHash })
  }

  /**
   * agent-loop 归属判定：提取消息序列 → 链式哈希 → 与缓冲区中已有指纹匹配。
   * 提取不出消息序列（非对话请求）时返回 null，该条目不参与归属。
   */
  private attributeRequest(source: string, rawBody: string, now: number): AttributionResult | null {
    let body: unknown
    try {
      body = JSON.parse(rawBody)
    } catch {
      return null
    }
    const steps = extractConversationSteps(body)
    if (steps.length === 0) return null
    const hashes = hashSteps(steps)
    const candidates = []
    for (const e of this.buffer) {
      const fp = this.loopIndex.get(e.pairId)
      if (fp) {
        candidates.push({ pairId: e.pairId, ...fp, source: e.source, lastActiveAt: e.timestamp })
      }
    }
    const match = matchLoop(hashes, candidates, { source, now, tailWindowMs: TAIL_WINDOW_MS })
    return { match, stepCount: steps.length, hashes }
  }

  /**
   * 从缓冲、快速索引、指纹索引中移除一条记录。
   * persistFirst = true 时（环形淘汰）先把未落盘的变更写入持久层，
   * 避免 2s 防抖窗口内被挤出缓冲的记录永久丢失。
   */
  private removeEntry(pairId: number, persistFirst = false): void {
    if (persistFirst && this.store && this.dirty.delete(pairId)) {
      const entry = this.entryMap.get(pairId)
      if (entry) this.store.upsert(entry)
    }
    const idx = this.buffer.findIndex((e) => e.pairId === pairId)
    if (idx !== -1) this.buffer.splice(idx, 1)
    this.entryMap.delete(pairId)
    this.loopIndex.delete(pairId)
    this.dirty.delete(pairId)
  }

  /** 标记待落盘并调度防抖 flush */
  private markDirty(pairId: number): void {
    if (!this.store) return
    this.dirty.add(pairId)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flushPersist()
    }, PERSIST_DEBOUNCE_MS)
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref()
  }

  /** 立即把待落盘条目写入持久层（关停时调用） */
  flushPersist(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.store || this.dirty.size === 0) return
    for (const pairId of this.dirty) {
      const entry = this.entryMap.get(pairId)
      if (entry) this.store.upsert(entry)
    }
    this.dirty.clear()
  }

  subscribe(res: ServerResponse): void {
    this.subscribers.set(res, { lastSeen: Date.now() })
    // 'close' 事件不可靠（客户端 kill -9 / NAT 超时 / 反代断开等都不会触发），
    // 所以同时在写入时主动检测并清理死连接。
    res.on('close', () => this.subscribers.delete(res))
  }

  /** 主动清理已死亡/被销毁的 subscriber，防止句柄 + 内部 buffer 泄漏 */
  private pruneDeadSubscribers(): void {
    for (const sub of this.subscribers.keys()) {
      // 仅当属性显式表示死亡/不可写时才清理；undefined 视为可用（兼容测试 mock）
      const s = sub as { destroyed?: boolean; writableEnded?: boolean; writable?: boolean }
      if (s.destroyed === true || s.writableEnded === true || s.writable === false) {
        this.subscribers.delete(sub)
      }
    }
  }

  /**
   * 清理长时间无活动的 subscriber。
   * close 事件不可靠，部分场景（如反代超时中断、NAT 重建）下永远不会触发。
   * 定期清理可保证即使完全静默断开也能被回收，避免句柄和缓冲区累积泄漏。
   */
  private pruneStaleSubscribers(): void {
    const now = Date.now()
    for (const [sub, meta] of this.subscribers) {
      const s = sub as { destroyed?: boolean; writableEnded?: boolean; writable?: boolean }
      const dead = s.destroyed === true || s.writableEnded === true || s.writable === false
      if (dead || now - meta.lastSeen > this.subscriberIdleTimeoutMs) {
        this.subscribers.delete(sub)
      }
    }
  }

  private isSubDead(sub: ServerResponse): boolean {
    const s = sub as { destroyed?: boolean; writableEnded?: boolean; writable?: boolean }
    return s.destroyed === true || s.writableEnded === true || s.writable === false
  }

  private notifySubscribers(entry: CaptureEntry): void {
    if (this.subscribers.size === 0) return
    this.pruneDeadSubscribers()
    if (this.subscribers.size === 0) return

    const line = JSON.stringify(entry)
    const payload = `data: ${line}\n\n`
    const now = Date.now()
    for (const [sub, meta] of this.subscribers) {
      try {
        // 写入前再检查一次（并发场景下 close 可能刚发生）
        if (this.isSubDead(sub)) {
          this.subscribers.delete(sub)
          continue
        }
        // 反压时跳过本次写入，避免 Node 内部 _writableState.buffer 无限膨胀；
        // 后续 notify 时若客户端已消费完会自然恢复。
        if (!sub.write(payload)) {
          // do nothing
        }
        meta.lastSeen = now
      } catch {
        this.subscribers.delete(sub)
      }
    }
  }

  /** 释放定时器等资源（测试用） */
  destroy(): void {
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer)
      this.pruneTimer = null
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.subscribers.clear()
  }
}
