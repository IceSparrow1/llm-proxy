import { createHash } from 'node:crypto'

/**
 * Agent-loop 归属识别。
 *
 * 原理：聊天补全 API 是无状态的，agent loop 的第 N+1 轮请求会把第 N 轮的
 * 完整消息历史原样重放（+ 上一轮回复 + tool_result）。把每条消息归一化后
 * 做链式哈希，只要旧对话的末位哈希出现在新请求的前缀链里，即可判定同一条
 * loop——这是协议语义保证的判据，不依赖任何 header 配合。
 *
 * 消息提取粒度与 admin-ui 的 capture-conversation.ts（requestIn 分支）保持
 * 一致，使 entry.loop.messageTimes 能按下标与轨迹视图的账本行对齐。
 */

export interface ConversationStep {
  role: string
  kind: 'message' | 'tool-call' | 'tool-result' | 'thinking'
  /** 归一化文本（图片/文件等非文本块用占位符，不哈希字节） */
  text: string
  toolName?: string
  toolCallId?: string
}

export interface StepHashes {
  /** prefixHashes[i] = 前 i+1 条消息的链式哈希 */
  prefixHashes: string[]
  /** 全部消息的链式哈希（= prefixHashes 末位）；无消息时 null */
  terminalHash: string | null
  /** 末尾 min(3, n) 条的链式哈希（上下文压缩兜底）；不足 1 条时 null */
  tailHash: string | null
}

/** 归属候选：缓冲区里一条已建立指纹的条目 */
export interface LoopCandidate {
  pairId: number
  terminalHash: string | null
  tailHash: string | null
  source: string
  lastActiveAt: number
}

export interface LoopMatch {
  pairId: number
  /** 前缀规则命中时 = 旧对话的消息数；tail 规则命中时为 0 */
  matchedSteps: number
  /** 同轮重试：新请求与旧对话完全一致 */
  retry: boolean
  rule: 'prefix' | 'tail'
}

const HASH_LEN = 16
/** 单条消息参与哈希的文本上限（超出部分只以总长度参与，避免大工具结果拖慢每轮哈希） */
const TEXT_HASH_CAP = 16 * 1024
/** tail 兜底匹配的消息条数 */
const TAIL_MATCH_STEPS = 3
/** tail 兜底的 loop 活跃窗口 */
export const TAIL_WINDOW_MS = 30 * 60_000

// ---------------------------------------------------------------------------
// 消息提取（与 capture-conversation.ts 的 requestIn 分支同粒度）
// ---------------------------------------------------------------------------

/** 单个 content block → 归一化文本；图片/文件等非文本块用占位符。 */
function partText(p: unknown): string {
  if (typeof p === 'string') return p
  if (!p || typeof p !== 'object') return ''
  const o = p as Record<string, unknown>
  const type = typeof o.type === 'string' ? o.type : ''
  if (type.includes('image') || o.image_url != null || o.image != null) return '[图片]'
  if (type === 'file' || o.file != null) return '[文件]'
  for (const k of ['text', 'input_text', 'output_text', 'content', 'refusal']) {
    if (typeof o[k] === 'string' && (o[k] as string).length > 0) return o[k] as string
  }
  return ''
}

function contentToText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(partText).filter(Boolean).join('\n')
  return String(content)
}

/** chat-completions 风格的消息（也覆盖 responses 里带 role 的条目）。 */
function fromChatMessage(m: Record<string, unknown>): ConversationStep {
  // fromRaw 调用前已保证 m.role 是 string
  const role = m.role as string
  const calls: Array<{ id?: string; name: string; args: string }> = []
  if (Array.isArray(m.tool_calls)) {
    for (const c of m.tool_calls) {
      const o = (c ?? {}) as Record<string, unknown>
      const fn = (o.function ?? {}) as Record<string, unknown>
      calls.push({
        id: typeof o.id === 'string' ? o.id : undefined,
        name: typeof fn.name === 'string' ? fn.name : 'unknown',
        args: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? ''),
      })
    }
  }

  const text = contentToText(m.content)
  if (role === 'tool' || role === 'function') {
    return {
      role: 'tool',
      kind: 'tool-result',
      text,
      toolCallId: typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined,
    }
  }
  if (calls.length > 0) {
    return {
      role,
      kind: 'tool-call',
      text: calls.map((c) => `${c.name}(${c.args})`).join(', '),
      toolName: calls.map((c) => c.name).join(', '),
      toolCallId: calls.map((c) => c.id).filter(Boolean).join(', ') || undefined,
    }
  }
  return { role, kind: 'message', text }
}

/** openai-responses 风格的 input 条目。 */
function fromResponsesItem(m: Record<string, unknown>): ConversationStep {
  const type = typeof m.type === 'string' ? m.type : ''
  if (type === 'function_call') {
    const name = typeof m.name === 'string' ? m.name : 'unknown'
    const args = typeof m.arguments === 'string' ? m.arguments : ''
    return {
      role: 'assistant',
      kind: 'tool-call',
      text: `${name}(${args})`,
      toolName: name,
      toolCallId: typeof m.call_id === 'string' ? m.call_id : undefined,
    }
  }
  if (type === 'function_call_output') {
    return {
      role: 'tool',
      kind: 'tool-result',
      text: contentToText(m.output),
      toolCallId: typeof m.call_id === 'string' ? m.call_id : undefined,
    }
  }
  if (type.startsWith('reasoning')) {
    return { role: 'assistant', kind: 'thinking', text: contentToText(m.summary ?? m.content ?? m.text) }
  }
  const role = typeof m.role === 'string' && m.role ? m.role : type || 'unknown'
  return { role, kind: 'message', text: contentToText(m.content) }
}

function fromRaw(raw: unknown): ConversationStep | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (typeof m.role === 'string') return fromChatMessage(m)
  return fromResponsesItem(m)
}

/**
 * 从请求体提取归一化消息序列。
 * 覆盖顶层 system/instructions + messages/input（input 字符串算 1 条），
 * 非对象条目丢弃——与前端账本的产出条数一致。
 */
export function extractConversationSteps(body: unknown): ConversationStep[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return []
  const b = body as Record<string, unknown>
  const raws: unknown[] = []
  for (const key of ['instructions', 'system'] as const) {
    if (typeof b[key] === 'string' && (b[key] as string).length > 0) {
      raws.push({ role: 'system', content: b[key] })
    }
  }
  if (Array.isArray(b.messages)) raws.push(...b.messages)
  else if (typeof b.input === 'string') raws.push({ role: 'user', content: b.input })
  else if (Array.isArray(b.input)) raws.push(...b.input)

  const steps: ConversationStep[] = []
  for (const raw of raws) {
    const step = fromRaw(raw)
    if (step) steps.push(step)
  }
  return steps
}

// ---------------------------------------------------------------------------
// 链式哈希
// ---------------------------------------------------------------------------

function stepBasis(s: ConversationStep): string {
  const text =
    s.text.length > TEXT_HASH_CAP ? `${s.text.length}:${s.text.slice(0, TEXT_HASH_CAP)}` : s.text
  return [s.kind, s.role, s.toolName ?? '', s.toolCallId ?? '', text].join('\u0000')
}

function chainHash(prev: string | null, basis: string): string {
  const h = createHash('sha256')
  if (prev) h.update(prev)
  h.update('\u0001')
  h.update(basis)
  return h.digest('hex').slice(0, HASH_LEN)
}

export function hashSteps(steps: ConversationStep[]): StepHashes {
  const prefixHashes: string[] = []
  let prev: string | null = null
  for (const s of steps) {
    prev = chainHash(prev, stepBasis(s))
    prefixHashes.push(prev)
  }
  let tailHash: string | null = null
  const tailStart = Math.max(0, steps.length - TAIL_MATCH_STEPS)
  for (let i = tailStart; i < steps.length; i++) {
    tailHash = chainHash(tailHash, stepBasis(steps[i]))
  }
  return { prefixHashes, terminalHash: prev, tailHash }
}

// ---------------------------------------------------------------------------
// 归属匹配
// ---------------------------------------------------------------------------

/**
 * 判定新请求归属哪条已有 loop。
 * 1. 前缀规则：旧 loop 的完整对话指纹出现在新请求前缀链中（匹配位置最深者胜，
 *    平手取最近活跃的）；指纹一致（含全部消息）视为同轮重试。
 * 2. tail 兜底：前缀断裂（上下文压缩/裁剪）但末尾 TAIL_MATCH_STEPS 条消息
 *    原样保留，且同 source、在活跃窗口内。
 */
export function matchLoop(
  hashes: StepHashes,
  candidates: LoopCandidate[],
  opts: { source: string; now: number; tailWindowMs?: number },
): LoopMatch | null {
  if (hashes.prefixHashes.length === 0) return null

  let best: { pairId: number; matchedSteps: number; retry: boolean; lastActiveAt: number } | null = null
  for (const c of candidates) {
    if (!c.terminalHash) continue
    const idx = hashes.prefixHashes.lastIndexOf(c.terminalHash)
    if (idx === -1) continue
    const better =
      !best ||
      idx > best.matchedSteps ||
      (idx === best.matchedSteps && c.lastActiveAt > best.lastActiveAt)
    if (better) {
      best = {
        pairId: c.pairId,
        matchedSteps: idx + 1,
        retry: idx === hashes.prefixHashes.length - 1,
        lastActiveAt: c.lastActiveAt,
      }
    }
  }
  if (best) {
    return { pairId: best.pairId, matchedSteps: best.matchedSteps, retry: best.retry, rule: 'prefix' }
  }

  // tail 兜底：只在对话足够长（tail 是严格子集）时启用，避免短对话整体撞车
  const tailWindowMs = opts.tailWindowMs ?? TAIL_WINDOW_MS
  if (hashes.tailHash && hashes.prefixHashes.length > TAIL_MATCH_STEPS) {
    let newest: LoopCandidate | null = null
    for (const c of candidates) {
      if (!c.tailHash || c.tailHash !== hashes.tailHash) continue
      if (c.source !== opts.source) continue
      if (opts.now - c.lastActiveAt > tailWindowMs) continue
      if (!newest || c.lastActiveAt > newest.lastActiveAt) newest = c
    }
    if (newest) {
      return { pairId: newest.pairId, matchedSteps: 0, retry: false, rule: 'tail' }
    }
  }
  return null
}

/**
 * 合并消息时间溯源：前缀规则命中时，匹配段继承旧时间（消息首次出现的请求
 * 时间），其余盖新请求时间；tail 兜底/新 loop 时全部盖新请求时间。
 */
export function mergeMessageTimes(
  prevTimes: number[],
  match: LoopMatch | null,
  now: number,
  stepCount: number,
): number[] {
  const times = new Array<number>(stepCount).fill(now)
  if (match?.rule === 'prefix') {
    const carry = Math.min(match.matchedSteps, prevTimes.length, stepCount)
    for (let i = 0; i < carry; i++) times[i] = prevTimes[i]
  }
  return times
}
