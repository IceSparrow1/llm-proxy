import { useTranslation } from 'react-i18next'
import JsonEditorPane from './JsonEditorPane'
import CopyButton from './CopyButton'
import { PHASES, fmtSize, type CaptureEntry } from '../lib/capture'

/**
 * 代理视图 — 现有四阶段详情卡片（客户端→代理 / 代理→上游 / 上游→代理 / 代理→客户端），
 * 自页面底部区块迁移进抽屉，卡片结构与旧版一致，纵向单列排布。
 */
export default function CaptureProxyView({ entry }: { entry: CaptureEntry }) {
  const { t } = useTranslation()

  return (
    <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-2">
      {PHASES.map((p) => (
        <div
          key={p.key}
          className="overflow-hidden rounded-md border border-border bg-background-subtle"
        >
          <div className="flex items-center gap-2 border-b border-border bg-background px-3 py-2">
            <span className={'text-[12px] font-semibold ' + p.cls}>{p.label}</span>
            <span className="font-mono text-[10px] text-muted-foreground">
              {fmtSize(entry[p.key])}
            </span>
            <CopyButton
              text={entry[p.key]}
              label={t('admin.capture.copyRaw')}
              className="ms-auto"
            />
          </div>
          <div className="max-h-100 overflow-auto">
            <JsonEditorPane data={entry[p.key]} isStream={p.isStream} />
          </div>
        </div>
      ))}
    </div>
  )
}
