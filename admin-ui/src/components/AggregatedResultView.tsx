import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import CopyButton from './CopyButton'
import { parseSseFrames, aggregateSseFrames } from '../lib/sse'

/**
 * 结果视图 — 把 SSE 帧聚合成一次 LLM 回复的最终样子：
 * 思考（reasoning delta 聚合）、输出文本（output_text/content delta 聚合）、
 * 工具调用（arguments 增量按 item/index 归组）、拒绝、结束状态与 Token 用量。
 * 各分区自适应内容高度，超出面板可视区域时内部滚动。
 */
export default function AggregatedResultView({ raw }: { raw: string }) {
  const { t } = useTranslation()
  const agg = useMemo(() => aggregateSseFrames(parseSseFrames(raw)), [raw])

  const empty =
    !agg.text && !agg.reasoning && !agg.refusal && agg.toolCalls.length === 0 && !agg.error
  if (empty) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="text-[12px] text-muted-foreground">{t('admin.capture.resultEmpty')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      {(agg.status || agg.finishReason) && (
        <div className="flex items-center gap-2 text-[11.5px]">
          <span className="text-muted-foreground">{t('admin.capture.sectionFinish')}</span>
          <span
            className={
              'inline-flex h-[19px] items-center rounded-sm px-1.5 text-[10px] font-semibold ' +
              (agg.status === 'failed' || agg.error
                ? 'bg-error-soft text-error-emphasis'
                : agg.status === 'incomplete'
                  ? 'bg-warning-soft text-warning-emphasis'
                  : 'bg-success-soft text-success-emphasis')
            }
          >
            {agg.status ?? agg.finishReason}
          </span>
          {agg.error && <span className="break-all text-error-emphasis">{agg.error}</span>}
        </div>
      )}

      <Section label={t('admin.capture.sectionReasoning')} content={agg.reasoning} />
      <Section label={t('admin.capture.sectionText')} content={agg.text} />
      <Section label={t('admin.capture.sectionRefusal')} content={agg.refusal} />

      {agg.toolCalls.map((tc) => {
        const pretty = prettyJson(tc.arguments) || tc.arguments
        return (
          <div key={tc.key}>
            <div className="mb-1 flex items-center gap-1">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t('admin.capture.sectionToolCalls')}
              </span>
              <span className="break-all font-mono text-[10.5px] text-primary-strong">{tc.name}</span>
              {tc.id && (
                <span className="truncate font-mono text-[9.5px] text-muted-foreground">{tc.id}</span>
              )}
              <CopyButton text={pretty} label={t('admin.capture.copyRaw')} className="ms-auto" />
            </div>
            <pre className="max-h-96 overflow-auto rounded-md border border-border bg-background-subtle p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-all text-foreground">
              {pretty || '(空)'}
            </pre>
          </div>
        )
      })}

      {agg.usage && (
        <div>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground">
            {t('admin.capture.sectionUsage')}
          </div>
          <dl className="grid grid-cols-[130px_1fr] gap-y-1 text-[11px]">
            {Object.entries(agg.usage)
              .filter(([, v]) => typeof v !== 'object')
              .map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-mono text-muted-foreground">{k}</dt>
                  <dd className="font-mono text-foreground">{String(v)}</dd>
                </div>
              ))}
          </dl>
        </div>
      )}
    </div>
  )
}

/** 安全格式化 JSON 字符串；解析失败时原样返回。 */
function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

/** 分区：标题 + 复制 + 限高滚动的内容块（内容少时贴齐内容高度）。 */
function Section({ label, content }: { label: string; content: string }) {
  if (!content) return null
  return (
    <div>
      <div className="mb-1 flex items-center gap-1">
        <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        <span className="text-[9.5px] text-muted-foreground">{content.length} chars</span>
        <CopyButton text={content} label={label} className="ms-auto" />
      </div>
      <pre className="max-h-96 overflow-auto rounded-md border border-border bg-background-subtle p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap break-all text-foreground">
        {content}
      </pre>
    </div>
  )
}
