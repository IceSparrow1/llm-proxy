import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { openSqliteDatabase, type SqliteDatabase, type SqliteStatement } from '../lib/sqlite-client.js'
import type { CaptureEntry, CaptureLoopInfo } from './capture.js'

/**
 * 抓包记录 SQLite 持久层（~/.llm-proxy/capture.db）。
 *
 * 以 pair_id 为主键 upsert：loop 内新请求接管旧条目时复用 pairId，
 * 落盘自然只保留每条 loop 的最新一轮；保留上限由 setMax 控制（默认 500 条），
 * 让抓包记录在重启后仍可用、且远超内存环形缓冲的容量。
 *
 * 同时支持 Node.js (`node:sqlite`) 和 Bun (`bun:sqlite`) 两种 runtime，
 * 与 UsageStore 一致。
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS captures (
  pair_id INTEGER PRIMARY KEY,
  id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  duration_ms INTEGER,
  source TEXT NOT NULL DEFAULT '',
  protocol TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  adapter_name TEXT,
  upstream_provider TEXT,
  upstream_protocol TEXT,
  upstream_model TEXT,
  request_in TEXT,
  request_out TEXT,
  response_in TEXT,
  response_out TEXT,
  loop_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_captures_ts ON captures(ts);
`

const UPSERT_SQL = `
INSERT INTO captures
  (pair_id, id, ts, duration_ms, source, protocol, model,
   adapter_name, upstream_provider, upstream_protocol, upstream_model,
   request_in, request_out, response_in, response_out, loop_json)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (pair_id) DO UPDATE SET
  id = excluded.id,
  ts = excluded.ts,
  duration_ms = excluded.duration_ms,
  source = excluded.source,
  protocol = excluded.protocol,
  model = excluded.model,
  adapter_name = excluded.adapter_name,
  upstream_provider = excluded.upstream_provider,
  upstream_protocol = excluded.upstream_protocol,
  upstream_model = excluded.upstream_model,
  request_in = excluded.request_in,
  request_out = excluded.request_out,
  response_in = excluded.response_in,
  response_out = excluded.response_out,
  loop_json = excluded.loop_json
`

interface CaptureRow {
  pair_id: number
  id: number
  ts: number
  duration_ms: number | null
  source: string
  protocol: string
  model: string
  adapter_name: string | null
  upstream_provider: string | null
  upstream_protocol: string | null
  upstream_model: string | null
  request_in: string | null
  request_out: string | null
  response_in: string | null
  response_out: string | null
  loop_json: string | null
}

function rowToEntry(r: CaptureRow): CaptureEntry {
  let loop: CaptureLoopInfo | undefined
  if (r.loop_json) {
    try {
      const parsed: unknown = JSON.parse(r.loop_json)
      if (parsed && typeof parsed === 'object') loop = parsed as CaptureLoopInfo
    } catch { /* 损坏的 loop_json 忽略 */ }
  }
  return {
    id: r.id,
    timestamp: r.ts,
    durationMs: r.duration_ms,
    source: r.source,
    protocol: r.protocol,
    model: r.model,
    pairId: r.pair_id,
    adapterName: r.adapter_name ?? undefined,
    upstreamProvider: r.upstream_provider ?? undefined,
    upstreamProtocol: r.upstream_protocol ?? undefined,
    upstreamModel: r.upstream_model ?? undefined,
    requestIn: r.request_in,
    requestOut: r.request_out,
    responseIn: r.response_in,
    responseOut: r.response_out,
    ...(loop ? { loop } : {}),
  }
}

export class CaptureStore {
  private db: SqliteDatabase
  private upsertStmt: SqliteStatement
  private maxEntries: number

  constructor(dbPath: string, maxEntries = 500) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries))
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = openSqliteDatabase(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    this.db.exec(SCHEMA)
    this.upsertStmt = this.db.prepare(UPSERT_SQL)
  }

  /** 更新保留上限并立即淘汰超出部分 */
  setMax(maxEntries: number): void {
    this.maxEntries = Math.max(1, Math.floor(maxEntries))
    this.prune()
  }

  /** 写入/覆盖一条抓包记录，并按上限淘汰最旧的 */
  upsert(entry: CaptureEntry): void {
    this.upsertStmt.run(
      entry.pairId,
      entry.id,
      entry.timestamp,
      entry.durationMs,
      entry.source,
      entry.protocol,
      entry.model,
      entry.adapterName ?? null,
      entry.upstreamProvider ?? null,
      entry.upstreamProtocol ?? null,
      entry.upstreamModel ?? null,
      entry.requestIn,
      entry.requestOut,
      entry.responseIn,
      entry.responseOut,
      entry.loop ? JSON.stringify(entry.loop) : null,
    )
    if (this.count() > this.maxEntries) this.prune()
  }

  /** 淘汰最旧的记录，只保留 maxEntries 条。返回删除条数。 */
  prune(): number {
    const res = this.db.prepare(`
      DELETE FROM captures WHERE pair_id NOT IN (
        SELECT pair_id FROM captures ORDER BY ts DESC, id DESC LIMIT ?
      )
    `).run(this.maxEntries)
    return Number(res.changes ?? 0)
  }

  /** 取最新的 n 条（返回按时间升序排列，旧 → 新，便于直接灌入内存缓冲） */
  latest(n: number): CaptureEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM captures ORDER BY ts DESC, id DESC LIMIT ?
    `).all(n) as unknown as CaptureRow[]
    return rows.map(rowToEntry).reverse()
  }

  /** 取早于 beforeDays 天之前的全部记录（时间升序），供备份导出 */
  olderThan(beforeDays: number, now = Date.now()): CaptureEntry[] {
    const cutoff = now - beforeDays * 86_400_000
    const rows = this.db.prepare(`
      SELECT * FROM captures WHERE ts < ? ORDER BY ts ASC, id ASC
    `).all(cutoff) as unknown as CaptureRow[]
    return rows.map(rowToEntry)
  }

  /** 删除 beforeDays 天之前的记录。返回删除条数。 */
  cleanup(beforeDays: number, now = Date.now()): number {
    const cutoff = now - beforeDays * 86_400_000
    const res = this.db.prepare('DELETE FROM captures WHERE ts < ?').run(cutoff)
    return Number(res.changes ?? 0)
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS c FROM captures').get() as { c: number }).c)
  }

  /** 清空全部抓包记录。不可恢复。 */
  clear(): void {
    this.db.prepare('DELETE FROM captures').run()
  }

  /** 关闭数据库。SIGTERM 时调用，确保 WAL flush 到主文件。 */
  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);')
      this.db.close()
    } catch { /* 关闭失败不阻塞退出 */ }
  }
}
