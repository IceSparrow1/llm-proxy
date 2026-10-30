import { useEffect, useRef, useState } from 'react'
import { Check, ClipboardCopy } from '@appica/icons-react'

/**
 * 复制按钮 — 复制成功后图标变绿色对勾 1.5s（对齐 dsh InspectorCopyButton 反馈）。
 * text 为 null 时禁用。
 */
export default function CopyButton({
  text,
  label,
  className = '',
}: {
  text: string | null
  label: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    [],
  )

  const copy = () => {
    if (text == null) return
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(false), 1500)
      })
      .catch((err) => {
        console.warn('[capture] 复制失败', err)
      })
  }

  return (
    <button
      type="button"
      onClick={copy}
      disabled={text == null}
      aria-label={label}
      title={label}
      className={
        'cursor-pointer transition-colors disabled:cursor-default disabled:opacity-40 ' +
        (copied
          ? 'text-success-emphasis'
          : 'text-muted-foreground hover:text-foreground') +
        ' ' +
        className
      }
    >
      {copied ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />}
    </button>
  )
}
