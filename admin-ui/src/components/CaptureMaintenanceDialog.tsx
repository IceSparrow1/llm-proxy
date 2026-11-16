import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@appica/ui-react/dialog'
import { Button } from '@appica/ui-react/button'
import { Input } from '@appica/ui-react/input'
import { adminFetch } from '../lib/api'

export type CaptureMaintMode = 'cleanup' | 'backup'

export interface CaptureMaintenanceDialogProps {
  open: boolean
  mode: CaptureMaintMode
  onClose: () => void
  /** 操作成功后的结果提示（由调用方 toast） */
  onDone: (message: string) => void
}

function defaultBackupName(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `llm-proxy-captures-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`
}

/**
 * 抓包数据维护弹窗 — 清理 / 备份 二合一：
 * - cleanup：输入天数，删除 N 天之前的数据（内存缓冲 + 持久层），不可恢复
 * - backup：输入天数 + 保存路径 + 文件名，把 N 天之前的数据按 loop 导出 JSONL
 *   并压缩成 zip（服务端写入本地路径）
 */
export default function CaptureMaintenanceDialog({ open, mode, onClose, onDone }: CaptureMaintenanceDialogProps) {
  const { t } = useTranslation()
  const [days, setDays] = useState('7')
  const [path, setPath] = useState('~/Downloads')
  const [filename, setFilename] = useState(defaultBackupName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 每次打开时重置表单
  useEffect(() => {
    if (open) {
      setDays('7')
      setPath('~/Downloads')
      setFilename(defaultBackupName())
      setError(null)
      setBusy(false)
    }
  }, [open, mode])

  const daysNum = Number(days)
  const daysValid = Number.isFinite(daysNum) && daysNum >= 0

  const submit = async () => {
    if (!daysValid) {
      setError(t('admin.capture.maintDaysInvalid'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      const endpoint = mode === 'cleanup' ? '/admin/debug/captures/cleanup' : '/admin/debug/captures/backup'
      const body = mode === 'cleanup' ? { days: daysNum } : { days: daysNum, path: path.trim(), filename: filename.trim() }
      const res = await adminFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json()) as { success?: boolean; error?: string; data?: { removed?: number; loops?: number; messages?: number; file?: string | null } }
      if (!res.ok || !data.success) throw new Error(data.error || `HTTP ${res.status}`)
      if (mode === 'cleanup') {
        onDone(t('admin.capture.cleanupDone', { count: data.data?.removed ?? 0 }))
      } else if (data.data?.file) {
        onDone(t('admin.capture.backupDone', {
          loops: data.data.loops ?? 0,
          messages: data.data.messages ?? 0,
          file: data.data.file,
        }))
      } else {
        onDone(t('admin.capture.backupEmpty'))
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:w-460">
        <DialogHeader>
          <DialogTitle>
            {mode === 'cleanup' ? t('admin.capture.maintCleanup') : t('admin.capture.maintBackup')}
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <p className="text-[12px] text-muted-foreground">
            {mode === 'cleanup' ? t('admin.capture.maintCleanupHint') : t('admin.capture.maintBackupHint')}
          </p>

          <label className="flex flex-col gap-1">
            <span className="text-[11.5px] text-muted-foreground">{t('admin.capture.maintDaysLabel')}</span>
            <Input
              value={days}
              onChange={(e) => setDays(e.target.value)}
              inputMode="decimal"
              placeholder="7"
            />
          </label>

          {mode === 'backup' && (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] text-muted-foreground">{t('admin.capture.backupPathLabel')}</span>
                <Input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="~/Downloads"
                  className="font-mono"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11.5px] text-muted-foreground">{t('admin.capture.backupNameLabel')}</span>
                <Input
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  placeholder="llm-proxy-captures-YYYYMMDD-HHmmss.zip"
                  className="font-mono"
                />
              </label>
            </>
          )}

          {error && <p className="text-[12px] text-error-emphasis">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
            {t('admin.common.cancel')}
          </Button>
          <Button variant="primary" size="sm" disabled={busy || !daysValid} onClick={() => void submit()}>
            {busy ? t('admin.capture.maintWorking') : t('admin.common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
