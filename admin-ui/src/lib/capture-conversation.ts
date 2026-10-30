import type { CaptureEntry } from './capture'

/**
 * 轨迹视图的数据层 — 把一条抓包记录的请求体解析成「消息级对话」。
 *
 * 设计约定：
 * - 只处理 HTTP 请求体（requestOut 优先——那是模型真正收到的对话，解析失败回退 requestIn），
 *   不解析 SSE 流式响应；仅当响应体是完整 JSON（非流式）时把模型回复追加为最后一条消息。
 * - 兼容两种协议形态：chat-completions 的 `messages` 数组，以及
 *   openai-responses 的 `input` 数组（function_call / function_call_output / reasoning 等条目）。
 * - 每条消息保留自己的原始 payload（raw），供检查器单独查看，而不是整份请求。
 */

export type MessageContentType =
  | 'text'
  | 'multipart'
  | 'tool-call'
  | 'tool-result'
  | 'empty'
  | 'thinking'

export interface ConversationMessage {
  /** 1 起始的序号 */
  index: number
  role: string
  kind: 'message' | 'tool-call' | 'tool-result' | 'thinking'
  contentType: MessageContentType
  /** 单行预览（账本行） */
  text: string
  /** 可读完整文本（检查器概述） */
  fullText: string
  toolName?: string
  toolCallId?: string
  /** 该条消息自己的原始 payload */
  raw: unknown
  size: number
}

export interface Conversation {
  messages: ConversationMessage[]
  /** 对话解析自哪个阶段的请求体 */
  sourcePhase: 'requestOut' | 'requestIn'
}

const PREVIEW_MAX = 96

function tryParseBody(s: string | null): Record<string, unknown> | null {
  if (!s) return null
  try {
    const v: unknown = JSON.parse(s)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > PREVIEW_MAX ? t.slice(0, PREVIEW_MAX) + '…' : t
}

/** 单个 content block → 可读文本；图片/文件等非文本块用占位符。 */
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

function contentToText(content: unknown): { text: string; multipart: boolean } {
  if (content == null) return { text: '', multipart: false }
  if (typeof content === 'string') return { text: content, multipart: false }
  if (Array.isArray(content)) {
    return { text: content.map(partText).filter(Boolean).join('\n'), multipart: true }
  }
  return { text: String(content), multipart: false }
}

function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2)
  } catch {
    return args
  }
}

function sizeOf(raw: unknown): number {
  try {
    return JSON.stringify(raw)?.length ?? 0
  } catch {
    return 0
  }
}

function finalize(
  raw: unknown,
  base: Omit<ConversationMessage, 'index' | 'raw' | 'size'>,
): ConversationMessage {
  return { ...base, index: 0, raw, size: sizeOf(raw) }
}

function compact(list: Array<ConversationMessage | null>): ConversationMessage[] {
  return list.filter((m): m is ConversationMessage => m != null)
}

/** chat-completions 风格的消息（也覆盖 responses 里带 role 的 message 条目）。 */
function fromChatMessage(raw: unknown): ConversationMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const role = typeof m.role === 'string' && m.role ? m.role : 'unknown'

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

  const { text: contentText, multipart } = contentToText(m.content)

  if (role === 'tool' || role === 'function') {
    return finalize(raw, {
      role: 'tool',
      kind: 'tool-result',
      contentType: 'tool-result',
      text: contentText ? oneLine(contentText) : '(空)',
      fullText: contentText,
      toolCallId: typeof m.tool_call_id === 'string' ? m.tool_call_id : undefined,
    })
  }
  if (calls.length > 0) {
    return finalize(raw, {
      role,
      kind: 'tool-call',
      contentType: 'tool-call',
      text: `🔧 ${calls.map((c) => `${c.name}(${oneLine(c.args)})`).join(', ')}`,
      fullText: calls.map((c) => `${c.name}(${prettyArgs(c.args)})`).join('\n\n'),
      toolName: calls.map((c) => c.name).join(', '),
    })
  }
  return finalize(raw, {
    role,
    kind: 'message',
    contentType: multipart ? 'multipart' : contentText ? 'text' : 'empty',
    text: contentText ? oneLine(contentText) : '(空)',
    fullText: contentText,
  })
}

/** openai-responses 风格的 input/output 条目。 */
function fromResponsesItem(raw: unknown): ConversationMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  const type = typeof m.type === 'string' ? m.type : ''

  if (type === 'function_call') {
    const name = typeof m.name === 'string' ? m.name : 'unknown'
    const args = typeof m.arguments === 'string' ? m.arguments : ''
    return finalize(raw, {
      role: 'assistant',
      kind: 'tool-call',
      contentType: 'tool-call',
      text: `🔧 ${name}(${oneLine(args)})`,
      fullText: `${name}(${prettyArgs(args)})`,
      toolName: name,
      toolCallId: typeof m.call_id === 'string' ? m.call_id : undefined,
    })
  }
  if (type === 'function_call_output') {
    const { text } = contentToText(m.output)
    return finalize(raw, {
      role: 'tool',
      kind: 'tool-result',
      contentType: 'tool-result',
      text: text ? oneLine(text) : '(空)',
      fullText: text,
      toolCallId: typeof m.call_id === 'string' ? m.call_id : undefined,
    })
  }
  if (type.startsWith('reasoning')) {
    const { text } = contentToText(m.summary ?? m.content ?? m.text)
    return finalize(raw, {
      role: 'assistant',
      kind: 'thinking',
      contentType: 'thinking',
      text: text ? `🤔 ${oneLine(text)}` : '🤔 [思考]',
      fullText: text,
    })
  }
  const role = typeof m.role === 'string' && m.role ? m.role : type || 'unknown'
  const { text, multipart } = contentToText(m.content)
  return finalize(raw, {
    role,
    kind: 'message',
    contentType: multipart ? 'multipart' : text ? 'text' : 'empty',
    text: text ? oneLine(text) : '(空)',
    fullText: text,
  })
}

function fromAny(raw: unknown): ConversationMessage | null {
  if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).role === 'string') {
    return fromChatMessage(raw)
  }
  return fromResponsesItem(raw)
}

function hasItems(b: Record<string, unknown> | null): boolean {
  return !!b && (Array.isArray(b.messages) || Array.isArray(b.input) || typeof b.input === 'string')
}

/** 把一条抓包记录解析成消息级对话；无法提取出任何消息时返回 null。 */
export function parseConversation(entry: CaptureEntry): Conversation | null {
  const out = tryParseBody(entry.requestOut)
  const inc = tryParseBody(entry.requestIn)

  let body: Record<string, unknown>
  let sourcePhase: Conversation['sourcePhase']
  if (out && hasItems(out)) {
    body = out
    sourcePhase = 'requestOut'
  } else if (inc && hasItems(inc)) {
    body = inc
    sourcePhase = 'requestIn'
  } else {
    return null
  }

  const raws: unknown[] = []
  // responses 协议把系统提示放在顶层 instructions/system 字段
  for (const key of ['instructions', 'system'] as const) {
    if (typeof body[key] === 'string' && (body[key] as string).length > 0) {
      raws.push({ role: 'system', content: body[key] })
    }
  }
  if (Array.isArray(body.messages)) raws.push(...body.messages)
  else if (typeof body.input === 'string') raws.push({ role: 'user', content: body.input })
  else if (Array.isArray(body.input)) raws.push(...body.input)

  let messages = compact(raws.map(fromAny))

  // 追加模型回复：仅当响应体是完整 JSON（非流式）；SSE 流式文本解析失败则静默跳过
  const resp = tryParseBody(entry.responseOut)
  if (resp) {
    const replyRaws: unknown[] = []
    if (Array.isArray(resp.choices)) {
      const first = resp.choices[0] as Record<string, unknown> | undefined
      if (first && first.message != null) replyRaws.push(first.message)
    } else if (Array.isArray(resp.output)) {
      replyRaws.push(...resp.output)
    } else if (typeof resp.output_text === 'string' && resp.output_text) {
      replyRaws.push({ role: 'assistant', content: resp.output_text })
    }
    messages = [...messages, ...compact(replyRaws.map(fromAny))]
  }

  if (messages.length === 0) return null
  return {
    messages: messages.map((m, i) => ({ ...m, index: i + 1 })),
    sourcePhase,
  }
}
