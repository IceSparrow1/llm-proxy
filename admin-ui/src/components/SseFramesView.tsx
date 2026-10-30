import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import CopyButton from './CopyButton'
import { fmtChars } from '../lib/capture'
import { frameTypeHistogram, parseSseFrames, type SseFrame, type SseFrameCategory } from '../lib/sse'

/** 每页渲染的帧数（翻页浏览，避免一次性渲染数千帧）。 */
const PAGE_SIZE = 200

const CATEGORY_BADGE_CLS: Record<SseFrameCategory, string> = {
  delta: 'bg-primary-soft text-primary-strong',
  lifecycle: 'bg-success-soft text-success-emphasis',
  error: 'bg-error-soft text-error-emphasis',
  done: 'bg-warning-soft text-warning-emphasis',
  other: 'bg-background-muted text-muted-foreground',
}

/**
 * SSE 帧视图 — 把流式响应按 WHATWG SSE / OpenAI 流式约定解析成帧列表：
 * 每帧一行（序号 + 事件类型徽标 + 捕获时间 + data 预览 + 大小），点击展开该帧
 * 格式化后的 JSON；顶部类型直方图可按事件类型筛选。
 */
export default function SseFramesView({ raw }: { raw: string }) {
  const { t } = useTranslation()
  const frames = useMemo(() => parseSseFrames(raw), [raw])
  const [expanded, setExpanded] = useState<number | null>(null)
  const [filter, setFilter] = useState<string | null>(null)
  const [page, setPage] = useState(0)

  const histogram = useMemo(() => frameTypeHistogram(frames), [frames])

  // 切换筛选时回到第一页
  useEffect(() => {
    setPage(0)
  }, [filter])

  if (frames.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="text-[12px] text-muted-foreground">{t('admin.capture.sseNoFrames')}</p>
      </div>
    )
  }

  const filtered = filter ? frames.filter((f) => f.type === filter) : frames
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const visible = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 统计头：总帧数 + 类型直方图筛选 */}
      <div className="shrink-0 border-b border-border px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-1 text-[10px]">
          <span className="me-1 font-mono text-muted-foreground">
            {t('admin.capture.framesCount', { count: frames.length })}
          </span>
          <Chip active={filter === null} onClick={() => setFilter(null)}>
            {t('admin.capture.filterAll')}
          </Chip>
          {histogram.slice(0, 8).map(({ type, count }) => (
            <Chip key={type} active={filter === type} onClick={() => setFilter(filter === type ? null : type)}>
              <span className="font-mono">{type}</span>
              <span className="text-muted-foreground">×{count}</span>
            </Chip>
          ))}
          {histogram.length > 8 && (
            <span className="text-muted-foreground">+{histogram.length - 8}</span>
          )}
        </div>
      </div>

      {/* 帧列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {visible.map((f) => (
          <div key={f.index}>
            <FrameRow
              frame={f}
              active={expanded === f.index}
              onClick={() => setExpanded(expanded === f.index ? null : f.index)}
            />
            {expanded === f.index && <FrameDetail frame={f} />}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="py-8 text-center text-[11px] text-muted-foreground">
            {t('admin.capture.filterEmpty')}
          </div>
        )}
      </div>

      {/* 翻页 */}
      {totalPages > 1 && (
        <div className="flex shrink-0 items-center justify-between border-t border-border px-3 py-1.5 text-[10.5px]">
          <button
            type="button"
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
            className="cursor-pointer rounded-sm px-2 py-0.5 text-muted-foreground transition-colors hover:bg-background-subtle hover:text-foreground disabled:cursor-default disabled:opacity-40"
          >
            ‹ {t('admin.capture.pagePrev')}
          </button>
          <span className="font-mono text-muted-foreground">
            {t('admin.capture.pageInfo', { page: safePage + 1, total: totalPages })}
          </span>
          <button
            type="button"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage(safePage + 1)}
            className="cursor-pointer rounded-sm px-2 py-0.5 text-muted-foreground transition-colors hover:bg-background-subtle hover:text-foreground disabled:cursor-default disabled:opacity-40"
          >
            {t('admin.capture.pageNext')} ›
          </button>
        </div>
      )}
    </div>
  )
}

/** 帧行：单行摘要，点击展开。 */
function FrameRow({
  frame,
  active,
  onClick,
}: {
  frame: SseFrame
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'relative flex h-[30px] w-full cursor-pointer items-center gap-2 border-b border-border/60 px-3 text-left transition-colors ' +
        (active ? 'bg-background-muted' : 'hover:bg-background-subtle')
      }
    >
      <span
        aria-hidden
        className={
          'absolute inset-y-0 left-0 w-[3px] ' +
          (active ? 'bg-primary-strong' : 'bg-transparent')
        }
      />
      <span className="w-9 shrink-0 font-mono text-[10px] text-muted-foreground">
        #{frame.index}
      </span>
      <span
        className={
          'inline-flex h-[17px] max-w-44 shrink-0 items-center truncate rounded-sm px-1.5 text-[9.5px] font-semibold whitespace-nowrap ' +
          CATEGORY_BADGE_CLS[frame.category]
        }
        title={frame.type}
      >
        {frame.type}
      </span>
      {frame.time && (
        <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground">{frame.time}</span>
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
        {frame.data.slice(0, 90)}
        {frame.data.length > 90 ? '…' : ''}
      </span>
      <span className="shrink-0 font-mono text-[9.5px] text-muted-foreground">
        {fmtChars(frame.size)}
      </span>
    </button>
  )
}

/** 展开的单帧详情：格式化 JSON + 逐帧复制。 */
function FrameDetail({ frame }: { frame: SseFrame }) {
  const { t } = useTranslation()
  const pretty =
    frame.json != null
      ? JSON.stringify(frame.json, null, 2)
      : frame.data
  return (
    <div className="border-b border-border/60 bg-background-subtle px-3 py-2">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[10.5px] font-medium text-foreground">
          {t('admin.capture.frameData', { index: frame.index })}
        </span>
        {frame.event && (
          <span className="font-mono text-[9.5px] text-muted-foreground">event: {frame.event}</span>
        )}
        <CopyButton text={pretty} label={t('admin.capture.copyRaw')} className="ms-auto" />
      </div>
      <pre className="max-h-100 overflow-auto rounded-md border border-border bg-background p-2.5 font-mono text-[10px] leading-relaxed whitespace-pre-wrap break-all text-foreground">
        {pretty}
      </pre>
    </div>
  )
}

/** 筛选 chip。 */
function Chip({
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
      onClick={onClick}
      className={
        'inline-flex h-[18px] cursor-pointer items-center gap-1 rounded-sm border px-1.5 transition-colors ' +
        (active
          ? 'border-primary-strong bg-primary-soft text-primary-strong'
          : 'border-border bg-background text-muted-foreground hover:text-foreground')
      }
    >
      {children}
    </button>
  )
}
