import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from '@appica/icons-react'
import JsonEditorPane from './JsonEditorPane'
import CopyButton from './CopyButton'
import SseFramesView from './SseFramesView'
import AggregatedResultView from './AggregatedResultView'
import { fmtChars, fmtSize, previewOf, type CaptureEntry } from '../lib/capture'
import { parseSseFrames, streamPhase } from '../lib/sse'
import {
  parseConversation,
  type ConversationMessage,
  type MessageContentType,
} from '../lib/capture-conversation'

type DetailTab = 'overview' | 'result' | 'payload' | 'frames'

/** 账本行 = 一条解析出的消息，或末尾的 SSE 流式响应原始报文。 */
interface LedgerRow {
  key: string
  index: string
  badge: string
  badgeCls: string
  preview: string
  mono: boolean
  sizeLabel: string
  message?: ConversationMessage
  streamRaw?: string
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * 轨迹视图 — 消息级 LLM 对话（对齐 deepseek-harness 轨迹的账本 + 检查器交互）：
 * 左侧为消息账本（独立滚动），把请求体解析成一条条 message（识别 role / content /
 * tool 调用与结果）；点击行后右侧出现该条消息的检查器（概述 / 它自己的 Payload），
 * 未选中时不展示。SSE 流式响应（无法按 JSON 解析的 responseIn）作为账本最后一行，
 * Payload 里按原始报文展示（同代理视图的 上游→代理 卡片）。
 */
export default function CaptureTrajectoryView({ entry }: { entry: CaptureEntry }) {
  const { t } = useTranslation()
  const conv = useMemo(() => parseConversation(entry), [entry])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [tab, setTab] = useState<DetailTab>('overview')

  // 切换条目时清空选中与 Tab。
  useEffect(() => {
    setSelectedKey(null)
    setTab('overview')
  }, [entry.pairId])

  if (!conv || conv.messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="text-[12px] text-muted-foreground">{t('admin.capture.parseFailedHint')}</p>
      </div>
    )
  }

  const rows: LedgerRow[] = conv.messages.map((m) => ({
    key: 'm' + m.index,
    index: '#' + m.index,
    badge: m.role,
    badgeCls: roleBadgeCls(m),
    preview: m.text,
    mono: m.kind !== 'message',
    sizeLabel: fmtChars(m.size),
    message: m,
  }))

  // SSE 流式响应：responseIn 存在但不是完整 JSON（流式增量文本）→ 账本末行原始展示
  const sseRaw = entry.responseIn
  if (sseRaw && tryParseJson(sseRaw) === null) {
    rows.push({
      key: 'sse',
      index: '#' + (conv.messages.length + 1),
      badge: '上游→代理',
      badgeCls: 'bg-success-soft text-success-emphasis',
      preview: previewOf(sseRaw, 80),
      mono: true,
      sizeLabel: fmtSize(sseRaw),
      streamRaw: sseRaw,
    })
  } else if (!sseRaw && entry.durationMs == null) {
    // 后端在流结束时才一次性写入 responseIn，进行中的条目以占位行提示
    rows.push({
      key: 'sse-pending',
      index: '#' + (conv.messages.length + 1),
      badge: '上游→代理',
      badgeCls: 'bg-background-muted text-muted-foreground',
      preview: t('admin.capture.streamPending'),
      mono: true,
      sizeLabel: '…',
    })
  }

  const selected = rows.find((r) => r.key === selectedKey) ?? null
  const selectedJson = selected?.message
    ? JSON.stringify(selected.message.raw, null, 2)
    : (selected?.streamRaw ?? null)
  // 流式进行中（后端按 1s 节流增量写入 responseIn）：默认展示原始报文，便于观察流是否停滞
  const streaming = entry.durationMs == null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 账本头：消息数 + 解析来源 */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-1.5 text-[10.5px] text-muted-foreground">
        <span>{t('admin.capture.msgCount', { count: conv.messages.length })}</span>
        <span className="font-mono">
          {t('admin.capture.parsedFrom')}{' '}
          {conv.sourcePhase === 'requestOut' ? '代理→上游' : '客户端→代理'}
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：消息账本（独立滚动） */}
        <div
          className="min-h-0 min-w-0 flex-1 overflow-y-auto"
          role="listbox"
          aria-label={t('admin.capture.viewTrajectory')}
        >
          {rows.map((r) => {
            const active = selected?.key === r.key
            return (
            <button
              type="button"
              key={r.key}
              role="option"
              aria-selected={active}
              disabled={!r.message && !r.streamRaw}
              onClick={() => {
                setSelectedKey(r.key)
                setTab(r.streamRaw ? (streaming ? 'payload' : 'result') : 'overview')
              }}
              className={
                'relative flex h-[34px] w-full items-center gap-2 border-b border-border/60 px-4 text-left transition-colors ' +
                (!r.message && !r.streamRaw
                  ? 'cursor-default opacity-60'
                  : 'cursor-pointer ' +
                    (active ? 'bg-background-muted' : 'hover:bg-background-subtle'))
              }
            >
                {/* 选中态左侧 3px 选中轨（dsh selectionRail） */}
                <span
                  aria-hidden
                  className={
                    'absolute inset-y-0 left-0 w-[3px] ' +
                    (active ? 'bg-primary-strong' : 'bg-transparent')
                  }
                />
                <span className="w-8 shrink-0 font-mono text-[10px] text-muted-foreground">
                  {r.index}
                </span>
                <span
                  className={
                    'inline-flex h-[19px] shrink-0 items-center rounded-sm px-1.5 text-[10px] font-semibold whitespace-nowrap ' +
                    r.badgeCls
                  }
                >
                  {r.badge}
                </span>
                <span
                  className={
                    'min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground ' +
                    (r.mono ? 'font-mono' : '')
                  }
                >
                  {r.preview}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {r.sizeLabel}
                </span>
              </button>
            )
          })}
        </div>

        {/* 右：选中项的检查器（未选中不展示） */}
        {selected && (
          <aside className="flex min-h-0 w-[45%] min-w-[340px] shrink-0 flex-col border-l border-border">
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-3">
              <TabBtn active={tab === 'overview'} onClick={() => setTab('overview')}>
                {t('admin.capture.overview')}
              </TabBtn>
              {selected.message ? (
                <TabBtn active={tab === 'payload'} onClick={() => setTab('payload')}>
                  {t('admin.capture.payload')}
                </TabBtn>
              ) : (
                <>
                  {!streaming && (
                    <TabBtn active={tab === 'result'} onClick={() => setTab('result')}>
                      {t('admin.capture.resultTab')}
                    </TabBtn>
                  )}
                  <TabBtn active={tab === 'frames'} onClick={() => setTab('frames')}>
                    {t('admin.capture.framesTab')}
                  </TabBtn>
                  <TabBtn active={tab === 'payload'} onClick={() => setTab('payload')}>
                    {t('admin.capture.rawTab')}
                  </TabBtn>
                </>
              )}
              <CopyButton text={selectedJson} label={t('admin.capture.copyRaw')} className="ms-auto" />
              <button
                type="button"
                onClick={() => setSelectedKey(null)}
                aria-label={t('admin.capture.deselect')}
                title={t('admin.capture.deselect')}
                className="ms-1 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              {tab === 'overview' ? (
                selected.message ? (
                  <MessageOverview msg={selected.message} />
                ) : (
                  <StreamOverview raw={selected.streamRaw ?? null} streaming={streaming} />
                )
              ) : tab === 'result' && selected.streamRaw && !streaming ? (
                <AggregatedResultView raw={selected.streamRaw} />
              ) : tab === 'frames' && selected.streamRaw ? (
                <SseFramesView raw={selected.streamRaw} />
              ) : (
                <div className="h-full">
                  <JsonEditorPane
                    data={selectedJson}
                    isStream={!!selected.streamRaw}
                  />
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  )
}

/** 消息概述：字段定义表 + 可读全文（内容区自适应高度，超出面板可视高度时内部滚动）。 */
function MessageOverview({ msg }: { msg: ConversationMessage }) {
  const { t } = useTranslation()
  return (
    <div className="flex h-full flex-col overflow-hidden px-4 py-3">
      <dl className="grid shrink-0 grid-cols-[92px_1fr] items-start gap-y-2 text-[11.5px]">
        <dt className="text-muted-foreground">{t('admin.capture.role')}</dt>
        <dd>
          <span
            className={
              'inline-flex h-[19px] items-center rounded-sm px-1.5 text-[10px] font-semibold ' +
              roleBadgeCls(msg)
            }
          >
            {msg.role}
          </span>
        </dd>

        <dt className="text-muted-foreground">{t('admin.capture.position')}</dt>
        <dd className="font-mono text-foreground">#{msg.index}</dd>

        {msg.toolName && (
          <>
            <dt className="text-muted-foreground">{t('admin.capture.name')}</dt>
            <dd className="break-all font-mono text-foreground">{msg.toolName}</dd>
          </>
        )}
        {msg.toolCallId && (
          <>
            <dt className="text-muted-foreground">{t('admin.capture.callId')}</dt>
            <dd className="break-all font-mono text-foreground">{msg.toolCallId}</dd>
          </>
        )}

        <dt className="text-muted-foreground">{t('admin.capture.contentType')}</dt>
        <dd className="text-foreground">{contentTypeLabel(msg.contentType, t)}</dd>

        <dt className="text-muted-foreground">{t('admin.capture.size')}</dt>
        <dd className="font-mono text-foreground">{fmtChars(msg.size)}</dd>
      </dl>

      {msg.fullText && (
        <div className="mt-3 flex min-h-0 flex-1 flex-col">
          <div className="mb-1 flex shrink-0 items-center gap-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('admin.capture.content')}
            </span>
            <CopyButton text={msg.fullText} label={t('admin.capture.copyRaw')} className="ms-auto" />
          </div>
          {/* 高度随内容自适应：内容不足时贴齐内容，超出面板剩余高度时收缩并内部滚动 */}
          <pre className="min-h-0 shrink overflow-auto rounded-md border border-border bg-background-subtle p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-all text-foreground">
            {msg.fullText}
          </pre>
        </div>
      )}
    </div>
  )
}

/** SSE 流式响应概述。 */
/** SSE 流式响应概述；流式进行中附实时统计（接收帧数 / 最后事件 / 阶段标签）。 */
function StreamOverview({ raw, streaming }: { raw: string | null; streaming: boolean }) {
  const { t } = useTranslation()
  const frames = useMemo(() => (raw ? parseSseFrames(raw) : []), [raw])
  const phase = streaming ? streamPhase(frames) : null
  const lastFrame = frames.length > 0 ? frames[frames.length - 1] : null
  return (
    <div className="px-4 py-3">
      <dl className="grid grid-cols-[92px_1fr] items-start gap-y-2 text-[11.5px]">
        <dt className="text-muted-foreground">{t('admin.capture.direction')}</dt>
        <dd className="font-semibold text-success-emphasis">上游→代理</dd>

        {streaming && (
          <>
            <dt className="text-muted-foreground">{t('admin.capture.phase')}</dt>
            <dd>
              <span
                className={
                  'inline-flex h-[19px] items-center rounded-sm px-1.5 text-[10px] font-semibold ' +
                  (phase === 'answering'
                    ? 'bg-primary-soft text-primary-strong'
                    : phase === 'tool'
                      ? 'bg-success-soft text-success-emphasis'
                      : 'bg-warning-soft text-warning-emphasis')
                }
              >
                {phase === 'answering'
                  ? t('admin.capture.tagAnswering')
                  : phase === 'tool'
                    ? t('admin.capture.tagToolCall')
                    : t('admin.capture.tagThinking')}
              </span>
            </dd>

            <dt className="text-muted-foreground">{t('admin.capture.eventsReceived')}</dt>
            <dd className="font-mono text-foreground">
              {t('admin.capture.framesCount', { count: frames.length })}
            </dd>

            <dt className="text-muted-foreground">{t('admin.capture.lastEvent')}</dt>
            <dd className="font-mono text-foreground">{lastFrame?.time ?? '—'}</dd>
          </>
        )}

        <dt className="text-muted-foreground">{t('admin.capture.contentType')}</dt>
        <dd className="text-foreground">{t('admin.capture.sseRaw')}</dd>

        <dt className="text-muted-foreground">{t('admin.capture.size')}</dt>
        <dd className="font-mono text-foreground">{fmtSize(raw)}</dd>
      </dl>
      <p className="mt-3 text-[11px] text-muted-foreground">{t('admin.capture.sseRawHint')}</p>
    </div>
  )
}

/** 角色徽标配色：user 绿 / assistant 蓝 / tool 琥珀 / 其余中性。 */
function roleBadgeCls(m: ConversationMessage): string {
  if (m.role === 'user') return 'bg-success-soft text-success-emphasis'
  if (m.role === 'assistant') return 'bg-primary-soft text-primary-strong'
  if (m.role === 'tool') return 'bg-warning-soft text-warning-emphasis'
  return 'bg-background-muted text-muted-foreground'
}

function contentTypeLabel(ct: MessageContentType, t: (k: string) => string): string {
  switch (ct) {
    case 'text':
      return t('admin.capture.ctText')
    case 'multipart':
      return t('admin.capture.ctMultipart')
    case 'tool-call':
      return t('admin.capture.ctToolCall')
    case 'tool-result':
      return t('admin.capture.ctToolResult')
    case 'thinking':
      return t('admin.capture.ctThinking')
    default:
      return t('admin.capture.ctEmpty')
  }
}

/** 检查器 Tab 按钮 — 底边框激活态（dsh 检查器 Tab 样式）。 */
function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        '-mb-px cursor-pointer border-b-2 px-2 py-1.5 text-[11px] transition-colors ' +
        (active
          ? 'border-primary-strong font-medium text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground')
      }
    >
      {children}
    </button>
  )
}
