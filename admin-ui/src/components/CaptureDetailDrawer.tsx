import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerBody } from '@appica/ui-react/drawer'
import CaptureProxyView from './CaptureProxyView'
import CaptureTrajectoryView from './CaptureTrajectoryView'
import { fmtDuration, fmtTime, type CaptureEntry } from '../lib/capture'

export type CaptureDetailMode = 'proxy' | 'trajectory'

export interface CaptureDetailDrawerProps {
  /** 当前展示的条目；null 表示抽屉关闭。关闭动画期间沿用最后一个非空条目。 */
  entry: CaptureEntry | null
  mode: CaptureDetailMode
  onModeChange: (mode: CaptureDetailMode) => void
  onClose: () => void
}

/**
 * 抓包详情抽屉 — 从右侧滑出（从右往左）展示单条请求详情。
 * 顶部 Tab 切换两种视图：轨迹模式（默认，消息级 LLM 对话，只解析请求体，
 * 进行中的请求也可查看）与代理模式（四阶段报文卡片）；头部含进行中/已完成
 * 徽标与元信息行。
 */
export default function CaptureDetailDrawer({ entry, mode, onModeChange, onClose }: CaptureDetailDrawerProps) {
  const { t } = useTranslation()

  // 关闭动画期间内容不能立刻消失：记住最后一个非空条目与模式。
  const lastEntryRef = useRef<CaptureEntry | null>(null)
  if (entry) lastEntryRef.current = entry
  const shown = entry ?? lastEntryRef.current

  // ESC 关闭由 Base UI Drawer 内置处理，这里只需同步 open 状态。
  const open = entry != null

  const finished = shown != null && shown.durationMs != null

  return (
    <Drawer side="right" open={open} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent className="sm:w-400 max-w-[95vw]" closeLabel={t('admin.common.close')}>
        <DrawerHeader className="gap-1.5 pe-12">
          <div className="flex items-center gap-2">
            <DrawerTitle className="text-[15px] font-semibold">
              {t('admin.capture.detailTitle', { id: shown?.id ?? '—' })}
            </DrawerTitle>
            <StatusBadge finished={finished} />
            <ModeSwitch mode={mode} onModeChange={onModeChange} />
          </div>
          {shown && <MetaLine entry={shown} />}
        </DrawerHeader>

        <DrawerBody className="min-h-0 overflow-hidden p-0">
          {shown &&
            (mode === 'proxy' ? (
              <CaptureProxyView entry={shown} />
            ) : (
              <CaptureTrajectoryView entry={shown} />
            ))}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  )
}

/** 进行中 / 已完成 徽标。 */
function StatusBadge({ finished }: { finished: boolean }) {
  const { t } = useTranslation()
  return (
    <span
      className={
        'inline-flex h-[19px] shrink-0 items-center gap-1 rounded-sm px-1.5 text-[10px] font-semibold ' +
        (finished
          ? 'bg-success-soft text-success-emphasis'
          : 'bg-warning-soft text-warning-emphasis')
      }
    >
      {!finished && <span className="relative flex size-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-warning-emphasis opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-warning-emphasis" />
      </span>}
      {finished ? t('admin.capture.statusDone') : t('admin.capture.statusRunning')}
    </span>
  )
}

/** 视图模式切换（轨迹模式 / 代理模式）。 */
function ModeSwitch({
  mode,
  onModeChange,
}: {
  mode: CaptureDetailMode
  onModeChange: (mode: CaptureDetailMode) => void
}) {
  const { t } = useTranslation()
  const base =
    'cursor-pointer rounded-[5px] px-2 py-1 text-[11px] font-medium transition-colors'
  return (
    <div className="ms-auto flex items-center gap-0.5 rounded-md border border-border bg-background-subtle p-0.5">
      <button
        type="button"
        onClick={() => onModeChange('trajectory')}
        aria-pressed={mode === 'trajectory'}
        className={
          base +
          ' ' +
          (mode === 'trajectory'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground')
        }
      >
        {t('admin.capture.viewTrajectory')}
      </button>
      <button
        type="button"
        onClick={() => onModeChange('proxy')}
        aria-pressed={mode === 'proxy'}
        className={
          base +
          ' ' +
          (mode === 'proxy'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground')
        }
      >
        {t('admin.capture.viewProxy')}
      </button>
    </div>
  )
}

/** 元信息行：时间 · 耗时 · 来源 · 入站 · 上游。 */
function MetaLine({ entry }: { entry: CaptureEntry }) {
  const { t } = useTranslation()
  const items: Array<{ label: string; value: string }> = [
    { label: t('admin.capture.time'), value: fmtTime(entry.timestamp) },
    { label: t('admin.capture.duration'), value: fmtDuration(entry.durationMs) },
    { label: t('admin.capture.sourceCol'), value: entry.source },
    { label: t('admin.capture.inboundProtocol'), value: `${entry.protocol} / ${entry.model}` },
    {
      label: t('admin.capture.upstreamProvider'),
      value: entry.upstreamProvider
        ? `${entry.upstreamProvider}${entry.upstreamProtocol ? ` (${entry.upstreamProtocol})` : ''}${entry.upstreamModel ? ` / ${entry.upstreamModel}` : ''}`
        : '—',
    },
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px]">
      {items.map((it) => (
        <span key={it.label} className="whitespace-nowrap">
          <span className="text-muted-foreground">{it.label}</span>{' '}
          <span className="font-mono text-foreground">{it.value}</span>
        </span>
      ))}
    </div>
  )
}
