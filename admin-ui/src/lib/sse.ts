/**
 * SSE 流式响应的帧级解析。
 *
 * 依据两类规范：
 * - WHATWG SSE 线协议（html.spec.whatwg.org §server-sent-events）：
 *   帧以空行分隔，字段 event:/data:/id:/retry:，data 多行以换行合并，
 *   默认事件名为 message，冒号开头为注释行。
 * - OpenAI 流式约定：
 *   - Chat Completions：仅 data: 行，data: [DONE] 哨兵结束，帧为
 *     chat.completion.chunk（choices[].delta 增量 / usage-only 尾帧）；
 *   - Responses API：data.type 携带事件类型（response.output_text.delta 等 60+ 种），
 *     线路上 event: 行与 data.type 双写。
 *
 * 本代理存储格式（stream-converter.ts）：帧 = `[HH:MM:SS.mmm] data: <json>`
 * （可选 event: 行），帧间以空行分隔。
 */

export type SseFrameCategory = 'delta' | 'lifecycle' | 'error' | 'done' | 'other'

export interface SseFrame {
  /** 1 起始序号 */
  index: number
  /** 代理捕获的时间戳前缀（如 20:55:45.662） */
  time?: string
  /** event: 行（上游显式给出时） */
  event?: string
  /** 展示用事件类型：event: 行 > data.type > chat chunk 推导 > [DONE] > message */
  type: string
  category: SseFrameCategory
  /** 原始 data 文本（多行已合并） */
  data: string
  /** data 为 JSON 时解析结果 */
  json: unknown
  size: number
}

const TIME_PREFIX = /^\[(\d{1,2}:\d{2}:\d{2}\.\d{3})\]\s?/

function categorize(type: string): SseFrameCategory {
  if (/error|failed/i.test(type)) return 'error'
  if (type === '[DONE]') return 'done'
  if (type.includes('delta')) return 'delta'
  if (/(created|in_progress|queued|added|started|ping|completed|done|part)$/.test(type)) {
    return 'lifecycle'
  }
  return 'other'
}

/** chat.completion.chunk 无 type 字段，按 delta / finish_reason / usage 推导展示类型。 */
function describeChatChunk(o: Record<string, unknown>): string {
  const choices = Array.isArray(o.choices) ? (o.choices as Array<Record<string, unknown>>) : []
  if (choices.length === 0 && o.usage != null) return 'chat.usage'
  const choice = choices[0]
  const delta =
    choice && typeof choice.delta === 'object' && choice.delta !== null
      ? (choice.delta as Record<string, unknown>)
      : null
  const finish =
    choice && typeof choice.finish_reason === 'string' ? choice.finish_reason : null
  if (finish) return `chat.finish(${finish})`
  if (delta) {
    if (Array.isArray(delta.tool_calls)) return 'chat.tool_calls_delta'
    if (typeof delta.reasoning_content === 'string') return 'chat.reasoning_delta'
    if (typeof delta.content === 'string') return 'chat.text_delta'
    if (typeof delta.role === 'string') return 'chat.role'
  }
  return 'chat.chunk'
}

function resolveType(
  event: string | undefined,
  json: unknown,
  data: string,
): string {
  if (data === '[DONE]') return '[DONE]'
  const o = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null
  if (o && typeof o.type === 'string' && o.type) return o.type
  if (event) return event
  if (o && o.object === 'chat.completion.chunk') return describeChatChunk(o)
  return 'message'
}

/** 把存储的 SSE 文本解析成帧列表；无法产生任何帧时返回空数组。 */
export function parseSseFrames(raw: string): SseFrame[] {
  if (!raw) return []
  const frames: SseFrame[] = []
  for (const block of raw.split(/\n{2,}/)) {
    if (!block.trim()) continue
    const lines = block.split('\n')
    const tm = TIME_PREFIX.exec(lines[0] ?? '')
    let time: string | undefined
    if (tm) {
      time = tm[1]
      lines[0] = (lines[0] ?? '').slice(tm[0].length)
    }
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
      // 其余（空行/注释行）按 WHATWG 规则忽略
    }
    if (dataLines.length === 0) continue
    const data = dataLines.join('\n')
    let json: unknown = null
    if (data !== '[DONE]') {
      try {
        json = JSON.parse(data)
      } catch {
        // 非 JSON 帧保留原文展示
      }
    }
    const type = resolveType(event, json, data)
    frames.push({
      index: frames.length + 1,
      time,
      event,
      type,
      category: categorize(type),
      data,
      json,
      size: data.length,
    })
  }
  return frames
}

/** 事件类型直方图（按出现次数降序）。 */
export function frameTypeHistogram(frames: SseFrame[]): Array<{ type: string; count: number }> {
  const m = new Map<string, number>()
  for (const f of frames) m.set(f.type, (m.get(f.type) ?? 0) + 1)
  return [...m.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
}

/** 流式阶段标签（取最后一帧有效事件倒推：思考 / 回答 / 工具调用）。 */
export function streamPhase(frames: SseFrame[]): 'thinking' | 'answering' | 'tool' | null {
  for (let i = frames.length - 1; i >= 0; i--) {
    const type = frames[i].type
    if (type.includes('reasoning')) return 'thinking'
    if (type.includes('output_text') || type.includes('text_delta')) return 'answering'
    if (type.includes('function_call') || type.includes('tool_calls')) return 'tool'
  }
  return null
}

/* ────────────────────────── 结果聚合 ────────────────────────── */

export interface AggregatedToolCall {
  key: string
  id?: string
  name: string
  arguments: string
}

/** 流式帧聚合出的「最终回复」：思考、输出文本、工具调用与结束状态。 */
export interface AggregatedStream {
  reasoning: string
  text: string
  refusal: string
  toolCalls: AggregatedToolCall[]
  /** chat 格式的 finish_reason */
  finishReason?: string
  /** responses 格式的 response.status（completed / incomplete / failed） */
  status?: string
  usage?: Record<string, unknown>
  error?: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * 把帧序列聚合成一次回复的最终样子（对齐 OpenAI 流式语义）：
 * - Responses API：*.delta 按到达顺序拼接（output_text / reasoning_text /
 *   reasoning_summary_text / refusal / function_call_arguments 按 item_id 归组），
 *   response.completed 的 response.output 作为缺帧兜底，usage 从中取；
 * - Chat Completions：delta.content / delta.reasoning_content 拼接，
 *   delta.tool_calls 按 index 归组累积 arguments，finish_reason 与 usage 取尾帧。
 */
export function aggregateSseFrames(frames: SseFrame[]): AggregatedStream {
  const out: AggregatedStream = { reasoning: '', text: '', refusal: '', toolCalls: [] }
  const tools = new Map<string, { id?: string; name: string; arguments: string }>()
  let toolSeq = 0
  const keyOf = (v: unknown, fallback: () => string | number): string | number =>
    typeof v === 'string' || typeof v === 'number' ? v : fallback()
  const tool = (key: string | number) => {
    const k = String(key)
    let acc = tools.get(k)
    if (!acc) {
      acc = { name: '', arguments: '' }
      tools.set(k, acc)
    }
    return acc
  }

  for (const f of frames) {
    const o =
      f.json && typeof f.json === 'object' && !Array.isArray(f.json)
        ? (f.json as Record<string, unknown>)
        : null
    if (!o) continue
    const type = typeof o.type === 'string' ? o.type : ''

    if (type === 'response.output_text.delta' || type === 'response_text.delta') {
      out.text += str(o.delta)
    } else if (
      type === 'response.reasoning_text.delta' ||
      type === 'response.reasoning_summary_text.delta'
    ) {
      out.reasoning += str(o.delta)
    } else if (type === 'response.refusal.delta') {
      out.refusal += str(o.delta)
    } else if (type === 'response.function_call_arguments.delta') {
      tool(keyOf(o.item_id, () => `#${++toolSeq}`)).arguments += str(o.delta)
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      const item = o.item as Record<string, unknown> | undefined
      if (item && item.type === 'function_call') {
        const acc = tool(keyOf(o.item_id ?? item.id, () => `#${++toolSeq}`))
        if (typeof item.name === 'string' && item.name) acc.name = item.name
        if (typeof item.call_id === 'string' && item.call_id) acc.id = item.call_id
        // output_item.done 携带完整参数，覆盖已累积的部分
        if (typeof item.arguments === 'string' && item.arguments) acc.arguments = item.arguments
      }
    } else if (
      type === 'response.completed' ||
      type === 'response.incomplete' ||
      type === 'response.failed'
    ) {
      const resp = o.response as Record<string, unknown> | undefined
      if (resp) {
        if (typeof resp.status === 'string' && resp.status) out.status = resp.status
        if (resp.usage && typeof resp.usage === 'object') {
          out.usage = resp.usage as Record<string, unknown>
        }
        // 兜底：若流中段 delta 缺失，从最终 output 聚合正文 / 工具调用 / 思考摘要
        const output = Array.isArray(resp.output) ? (resp.output as Array<Record<string, unknown>>) : []
        if (!out.text) {
          out.text = output
            .filter((it) => it.type === 'message')
            .flatMap((it) =>
              Array.isArray(it.content) ? (it.content as Array<Record<string, unknown>>) : [],
            )
            .filter((part) => part.type === 'output_text' || part.type === 'text')
            .map((part) => str(part.text))
            .filter(Boolean)
            .join('\n')
        }
        for (const it of output) {
          if (it.type === 'function_call') {
            const acc = tool(keyOf(it.id, () => `#${++toolSeq}`))
            if (!acc.name && typeof it.name === 'string') acc.name = it.name
            if (!acc.arguments && typeof it.arguments === 'string') acc.arguments = it.arguments
            if (typeof it.call_id === 'string') acc.id = it.call_id
          }
        }
        if (!out.reasoning) {
          out.reasoning = output
            .filter((it) => it.type === 'reasoning')
            .flatMap((it) =>
              Array.isArray(it.summary) ? (it.summary as Array<Record<string, unknown>>) : [],
            )
            .map((part) => str(part.text))
            .filter(Boolean)
            .join('\n')
        }
      }
      if (type === 'response.failed') {
        const err = o.error as Record<string, unknown> | undefined
        out.error = str(err?.message) || type
      }
    } else if (type === 'response.error') {
      const err = (o.error ?? o) as Record<string, unknown> | undefined
      out.error = str(err?.message) || type
    } else if (o.object === 'chat.completion.chunk') {
      if (o.usage && typeof o.usage === 'object') out.usage = o.usage as Record<string, unknown>
      const choices = Array.isArray(o.choices) ? (o.choices as Array<Record<string, unknown>>) : []
      const choice = choices[0]
      const delta =
        choice && typeof choice.delta === 'object' && choice.delta !== null
          ? (choice.delta as Record<string, unknown>)
          : null
      if (delta) {
        if (typeof delta.content === 'string') out.text += delta.content
        if (typeof delta.reasoning_content === 'string') out.reasoning += delta.reasoning_content
        if (typeof delta.refusal === 'string') out.refusal += delta.refusal
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            const fn = (tc.function ?? {}) as Record<string, unknown>
            const acc = tool(keyOf(tc.index, () => `#${++toolSeq}`))
            if (typeof tc.id === 'string' && tc.id) acc.id = tc.id
            if (typeof fn.name === 'string' && fn.name) acc.name = fn.name
            if (typeof fn.arguments === 'string') acc.arguments += fn.arguments
          }
        }
      }
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
        out.finishReason = choice.finish_reason
      }
    }
  }

  out.toolCalls = [...tools.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([key, acc]) => ({
      key,
      id: acc.id,
      name: acc.name || 'unknown',
      arguments: acc.arguments,
    }))
  return out
}
