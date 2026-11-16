import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { CaptureEntry } from './capture.js'
import { extractConversationSteps } from './attribution.js'

/**
 * 抓包备份导出：把早于 N 天的记录按 agent-loop 分组，
 * 每个 loop 写一个 JSONL（首行 meta，逐条消息一行，末尾附最新一轮四阶段原始报文），
 * 再统一压缩成 zip。zip 使用系统 zip 命令（macOS/Linux 自带），不引入新依赖。
 */

export interface BackupResult {
  /** 生成的 zip 绝对路径 */
  file: string
  /** 导出的 loop 数（每个 loop 一个 JSONL 文件） */
  loops: number
  /** 导出的消息总条数 */
  messages: number
}

/** 单个 loop 的 JSONL 内容：首行 meta + 逐消息行 + 最新一轮原始报文行。 */
export function buildLoopJsonlLines(entry: CaptureEntry): { lines: string[]; messages: number } {
  const loop = entry.loop
  const turnTimes = loop?.turnTimes ?? [entry.timestamp]
  const turnOf = (time: number): number => {
    let turn = 1
    for (let i = 0; i < turnTimes.length; i++) {
      if (turnTimes[i] <= time) turn = i + 1
    }
    return turn
  }

  const lines: string[] = []
  lines.push(JSON.stringify({
    type: 'meta',
    uid: loop?.uid ?? null,
    loopId: loop?.loopId ?? entry.pairId,
    turn: loop?.turn ?? 1,
    turnCount: turnTimes.length,
    startedAt: loop?.startedAt ?? entry.timestamp,
    lastReplyAt: loop?.lastReplyAt ?? (entry.durationMs != null ? entry.timestamp + entry.durationMs : null),
    source: entry.source,
    protocol: entry.protocol,
    model: entry.model,
    adapterName: entry.adapterName ?? null,
    upstreamProvider: entry.upstreamProvider ?? null,
    upstreamProtocol: entry.upstreamProtocol ?? null,
    upstreamModel: entry.upstreamModel ?? null,
    turnTimes,
  }))

  let messages = 0
  try {
    const body: unknown = entry.requestIn ? JSON.parse(entry.requestIn) : null
    const steps = extractConversationSteps(body)
    const times = loop?.messageTimes ?? []
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]
      const time = times[i] ?? entry.timestamp
      messages++
      lines.push(JSON.stringify({
        type: 'message',
        index: i + 1,
        turn: turnOf(time),
        role: s.role,
        kind: s.kind,
        text: s.text,
        time,
        toolName: s.toolName ?? null,
        toolCallId: s.toolCallId ?? null,
      }))
    }
  } catch {
    // requestIn 解析失败：跳过消息行，仍保留 meta 与原始报文
  }

  const phases = [
    ['requestIn', entry.requestIn],
    ['requestOut', entry.requestOut],
    ['responseIn', entry.responseIn],
    ['responseOut', entry.responseOut],
  ] as const
  for (const [phase, data] of phases) {
    if (!data) continue
    lines.push(JSON.stringify({ type: 'capture', phase, size: data.length, data }))
  }
  return { lines, messages }
}

function expandTilde(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/**
 * 把记录分组写 JSONL 并压缩成 zip。
 * @param dir 目标目录（支持 ~，不存在时自动创建）
 * @param filename zip 文件名（仅取 basename；无 .zip 后缀时自动补）
 */
export function writeBackupZip(entries: CaptureEntry[], dir: string, filename: string): BackupResult {
  const targetDir = resolve(expandTilde(dir))
  mkdirSync(targetDir, { recursive: true })

  // 按 loop uid 分组（standalone 条目用独立分组）
  const groups = new Map<string, CaptureEntry[]>()
  for (const e of entries) {
    const key = e.loop?.uid ?? `standalone-${e.pairId}`
    const list = groups.get(key)
    if (list) list.push(e)
    else groups.set(key, [e])
  }

  const tmp = mkdtempSync(join(tmpdir(), 'llm-proxy-backup-'))
  try {
    const files: string[] = []
    let messages = 0
    for (const [key, list] of groups) {
      // 同组取时间最新的一条（持久层本就只保留每 loop 最新轮，防御性排序）
      const latest = [...list].sort((a, b) => b.timestamp - a.timestamp)[0]
      const { lines, messages: msgCount } = buildLoopJsonlLines(latest)
      messages += msgCount
      const file = join(tmp, `${key}.jsonl`)
      writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
      files.push(file)
    }

    let name = basename(filename).replace(/[\\/:*?"<>|]/g, '-').trim()
    if (!name) name = `llm-proxy-captures-${new Date().toISOString().slice(0, 10)}.zip`
    if (!name.toLowerCase().endsWith('.zip')) name += '.zip'
    const zipPath = join(targetDir, name)

    // 系统 zip（macOS/Linux 自带）；-j 丢弃路径，全部平铺到 zip 根
    const res = spawnSync('zip', ['-j', zipPath, ...files], { cwd: tmp, encoding: 'utf-8' })
    if (res.error || res.status !== 0) {
      throw new Error(`zip 压缩失败（需要系统 zip 命令）: ${res.error ? String(res.error) : res.stderr?.trim()}`)
    }
    return { file: zipPath, loops: groups.size, messages }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
