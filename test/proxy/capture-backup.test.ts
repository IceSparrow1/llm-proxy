import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildLoopJsonlLines, writeBackupZip } from '../../src/proxy/capture-backup.js'
import type { CaptureEntry } from '../../src/proxy/capture.js'

const NOW = 1_700_000_000_000

function loopEntry(pairId: number, overrides: Partial<CaptureEntry> = {}): CaptureEntry {
  return {
    id: pairId,
    timestamp: NOW,
    durationMs: 120,
    source: 'proxy',
    protocol: 'openai',
    model: 'gpt-x',
    pairId,
    requestIn: JSON.stringify({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '问题' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"p":"a.ts"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: '内容' },
        { role: 'user', content: '追问' },
      ],
    }),
    requestOut: '{"out":true}',
    responseOut: '{"reply":"答"}',
    loop: {
      loopId: pairId,
      uid: '11111111-2222-3333-4444-555555555555',
      turn: 3,
      startedAt: NOW - 60_000,
      turnTimes: [NOW - 60_000, NOW - 30_000, NOW],
      messageTimes: [NOW - 60_000, NOW - 60_000, NOW - 30_000, NOW - 30_000, NOW],
      lastReplyAt: NOW + 120,
    },
    ...overrides,
  }
}

describe('proxy/capture-backup', () => {
  it('buildLoopJsonlLines：meta + 逐消息行（含轮次归属）+ 原始报文行', () => {
    const { lines, messages } = buildLoopJsonlLines(loopEntry(1))
    const parsed = lines.map((l) => JSON.parse(l))
    assert.strictEqual(messages, 5)
    assert.strictEqual(parsed[0].type, 'meta')
    assert.strictEqual(parsed[0].uid, '11111111-2222-3333-4444-555555555555')
    assert.strictEqual(parsed[0].turnCount, 3)
    assert.strictEqual(parsed[0].lastReplyAt, NOW + 120)

    // 消息行：下标对齐 messageTimes，按 turnTimes 推导轮次
    const msgs = parsed.filter((p) => p.type === 'message')
    assert.strictEqual(msgs.length, 5)
    assert.deepStrictEqual(msgs.map((m) => m.turn), [1, 1, 2, 2, 3])
    assert.strictEqual(msgs[2].kind, 'tool-call')
    assert.strictEqual(msgs[2].toolName, 'read_file')
    assert.strictEqual(msgs[3].toolCallId, 'c1')

    // 原始报文行
    const caps = parsed.filter((p) => p.type === 'capture')
    assert.deepStrictEqual(caps.map((c) => c.phase), ['requestIn', 'requestOut', 'responseOut'])
    assert.strictEqual(JSON.parse(caps[1].data).out, true)
  })

  it('无 loop 的 standalone 条目也能导出（uid 为 null）', () => {
    const entry = loopEntry(2)
    delete (entry as { loop?: unknown }).loop
    const { lines } = buildLoopJsonlLines(entry)
    const meta = JSON.parse(lines[0])
    assert.strictEqual(meta.uid, null)
    assert.ok(meta.turnCount >= 1)
  })

  it('writeBackupZip：按 loop 分组写 JSONL 并压缩', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'capture-backup-out-'))
    try {
      const second = loopEntry(2)
      second.loop!.uid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      const result = writeBackupZip(
        [loopEntry(1), second],
        outDir,
        'bad:name*.zip',
      )
      assert.match(result.file, /bad-name-\.zip$/, '非法字符替换 + 绝对路径')
      assert.ok(existsSync(result.file))
      assert.strictEqual(result.loops, 2)
      assert.strictEqual(result.messages, 10)
      // zip 里应有两个 jsonl（用系统 unzip 校验清单）
      const listing = execFileSync('unzip', ['-l', result.file], { encoding: 'utf-8' })
      assert.match(listing, /11111111-2222-3333-4444-555555555555\.jsonl/)
      assert.match(listing, /aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\.jsonl/)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('writeBackupZip：自动补 .zip 后缀；目录不存在时自动创建', () => {
    const base = mkdtempSync(join(tmpdir(), 'capture-backup-mkdir-'))
    const outDir = join(base, '深/层/目录')
    try {
      const result = writeBackupZip([loopEntry(1)], outDir, 'no-suffix')
      assert.match(result.file, /no-suffix\.zip$/)
      assert.ok(existsSync(result.file))
      // 清理辅助断言目录
      assert.ok(readdirSync(join(base, '深/层')).includes('目录'))
      assert.ok(readFileSync(result.file).length > 0)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
