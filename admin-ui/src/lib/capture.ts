/* ────────────────────────── 类型 / 常量 ────────────────────────── */

/** 后端 CaptureEntry（src/proxy/capture.ts）。 */
export interface CaptureEntry {
  id: number
  timestamp: number
  durationMs: number | null
  source: string
  protocol: string
  model: string
  pairId: number
  adapterName?: string
  upstreamProvider?: string
  upstreamProtocol?: string
  upstreamModel?: string
  requestIn: string | null
  requestOut: string | null
  responseIn: string | null
  responseOut: string | null
}

export type PhaseKey = 'requestIn' | 'requestOut' | 'responseIn' | 'responseOut'

/**
 * 四阶段定义（对齐旧版 capture.ts PHASES）。
 * 标签为旧版硬编码中文（locales 无对应 key，忠实迁移）；
 * 颜色由旧版 var(--success)/var(--accent) 映射到 Appica token 类。
 */
export const PHASES: Array<{ key: PhaseKey; label: string; cls: string; badgeCls: string; isStream: boolean }> = [
  {
    key: 'requestIn',
    label: '客户端→代理',
    cls: 'text-success-emphasis',
    badgeCls: 'bg-success-soft text-success-emphasis',
    isStream: false,
  },
  {
    key: 'requestOut',
    label: '代理→上游',
    cls: 'text-primary-strong',
    badgeCls: 'bg-primary-soft text-primary-strong',
    isStream: false,
  },
  {
    key: 'responseIn',
    label: '上游→代理',
    cls: 'text-success-emphasis',
    badgeCls: 'bg-success-soft text-success-emphasis',
    isStream: true,
  },
  {
    key: 'responseOut',
    label: '代理→客户端',
    cls: 'text-primary-strong',
    badgeCls: 'bg-primary-soft text-primary-strong',
    isStream: true,
  },
]

/* ────────────────────────── 工具 ────────────────────────── */

export function fmtTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`
}

export function fmtSize(s: string | null): string {
  if (!s) return '0B'
  const b = s.length
  if (b > 1024) return (b / 1024).toFixed(1) + 'KB'
  return b + 'B'
}

/** 格式化字符数（单条消息 payload 大小，近似字节数）。 */
export function fmtChars(n: number): string {
  if (!n) return '0B'
  if (n > 1024) return (n / 1024).toFixed(1) + 'KB'
  return n + 'B'
}

export function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = ((ms % 60_000) / 1000).toFixed(1)
  return `${minutes}m ${seconds}s`
}

/** 单行摘要：取首个非空行并截断（轨迹账本行内预览用）。 */
export function previewOf(data: string | null, max = 96): string {
  if (!data) return ''
  const line = data
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return ''
  return line.length > max ? line.slice(0, max) + '…' : line
}
