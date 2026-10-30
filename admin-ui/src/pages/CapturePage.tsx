import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@appica/ui-react/button'
import { Badge } from '@appica/ui-react/badge'
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@appica/ui-react/table'
import CaptureDetailDrawer, { type CaptureDetailMode } from '../components/CaptureDetailDrawer'
import { adminFetch } from '../lib/api'
import { useToast } from '../lib/toast'
import { fmtDuration, fmtSize, fmtTime, type CaptureEntry } from '../lib/capture'

interface StatusRes {
  success?: boolean
  data?: { enabled?: boolean }
}

const MAX_ENTRIES = 200

async function readSSE(
  response: Response,
  signal: AbortSignal,
  onMessage: (data: string) => void,
): Promise<void> {
  if (!response.ok) throw new Error(`SSE request failed: ${response.status}`)
  if (!response.body) throw new Error('SSE response body is unavailable')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // 在完整缓冲区上归一化，兼容 "\r" 与 "\n" 恰好落在两个网络分片的情况。
      buffer = buffer.replace(/\r\n/g, '\n')

      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) onMessage(data)
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/* ────────────────────────── 页面 ────────────────────────── */

/**
 * Capture 页 — 移植自旧版 capture.ts：
 * - 启动/暂停/结束抓包（后端控制 + SSE 连接生命周期）
 * - 来源过滤、条目列表（pairId 合并、上限 200）
 * - 点击行 / 操作按钮从右侧弹出详情抽屉：轨迹模式（消息级 LLM 对话，
 *   只解析请求体，进行中也可查看）与代理模式（四阶段报文卡片）
 */
export default function CapturePage() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [entries, setEntries] = useState<CaptureEntry[]>([])
  const [running, setRunning] = useState(false)
  const [sourceFilter, setSourceFilter] = useState('')
  /** 详情抽屉：条目 id + 视图模式；null 关闭。 */
  const [detail, setDetail] = useState<{ id: number; mode: CaptureDetailMode } | null>(null)
  // 行点击沿用上次使用的视图模式（首次为轨迹模式）。
  const lastModeRef = useRef<CaptureDetailMode>('trajectory')
  const abortRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  // 卸载标记：阻止 fetch/SSE 回调在卸载后 setState。
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  /** 调用后端抓包控制 API。 */
  const apiControl = useCallback(
    async (enabled: boolean, clear = false) => {
      try {
        const response = await adminFetch('/admin/debug/captures/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled, clear }),
        })
        if (!response.ok) throw new Error(`Capture control failed: ${response.status}`)
      } catch (err) {
        console.warn('[capture] 控制请求失败', err)
        toast(t('admin.common.requestFailed'), 'error')
      }
    },
    [t, toast],
  )

  /** 建立 SSE 连接 + 加载历史数据（不修改后端 enabled 状态）。 */
  const connectSSE = useCallback(() => {
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setRunning(true)
    setEntries([])
    setDetail(null)

    // 历史数据（可中止）
    adminFetch('/admin/debug/captures', { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Capture history failed: ${r.status}`)
        return r.json()
      })
      .then((d: { success?: boolean; data?: CaptureEntry[] }) => {
        if (d.success && mountedRef.current && !ac.signal.aborted) setEntries(d.data ?? [])
      })
      .catch((err) => {
        if (ac.signal.aborted) return
        console.warn('[capture] 历史数据加载失败', err)
        toast(t('admin.common.requestFailed'), 'error')
      })

    // 原生 EventSource 不支持自定义 Authorization 头，因此使用 fetch 读取 SSE 流。
    const handleMessage = (data: string) => {
      if (!mountedRef.current || ac.signal.aborted) return
      try {
        const entry = JSON.parse(data) as CaptureEntry
        setEntries((prev) => {
          const idx = prev.findIndex((e) => e.pairId === entry.pairId)
          if (idx >= 0) {
            const next = prev.slice()
            next[idx] = entry
            return next
          }
          const next = [...prev, entry]
          return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next
        })
      } catch (err) {
        // 上游夹杂非 JSON 帧：不丢弃连接，但必须可见（toast 8s 去重防刷屏）
        console.warn('[capture] SSE 消息解析失败', err)
        toast(t('admin.common.parseFailed'), 'warning')
      }
    }

    const stream = async () => {
      while (!ac.signal.aborted) {
        try {
          const response = await adminFetch('/admin/debug/captures/stream', {
            signal: ac.signal,
            headers: { Accept: 'text/event-stream' },
          })
          if (response.status === 401) {
            if (mountedRef.current) setRunning(false)
            throw new Error('Capture stream unauthorized')
          }
          await readSSE(response, ac.signal, handleMessage)
        } catch (err) {
          if (ac.signal.aborted) return
          console.warn('[capture] SSE 连接异常', err)
          toast(t('admin.common.requestFailed'), 'warning')
          if (err instanceof Error && err.message === 'Capture stream unauthorized') return
        }
        if (!ac.signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
    }
    void stream()
  }, [t, toast])

  // 进入页面：查询后端状态，已启用则自动连接；卸载时中止 fetch + 关闭 SSE。
  useEffect(() => {
    const ac = new AbortController()
    adminFetch('/admin/debug/captures/status', { signal: ac.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`Capture status failed: ${r.status}`)
        return r.json()
      })
      .then((d: StatusRes) => {
        if (d.success && d.data?.enabled) connectSSE()
      })
      .catch((err) => {
        if (ac.signal.aborted) return
        console.warn('[capture] 状态查询失败', err)
        toast(t('admin.common.requestFailed'), 'error')
      })
    return () => {
      ac.abort()
      abortRef.current?.abort()
    }
  }, [connectSSE, t, toast])

  /* ──── 控制按钮 ──── */

  const startCapture = () => {
    void apiControl(true, true) // 启用 + 清空缓存
    connectSSE()
  }

  /** 暂停：仅停用后端抓包，保留连接与数据（对齐旧版 stopCapture）。 */
  const pauseCapture = () => {
    void apiControl(false)
    setRunning(false)
    abortRef.current?.abort()
    abortRef.current = null
  }

  /** 结束：停用 + 清空后端缓存与本地数据（对齐旧版 endCapture）。 */
  const endCapture = () => {
    void apiControl(false, true)
    setRunning(false)
    abortRef.current?.abort()
    abortRef.current = null
    setEntries([])
    setDetail(null)
  }

  /* ──── 详情抽屉 ──── */

  const openDetail = (id: number, mode: CaptureDetailMode) => {
    lastModeRef.current = mode
    setDetail({ id, mode })
  }

  const changeMode = (mode: CaptureDetailMode) => {
    lastModeRef.current = mode
    setDetail((cur) => (cur ? { ...cur, mode } : cur))
  }

  const detailEntry = useMemo(
    () => (detail == null ? null : entries.find((e) => e.id === detail.id) ?? null),
    [entries, detail],
  )

  /* ──── 派生数据 ──── */

  const sources = useMemo(
    () => [...new Set(entries.map((e) => e.source))].sort(),
    [entries],
  )

  const filtered = useMemo(
    () => (sourceFilter ? entries.filter((e) => e.source === sourceFilter) : entries),
    [entries, sourceFilter],
  )

  /* ──── 渲染 ──── */

  return (
    <div className="flex flex-col gap-4 p-6">
      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="me-1 text-[15px] font-semibold text-foreground">{t('admin.capture.title')}</h3>

        {!running ? (
          <Button variant="primary" size="sm" onClick={startCapture}>
            {t('admin.capture.start')}
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={pauseCapture}>
              {t('admin.capture.pause')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-error-emphasis hover:bg-error-soft"
              onClick={endCapture}
            >
              {t('admin.capture.stop')}
            </Button>
          </>
        )}

        {running && (
          <Badge variant="success" size="sm">
            ●
          </Badge>
        )}

        <span className="text-[11px] text-muted-foreground">
          {t('admin.capture.entryCount', { count: filtered.length })}
        </span>

        <div className="mx-1 h-4 w-px bg-border" />

        {/* 来源过滤 */}
        <span className="text-[11px] text-muted-foreground">{t('admin.capture.source')}</span>
        <Button
          variant={sourceFilter === '' ? 'soft' : 'ghost'}
          size="sm"
          onClick={() => setSourceFilter('')}
        >
          {t('admin.capture.filterAll')}
        </Button>
        {sources.map((s) => (
          <Button
            key={s}
            variant={sourceFilter === s ? 'soft' : 'ghost'}
            size="sm"
            onClick={() => setSourceFilter(s)}
          >
            {s}
          </Button>
        ))}
      </div>

      {/* 条目列表 */}
      <div className="max-h-[60vh] overflow-auto rounded-md">
        <Table size="sm" hoverableRows>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead className="w-40">{t('admin.capture.time')}</TableHead>
              <TableHead className="text-end">{t('admin.capture.duration')}</TableHead>
              <TableHead>{t('admin.capture.sourceCol')}</TableHead>
              <TableHead>{t('admin.capture.adapter')}</TableHead>
              <TableHead>{t('admin.capture.inboundProtocol')}</TableHead>
              <TableHead>{t('admin.capture.inboundModel')}</TableHead>
              <TableHead>{t('admin.capture.upstreamProvider')}</TableHead>
              <TableHead>{t('admin.capture.upstreamProtocol')}</TableHead>
              <TableHead>{t('admin.capture.upstreamModel')}</TableHead>
              <TableHead className="text-end">{t('admin.capture.requestSize')}</TableHead>
              <TableHead className="text-end">{t('admin.capture.responseSize')}</TableHead>
              <TableHead className="text-end">{t('admin.capture.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((e) => (
              <TableRow
                key={e.id}
                onClick={() => openDetail(e.id, lastModeRef.current)}
                className="cursor-pointer"
              >
                <TableCell className="font-mono text-[11px] text-muted-foreground">{e.id}</TableCell>
                <TableCell className="font-mono text-[10.5px] whitespace-nowrap text-muted-foreground">
                  {fmtTime(e.timestamp)}
                </TableCell>
                <TableCell className="text-end font-mono text-[10.5px] whitespace-nowrap text-muted-foreground">
                  {fmtDuration(e.durationMs)}
                </TableCell>
                <TableCell className="text-[11.5px] text-foreground">{e.source}</TableCell>
                <TableCell className="text-[11.5px] text-muted-foreground">{e.adapterName || '—'}</TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">{e.protocol}</TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">{e.model}</TableCell>
                <TableCell className="text-[11.5px] text-muted-foreground">{e.upstreamProvider || '—'}</TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">
                  {e.upstreamProtocol || '—'}
                </TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground">
                  {e.upstreamModel || '—'}
                </TableCell>
                <TableCell className="text-end font-mono text-[10.5px] whitespace-nowrap">
                  <span className="text-success-emphasis">{fmtSize(e.requestIn)}</span>
                  <span className="text-muted-foreground"> / </span>
                  <span className="text-primary-strong">{fmtSize(e.requestOut)}</span>
                </TableCell>
                <TableCell className="text-end font-mono text-[10.5px] whitespace-nowrap">
                  <span className="text-success-emphasis">{fmtSize(e.responseIn)}</span>
                  <span className="text-muted-foreground"> / </span>
                  <span className="text-primary-strong">{fmtSize(e.responseOut)}</span>
                </TableCell>
                <TableCell onClick={(ev) => ev.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                    <Button
                      variant="soft"
                      size="sm"
                      className="bg-primary-soft text-primary-strong"
                      onClick={() => openDetail(e.id, 'proxy')}
                    >
                      {t('admin.capture.viewProxy')}
                    </Button>
                    <Button
                      variant="soft"
                      size="sm"
                      className="bg-secondary-soft text-secondary-emphasis"
                      onClick={() => openDetail(e.id, 'trajectory')}
                    >
                      {t('admin.capture.viewTrajectory')}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}

            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={13} className="py-12 text-center text-[13px] text-muted-foreground">
                  {t('admin.capture.empty')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* 详情抽屉：从右往左滑出，展示选中请求详情 */}
      <CaptureDetailDrawer
        entry={detailEntry}
        mode={detail?.mode ?? 'proxy'}
        onModeChange={changeMode}
        onClose={() => setDetail(null)}
      />
    </div>
  )
}
